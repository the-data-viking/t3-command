import assert from "node:assert/strict";
import test from "node:test";
import { EnvironmentClient } from "./environment";
import type { EnvSummary } from "../../shared/api";

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

test("native children follow parent lifecycle streams without an open panel, across shell refreshes and reconnects", async () => {
  const { useGame, unitKey } = await import("../store");
  const { v2ShellItems, v2ThreadStream } = await import("../../shared/t3-protocol");
  const { isHistory, unitState } = await import("./derive");
  const before = useGame.getState();
  const summary = { id: "native-env", label: "Station", protocolVersion: 2 } as EnvSummary;
  const client = new EnvironmentClient(summary);
  const streams: Array<{ payload: { threadId: string }; emit: (items: unknown[]) => void; cancelled: boolean }> = [];
  const calls: Record<string, unknown>[] = [];
  Object.defineProperty(client, "rpc", { value: { isOpen: true,
    stream: (_tag: string, payload: { threadId: string }, emit: (items: unknown[]) => void) => {
      const stream = { payload, emit, cancelled: false }; streams.push(stream);
      return () => { stream.cancelled = true; };
    },
    request: async (_tag: string, payload: Record<string, unknown>) => { calls.push(payload); return {}; },
  } });
  const internals = client as unknown as { applyShell(items: unknown[]): void; subscribeThread(id: string, sub: unknown): void; threadSubs: Map<string, unknown> };
  const apply = (values: unknown[]) => internals.applyShell(v2ShellItems(values));
  const shell = (id: string, parent = false) => ({ id, projectId: "p", title: id, creationSource: parent ? "web" : "provider",
    lineage: { parentThreadId: parent ? null : "parent", relationshipToParent: parent ? null : "subagent", rootThreadId: "parent" },
    latestRunId: parent ? "run" : null, activeRunId: null, activeProviderThreadId: null, status: parent ? "completed" : "idle",
    latestUserMessageAt: null, createdAt: "2026-10-15", updatedAt: "2026-10-15" });
  const agent = { id: "agent", threadId: "parent", childThreadId: "child", origin: "provider_native", runId: "owner-run", status: "running", updatedAt: "2026-10-15T12:00:00Z" };
  const getChild = () => useGame.getState().envs[summary.id].threads.child;
  try {
    useGame.setState({ envs: { [summary.id]: { summary, connection: "live", synced: false, projects: {}, threads: {}, providers: [] } }, details: {} });
    apply([{ kind: "snapshot", snapshot: { snapshotSequence: 1, projects: [], threads: [shell("parent", true), shell("child"), shell("sibling")] } }, { kind: "synchronized" }]);
    assert.equal(streams.length, 1, "siblings share one parent subscription");
    assert.equal(streams[0].payload.threadId, "parent");
    const decode = v2ThreadStream();
    streams[0].emit(decode([{ kind: "snapshot", snapshotSequence: 1, projection: { thread: shell("parent", true), subagents: [agent] } }, { kind: "synchronized" }]));
    assert.equal(unitState(getChild()), "working");
    assert.equal(getChild().latestTurn, null, "a native task is not an app run");
    assert.equal(isHistory(getChild()), false);
    apply([{ kind: "thread.updated", sequence: 2, location: "active", thread: { ...shell("child"), title: "New tool output" } }]);
    assert.equal(unitState(getChild()), "working", "child shell output cannot overwrite the parent lifecycle");
    const closePanel = client.watchThread("parent"); closePanel();
    assert.equal(streams[0].cancelled, false, "closing a panel does not stop observing native work");
    await client.interrupt("child");
    assert.equal(calls[0].type, "subagent.stop");
    assert.equal(calls[0].threadId, "parent");
    assert.equal(calls[0].runId, "owner-run");
    assert.equal(calls[0].subagentId, "agent");
    for (const [sequence, status, expected] of [[2, "waiting", "working"], [3, "completed", "done"], [4, "failed", "error"], [5, "cancelled", "idle"], [6, "interrupted", "idle"], [7, "idle", "idle"], [8, "pending", "working"]] as const) {
      streams[0].emit(decode([{ kind: "event", sequence, event: { type: "subagent.updated", payload: { ...agent, status, updatedAt: `2026-10-15T12:00:0${sequence}Z` } } }]));
      assert.equal(unitState(getChild()), expected, status);
    }
    internals.subscribeThread("parent", internals.threadSubs.get("parent"));
    const reconnect = v2ThreadStream();
    streams.at(-1)!.emit(reconnect([{ kind: "snapshot", snapshotSequence: 20, projection: { thread: shell("parent", true), subagents: [{ ...agent, status: "completed" }] } }]));
    assert.equal(unitState(getChild()), "done", "reconnect replaces stale running state");
    apply([{ kind: "snapshot", snapshot: { snapshotSequence: 30, projects: [], threads: [] } }]);
    assert.equal(streams.at(-1)!.cancelled, true);
    assert.equal(useGame.getState().details[unitKey(summary.id, "parent")], undefined);
  } finally { useGame.setState(before, true); }
});
