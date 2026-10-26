import assert from "node:assert/strict";
import test from "node:test";
import { protocolRequest, protocolStreamDecoder, protocolStreamPayload, v2Shell, v2ShellItems, v2Thread, v2ThreadStream } from "../../shared/t3-protocol";
import { pendingRequests, unitState } from "./derive";
import { telemetry } from "./telemetry";
import { latestPlan } from "./progress";
import type { ThreadStreamItem } from "./types";

const at = "2026-10-15T12:00:00.000Z";
const later = "2026-10-15T12:01:00.000Z";
const modelSelection = { instanceId: "codex", model: "gpt-6.1-sol" };
const thread = { id: "th", projectId: "p", title: "Compatibility", providerInstanceId: "codex", modelSelection,
  runtimeMode: "approval-required", interactionMode: "default", branch: "main", worktreePath: null,
  latestRunId: "run", activeRunId: "run", latestRunRequestedAt: at, latestRunStartedAt: at, status: "running",
  pendingRuntimeRequest: null, latestVisibleMessage: null, latestUserMessageAt: at,
  createdAt: at, updatedAt: at, activeProviderThreadId: "pt", settledAt: null, archivedAt: null };
const run = { id: "run", ordinal: 1, status: "running", requestedAt: at, startedAt: at, completedAt: null };
const item = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, threadId: "th", runId: "run", ordinal: 1, status: "running", startedAt: at, completedAt: null, updatedAt: at, ...extra });
const projection = (extra: Record<string, unknown> = {}) => ({ thread, runs: [run], messages: [], turnItems: [], runtimeRequests: [], checkpoints: [], providerThreads: [], visibleTurnItems: [], ...extra });
const detail = (items: ThreadStreamItem[]) => {
  const snapshot = items.find((i) => i.kind === "snapshot");
  assert.ok(snapshot?.kind === "snapshot");
  return snapshot.snapshot.thread;
};

test("v2 shells preserve waiting requests, work timing, failures, background tasks, and archive changes", () => {
  const shell = v2Shell({ ...thread, status: "queued", latestRunId: "queued", activeRunId: "run", activityRunStatus: "waiting", activityRunStartedAt: at,
    latestRunCompletedAt: later, pendingRuntimeRequest: { id: "ask", kind: "user_input" } });
  assert.equal(unitState(shell), "question");
  assert.equal(shell.latestTurn?.turnId, "run");
  assert.equal(shell.latestTurn?.startedAt, at);
  assert.equal(shell.latestTurn?.completedAt, null);
  assert.equal(unitState(v2Shell({ ...thread, status: "failed", activeRunId: null, lastError: "Quota exhausted" })), "error");
  assert.equal(unitState(v2Shell({ ...thread, status: "completed", activeRunId: null, pendingBackgroundTasks: [{ kind: "subagent", taskId: "child" }] })), "working");
  assert.equal(unitState(v2Shell({ ...thread, status: "completed", activeRunId: null, pendingBackgroundTasks: [{ kind: "monitor", taskId: "watch" }] })), "monitoring");
  assert.deepEqual(v2ShellItems([{ kind: "thread.updated", location: "archive", sequence: 8, thread }]), [{ kind: "thread-removed", sequence: 8, threadId: "th" }]);
  assert.deepEqual(v2ShellItems([{ kind: "thread.removed", location: "archive", sequence: 9, threadId: "th" }]), []);
});

test("v2 timeline preserves textless images, reasoning, tool activity, plans, context, and checkpoint ordinals", () => {
  const attachment = { id: "image", type: "image", name: "image.png", mimeType: "image/png", sizeBytes: 10 };
  const p = projection({ turnItems: [
    item("m", "assistant_message", { messageId: "m", text: "", attachments: [attachment], streaming: false }),
    item("reason", "reasoning", { text: "Thinking", streaming: true }),
    item("tool", "command_execution", { input: "npm test", title: "Run tests" }),
    item("plan", "todo_list", { steps: [{ text: "Inspect", status: "completed" }, { text: "Fix", status: "running" }] }),
  ], providerThreads: [{ id: "pt", contextUsage: { usedTokens: 20, maxTokens: 100 }, updatedAt: later }],
  checkpoints: [{ id: "cp", runId: "run", appRunOrdinal: 3, ordinalWithinScope: 99, status: "ready", files: [], capturedAt: later }] });
  const t = v2Thread(p);
  assert.deepEqual(t.messages.find((m) => m.id === "m")?.attachments, [attachment]);
  assert.equal(t.messages.find((m) => m.id === "reason")?.role, "reasoning");
  assert.equal(telemetry(t).workstation, "terminal");
  assert.equal(telemetry(t).context, 0.2);
  assert.equal(latestPlan(t)?.steps[1].status, "inProgress");
  assert.equal(t.checkpoints[0].checkpointTurnCount, 3);
});

