import assert from "node:assert/strict";
import test from "node:test";
import { EnvironmentClient } from "./environment";
import type { EnvSummary } from "../../shared/api";

test("settled v2 crew with leftover background shells leave on duty for cryo and wake for new work", async () => {
  const { useGame } = await import("../store");
  const { v2ShellItems } = await import("../../shared/t3-protocol");
  const { unitState } = await import("./derive");
  const { fleetCounts } = await import("../ui/util");
  const { computeFleetLayout } = await import("../game/layout");
  const before = useGame.getState();
  const summary = { id: "camp-env", label: "Station", protocolVersion: 2 } as EnvSummary;
  const client = new EnvironmentClient(summary);
  const apply = (values: unknown[]) => (client as unknown as { applyShell(items: unknown[]): void }).applyShell(v2ShellItems(values));
  const shell = { id: "crew", projectId: "p", title: "Wrap and close", latestRunId: "run", activeRunId: null,
    status: "completed", activityRunStatus: null, latestRunCompletedAt: "2026-10-19T07:53:12.365Z",
    latestUserMessageAt: "2026-10-19", createdAt: "2026-10-19", updatedAt: "2026-10-19T07:53:12.365Z",
    pendingBackgroundTasks: [{ kind: "background_shell", taskId: "old-command" }], pendingRuntimeRequest: null,
    settledAt: null, unsettledAt: "2026-10-19T07:53:03.616Z" };
  const state = () => useGame.getState();
  const crew = () => state().envs[summary.id].threads.crew;
  const place = () => computeFleetLayout(state()).crew.get(`${summary.id}:crew`)!;
  try {
    useGame.setState({ envs: { [summary.id]: { summary, connection: "live", synced: false, projects: {}, threads: {}, providers: [] } }, details: {}, memory: {} });
    apply([{ kind: "snapshot", snapshot: { snapshotSequence: 1, projects: [{ id: "p", title: "Project", workspaceRoot: "/project" }], threads: [shell] } }, { kind: "synchronized" }]);
    assert.equal(unitState(crew()), "monitoring");
    const settled = { ...shell, settledAt: "2026-10-19T07:53:12.659Z", unsettledAt: null };
    apply([{ kind: "thread.updated", sequence: 2, location: "active", thread: settled }]);
    assert.equal(unitState(crew()), "sleeping");
    assert.equal(fleetCounts(state().envs).awake, 0, "settlement removes the crew member from on duty");
    assert.equal(fleetCounts(state().envs).monitoring, 0);
    assert.equal(place().homeRoom, "quarters");
    assert.equal(place().sleeping, true);
    // A reconnect must agree with the live settlement event.
    apply([{ kind: "snapshot", snapshot: { snapshotSequence: 3, projects: Object.values(state().envs[summary.id].projects), threads: [settled] } }]);
    assert.equal(unitState(crew()), "sleeping");
    for (const [sequence, changes, expected] of [
      [4, { pendingRuntimeRequest: { id: "approval", kind: "tool_approval" } }, "alert"],
      [5, { pendingRuntimeRequest: { id: "question", kind: "user_input" } }, "question"],
      [6, { status: "running", activityRunStatus: "running", activeRunId: "next-run" }, "working"],
      [7, { pendingBackgroundTasks: [{ kind: "subagent", taskId: "active-child" }] }, "working"],
      [8, { unsettledAt: "2026-10-19T07:54:00Z" }, "monitoring"],
    ] as const) {
      apply([{ kind: "thread.updated", sequence, location: "active", thread: { ...settled, ...changes } }]);
      assert.equal(unitState(crew()), expected);
    }
  } finally { useGame.setState(before, true); }
});

