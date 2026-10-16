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