test("v2 request resolution removes answered questions and preserves provider approval options", () => {
  const options = [{ id: "accept", label: "Allow" }];
  const p = projection({ turnItems: [item("q", "user_input_request", { requestId: "q", questions: [{ id: "route", question: "Where?", options: [] }] }),
    item("a", "approval_request", { requestId: "a", options, prompt: "Run command?" })],
  runtimeRequests: [{ id: "q", kind: "user_input", status: "resolved", resolvedAt: later, answers: { route: "Core" } }, { id: "a", kind: "command", status: "pending" }] });
  const requests = pendingRequests(v2Thread(p));
  assert.deepEqual(requests.map((r) => r.requestId), ["a"]);
  assert.deepEqual(requests[0].activity.payload?.options, options);
});

test("v2 live events replace accumulated text, deduplicate replay, and close tools and questions", () => {
  const decode = v2ThreadStream();
  decode([{ kind: "snapshot", snapshotSequence: 1, projection: projection({ turnItems: [item("m", "assistant_message", { messageId: "m", text: "Hel", streaming: true }), item("tool", "command_execution", { input: "npm test" })] }) }, { kind: "synchronized" }]);
  const event = (sequence: number, type: string, payload: unknown) => ({ kind: "event", sequence, event: { type, payload, occurredAt: later } });
  const t = detail(decode([
    event(2, "turn-item.updated", item("m", "assistant_message", { messageId: "m", text: "Hello", streaming: false, updatedAt: later })),
    event(2, "turn-item.updated", item("m", "assistant_message", { messageId: "m", text: "duplicated" })),
    event(3, "turn-item.updated", item("tool", "command_execution", { input: "npm test", status: "completed", completedAt: later })),
    event(4, "runtime-request.updated", { id: "q", kind: "user_input", status: "pending" }),
    event(5, "turn-item.updated", item("q", "user_input_request", { requestId: "q", questions: [] })),
    event(6, "runtime-request.updated", { id: "q", kind: "user_input", status: "resolved", resolvedAt: later }),
    event(7, "new-event.future", {}),
  ]));
  assert.equal(t.messages.find((m) => m.id === "m")?.text, "Hello");
  assert.equal(telemetry(t).doing, undefined);
  assert.equal(pendingRequests(t).length, 0);
});

test("rolled-back runs disappear from the transcript and checkpoint list", () => {
  const t = v2Thread(projection({ runs: [{ ...run, status: "rolled_back" }], messages: [{ id: "m", runId: "run", role: "user", text: "drop" }],
    turnItems: [item("m", "assistant_message", { messageId: "m", text: "drop" })], checkpoints: [{ runId: "run", appRunOrdinal: 1 }] }));
  assert.deepEqual(t.messages, []);
  assert.deepEqual(t.checkpoints, []);
  assert.equal(t.latestTurn, null);
});

test("v2 thread streams resume HTTP snapshots and opt into bounded fallbacks while v1 passes through", () => {
  const payload = { threadId: "th", afterSequence: 99, turnLimit: 6, reasoningMessages: true, requestCompletionMarker: true };
  assert.deepEqual(protocolStreamPayload(2, "orchestration.subscribeThread", payload), { threadId: "th", requestCompletionMarker: true, afterSequence: 99, acceptBoundedSnapshot: true, acceptCompactTurnItems: true });
  assert.equal(protocolStreamPayload(1, "orchestration.subscribeThread", payload), payload);
  assert.deepEqual(protocolStreamDecoder(1, "orchestration.subscribeThread")([payload]), [payload]);
});

const harness = (reply: unknown = { sequence: 1 }) => {
  const calls: Array<{ tag: string; payload: Record<string, unknown> }> = [];
  return { calls, request: async (tag: string, payload: unknown) => { calls.push({ tag, payload: payload as Record<string, unknown> }); return reply; } };
};
const command = { commandId: "cmd", threadId: "th", createdAt: at };