test("question responses dispatch against the original request without starting an unrelated turn", async () => {
  const client = new EnvironmentClient({ id: "env", label: "Station" } as EnvSummary);
  const calls: Array<{ tag: string; payload: Record<string, unknown> }> = [];
  Object.defineProperty(client, "rpc", { value: { isOpen: true,
    request: async (tag: string, payload: Record<string, unknown>) => { calls.push({ tag, payload }); return { sequence: 42 }; },
  } });
  await client.respondToQuestion("thread", "request", { route: "Core", kits: "Repair, Mining" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tag, "orchestration.dispatchCommand");
  assert.equal(calls[0].payload.type, "thread.user-input.respond");
  assert.equal(calls[0].payload.threadId, "thread");
  assert.equal(calls[0].payload.requestId, "request");
  assert.deepEqual(calls[0].payload.answers, { route: "Core", kits: "Repair, Mining" });
  assert.equal(typeof calls[0].payload.commandId, "string");
  assert.ok(Number.isFinite(Date.parse(String(calls[0].payload.createdAt))));
});

test("disconnected question submissions reject so the form can retain answers and retry", async () => {
  const client = new EnvironmentClient({ id: "env", label: "Station" } as EnvSummary);
  await assert.rejects(client.respondToQuestion("thread", "request", { route: "Core" }), /not connected/);
});

test('permission changes dispatch without starting a new turn', async () => {
  const client = new EnvironmentClient({ id: 'env', label: 'Hermes', kind: 'hermes' } as EnvSummary);
  const calls: Array<{ tag: string; payload: Record<string, unknown> }> = [];
  Object.defineProperty(client, 'rpc', { value: { isOpen: true,
    request: async (tag: string, payload: Record<string, unknown>) => { calls.push({ tag, payload }); return { sequence: 42 }; },
  } });
  await client.setRuntimeMode('chat', 'auto-accept-edits');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tag, 'orchestration.dispatchCommand');
  assert.equal(calls[0].payload.type, 'thread.runtime-mode.set');
  assert.equal(calls[0].payload.threadId, 'chat');
  assert.equal(calls[0].payload.runtimeMode, 'auto-accept-edits');
  assert.equal(calls[0].payload.message, undefined);
  assert.equal(typeof calls[0].payload.commandId, 'string');
});

test("v2 repository refreshes preserve inactive project nodes, crew, and the live event cursor", async () => {
  const { useGame } = await import("../store");
  const { v2ShellItems } = await import("../../shared/t3-protocol");
  const { computeFleetLayout } = await import("../game/layout");
  const before = useGame.getState();
  const summary = { id: "env", label: "Station", addedAt: "2026-10-15", protocolVersion: 2 } as EnvSummary;
  const client = new EnvironmentClient(summary);
  const apply = (values: unknown[]) => (client as unknown as { applyShell(items: unknown[]): void }).applyShell(v2ShellItems(values));
  const project = (id: string) => ({ id, title: id, workspaceRoot: `/repos/${id}`, defaultModelSelection: null, createdAt: "2026-10-15", updatedAt: "2026-10-15" });
  const a = project("alpha"), b = project("beta");
  const thread = (id: string) => ({ id, projectId: id === "one" ? "alpha" : "beta", title: id, modelSelection: { instanceId: "codex", model: "sol" },
    runtimeMode: "approval-required", interactionMode: "default", status: "completed", latestRunId: `run-${id}`, activeRunId: null,
    latestUserMessageAt: "2026-10-15", createdAt: "2026-10-15", updatedAt: "2026-10-15", settledAt: "2026-10-15", pendingRuntimeRequest: null });
  try {
    useGame.setState({ envs: { env: { summary, connection: "live", synced: false, projects: {}, threads: {}, providers: [] } }, memory: {} });
    apply([{ kind: "snapshot", snapshot: { snapshotSequence: 10, projects: [a, b], threads: [thread("one"), thread("two")] } }, { kind: "synchronized" }]);
    const threads = useGame.getState().envs.env.threads;
    apply([{ kind: "snapshot", snapshot: { snapshotSequence: 1000, projects: [{ ...a, title: "stale title", repositoryIdentity: { canonicalKey: "github.com/test/alpha", name: "alpha" } }], threads: [] },
      resolvedRepositoryIdentityRoots: [a.workspaceRoot] }]);
    let world = useGame.getState().envs.env;
    assert.deepEqual(Object.keys(world.projects), ["alpha", "beta"]);
    assert.equal(world.projects.alpha.title, "alpha", "metadata cannot undo newer project edits");
    assert.equal(world.projects.alpha.repositoryIdentity?.canonicalKey, "github.com/test/alpha");
    assert.equal(world.threads, threads);
    assert.equal(world.synced, true);
    const layout = computeFleetLayout(useGame.getState());
    assert.equal(layout.stations.size, 2, "inactive project modules stay on the map");
    assert.equal(layout.crew.size, 2, "settled crew stay in their quarters");
    // Metadata can arrive ahead of the live tail; its sequence must not skip tail events.
    apply([{ kind: "thread.updated", location: "active", sequence: 11, thread: { ...thread("one"), title: "fresh thread" } }]);
    assert.equal(useGame.getState().envs.env.threads.one.title, "fresh thread");
    apply([{ kind: "project.removed", sequence: 12, projectId: "beta" }]);
    apply([{ kind: "snapshot", snapshot: { snapshotSequence: 1001, projects: [{ ...b, repositoryIdentity: { canonicalKey: "github.com/test/beta" } }], threads: [] }, resolvedRepositoryIdentityRoots: [b.workspaceRoot] }]);
    assert.equal(useGame.getState().envs.env.projects.beta, undefined, "late enrichment cannot resurrect a deleted project");
    // An unmarked reconnect snapshot is still authoritative, even if it is empty.
    apply([{ kind: "snapshot", snapshot: { snapshotSequence: 20, projects: [], threads: [] } }]);
    world = useGame.getState().envs.env;
    assert.deepEqual(world.projects, {});
    assert.deepEqual(world.threads, {});
  } finally { useGame.setState(before, true); }
});