test("v2 approvals and questions keep original IDs and structured answers; v1 passes through", async () => {
  const h = harness();
  const payload = { ...command, type: "thread.user-input.respond", requestId: "q", answers: { route: "Core", kits: "Repair, Mining" } };
  await protocolRequest(2, "orchestration.dispatchCommand", payload, h.request);
  assert.deepEqual(h.calls[0].payload, { commandId: "cmd", threadId: "th", type: "runtime-request.respond", requestId: "q", answers: payload.answers });
  await protocolRequest(2, "orchestration.dispatchCommand", { ...command, type: "thread.approval.respond", requestId: "a", decision: "acceptForSession" }, h.request);
  assert.equal(h.calls[1].payload.decision, "acceptForSession");
  await protocolRequest(1, "orchestration.dispatchCommand", payload, h.request);
  assert.equal(h.calls[2].payload, payload);
});

test("v2 orders set thread modes then dispatch a message, leaving busy-delivery policy to T3", async () => {
  const h = harness();
  await protocolRequest(2, "orchestration.dispatchCommand", { ...command, type: "thread.turn.start", modelSelection, runtimeMode: "approval-required", interactionMode: "plan",
    message: { messageId: "m", text: "Continue", attachments: [] } }, h.request);
  assert.deepEqual(h.calls.map((c) => c.payload.type), ["thread.runtime-mode.set", "thread.interaction-mode.set", "message.dispatch"]);
  assert.deepEqual(h.calls[2].payload, { type: "message.dispatch", commandId: "cmd", threadId: "th", messageId: "m", text: "Continue", attachments: [], modelSelection,
    createdBy: "user", creationSource: "web", deliveryIntent: "auto", dispatchMode: { type: "start_immediately" } });
  assert.equal(new Set(h.calls.map((c) => c.payload.commandId)).size, 3);
});

test("v2 recruitment uses native launches for root, existing, and prepared worktrees", async () => {
  for (const [workspace, expected] of [
    [{}, { type: "root", branch: "main" }],
    [{ worktreePath: "/repo/wt" }, { type: "existing_worktree", worktreePath: "/repo/wt", branch: "main" }],
    [{ prepareWorktree: { baseBranch: "main", branch: "new", startFromOrigin: false } }, { type: "worktree", baseRef: "main", branch: "new", startFromOrigin: false }],
  ] as const) {
    const h = harness();
    await protocolRequest(2, "orchestration.dispatchCommand", { ...command, type: "thread.turn.start", modelSelection, runtimeMode: "approval-required", interactionMode: "default",
      message: { messageId: "m", text: "Work", attachments: [] }, bootstrap: { createThread: { projectId: "p", title: "Work", branch: "main", ...workspace }, ...workspace } }, h.request);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].tag, "orchestration.launchThread");
    assert.deepEqual(h.calls[0].payload.workspaceStrategy, expected);
  }
});

test("v2 rollback resolves the checkpoint's scope; interrupt uses app run IDs and holds the queue", async () => {
  const h = harness(projection({ checkpoints: [{ id: "cp", scopeId: "scope", appRunOrdinal: 3, status: "ready" }] }));
  await protocolRequest(2, "orchestration.dispatchCommand", { ...command, type: "thread.checkpoint.revert", turnCount: 3 }, h.request);
  assert.deepEqual(h.calls[1].payload, { commandId: "cmd", type: "checkpoint.rollback", threadId: "th", checkpointId: "cp", scopeId: "scope", restoreFiles: true });
  await protocolRequest(2, "orchestration.dispatchCommand", { ...command, type: "thread.turn.interrupt", turnId: "run" }, h.request);
  assert.deepEqual(h.calls.at(-1)?.payload, { commandId: "cmd", type: "run.interrupt", threadId: "th", runId: "run", holdQueue: true });
  await assert.rejects(protocolRequest(2, "orchestration.dispatchCommand", { ...command, type: "thread.checkpoint.revert", turnCount: 99 }, h.request), /unavailable/);
});

test("v2 project mutations use the project service", async () => {
  const h = harness();
  await protocolRequest(2, "orchestration.dispatchCommand", { ...command, type: "project.create", projectId: "p", title: "Repo", workspaceRoot: "/repo" }, h.request);
  assert.equal(h.calls[0].tag, "projects.mutate");
  assert.equal(h.calls[0].payload.createdAt, undefined);
});