test("native siblings share lifecycle-only tracking without loading their parent's transcript", async () => {
  const { useGame, unitKey } = await import("../store");
  const { v2ShellItems } = await import("../../shared/t3-protocol");
  const { unitState } = await import("./derive");
  const before = useGame.getState(), originalFetch = globalThis.fetch;
  const summary = { id: "native-env", label: "Station", protocolVersion: 2 } as EnvSummary;
  const client = new EnvironmentClient(summary);
  const streams: Array<{ payload: Record<string, unknown>; emit: (items: unknown[]) => void; cancelled: boolean }> = [];
  const requests: string[] = [], calls: Record<string, unknown>[] = [];
  let status = "running";
  const agent = () => ({ id: "agent", threadId: "parent", childThreadId: "child", origin: "provider_native", runId: "owner-run", status, updatedAt: "2026-10-15T12:00:00Z" });
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ snapshotSequence: 42, projection: { thread: { id: "parent" }, subagents: [agent()] } }));
  };
  Object.defineProperty(client, "rpc", { value: { isOpen: true,
    rawStream: (_tag: string, payload: Record<string, unknown>, emit: (items: unknown[]) => void) => {
      const stream = { payload, emit, cancelled: false }; streams.push(stream);
      return () => { stream.cancelled = true; };
    },
    request: async (_tag: string, payload: Record<string, unknown>) => { calls.push(payload); return {}; },
  } });
  const internal = client as unknown as { applyShell(items: unknown[]): void; nativeParents: Map<string, { cancel?: () => void }>; subscribeNativeParent(id: string, sub: unknown): void };
  const apply = (values: unknown[]) => internal.applyShell(v2ShellItems(values));
  const shell = (id: string, parent = false) => ({ id, projectId: "p", title: id, creationSource: parent ? "web" : "provider",
    lineage: { parentThreadId: parent ? null : "parent", relationshipToParent: parent ? null : "subagent", rootThreadId: "parent" },
    latestRunId: null, activeRunId: null, status: "idle", createdAt: "2026-10-15", updatedAt: "2026-10-15" });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const child = () => useGame.getState().envs[summary.id].threads.child;
  try {
    useGame.setState({ envs: { [summary.id]: { summary, connection: "live", synced: false, projects: {}, threads: {}, providers: [] } }, details: {} });
    apply([{ kind: "snapshot", snapshot: { snapshotSequence: 1, projects: [], threads: [shell("parent", true), shell("child"), shell("sibling")] } }, { kind: "synchronized" }]);
    await flush();
    assert.deepEqual(requests, ["/env/native-env/threads/parent/subagents"]);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].payload.afterSequence, 42);
    assert.equal(streams[0].payload.commandSubagentsOnly, true);
    assert.equal(useGame.getState().details[unitKey(summary.id, "parent")], undefined, "background tracking stores no transcript");
    assert.equal(unitState(child()), "working");
    apply([{ kind: "thread.updated", sequence: 2, location: "active", thread: shell("child") }]);
    assert.equal(unitState(child()), "working", "shell refreshes preserve parent authority");
    await client.interrupt("child");
    assert.equal(calls[0].type, "subagent.stop");
    assert.equal(calls[0].runId, "owner-run");
    let sequence = 42;
    for (const [next, expected] of [["waiting", "working"], ["completed", "sleeping"], ["failed", "sleeping"], ["idle", "sleeping"], ["pending", "working"]]) {
      status = next;
      streams[0].emit([{ kind: "event", sequence: ++sequence, event: { type: "subagent.updated", payload: agent() } }]);
      assert.equal(unitState(child()), expected);
    }
    status = "completed";
    streams[0].emit([{ kind: "event", sequence: 41, event: { type: "subagent.updated", payload: agent() } }]);
    assert.equal(unitState(child()), "working", "old replay events cannot undo newer native status");
    internal.subscribeNativeParent("parent", internal.nativeParents.get("parent"));
    await flush();
    assert.equal(streams[0].cancelled, true);
    assert.equal(unitState(child()), "sleeping", "reconnect replaces stale native status");
    apply([{ kind: "snapshot", snapshot: { snapshotSequence: 50, projects: [], threads: [] } }]);
    assert.equal(streams.at(-1)!.cancelled, true);
  } finally {
    for (const sub of internal.nativeParents.values()) sub.cancel?.();
    globalThis.fetch = originalFetch; useGame.setState(before, true);
  }
});
