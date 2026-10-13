import assert from "node:assert/strict";
import test from "node:test";
import { compactions, latestPlan, QUIET_MS, quietness, tokenLabel, turnBreakdown } from "./progress";
import type { Activity, OrchestrationThread, ThreadShell } from "./types";

const T0 = Date.parse("2026-10-12T10:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
let seq = 0;
const act = (kind: string, min: number, payload: Record<string, unknown> = {}, turnId: string | null = "t2"): Activity =>
  ({ id: `a${++seq}`, tone: "info", kind, summary: kind, payload, turnId, createdAt: at(min) });

const thread = (activities: Activity[], latestTurn: Partial<NonNullable<OrchestrationThread["latestTurn"]>> = {}, messages: OrchestrationThread["messages"] = []) => ({
  id: "th", activities, messages, checkpoints: [],
  latestTurn: { turnId: "t2", state: "running", requestedAt: at(0), startedAt: at(0), completedAt: null, assistantMessageId: null, ...latestTurn },
}) as unknown as OrchestrationThread;
const shell = (over: Partial<ThreadShell> = {}) => ({ hasPendingApprovals: false, hasPendingUserInput: false, ...over }) as ThreadShell;

test("the latest plan is read with statuses, and marked current only for the running turn", () => {
  const plan = latestPlan(thread([
    act("turn.plan.updated", 1, { plan: [{ step: "old", status: "pending" }] }, "t1"),
    act("turn.plan.updated", 2, { explanation: "Claude Tasks", plan: [{ step: "Read code", status: "completed" }, { step: " Write tests ", status: "inProgress" }, { step: "Ship", status: "weird" }, { step: "" }] }),
  ]))!;
  assert.deepEqual(plan.steps, [{ step: "Read code", status: "completed" }, { step: "Write tests", status: "inProgress" }, { step: "Ship", status: "pending" }]);
  assert.equal(plan.completed, 1);
  assert.equal(plan.current, true);
  assert.equal(plan.explanation, "Claude Tasks");
  assert.equal(latestPlan(thread([act("turn.plan.updated", 2, { plan: [{ step: "x", status: "completed" }] })], { state: "completed", completedAt: at(5) }))!.current, false);
  assert.equal(latestPlan(thread([])), undefined);
});

test("waiting on you is split out of a turn, overlapping waits counting once", () => {
  const b = turnBreakdown(thread([
    act("approval.requested", 2, { requestId: "r1" }),
    act("user-input.requested", 3, { requestId: "r2" }),
    act("approval.resolved", 5, { requestId: "r1" }),
    act("user-input.resolved", 6, { requestId: "r2" }),
    act("approval.requested", 8, { requestId: "r3" }), // still open
  ]), T0 + 10 * 60_000)!;
  assert.equal(b.totalMs, 10 * 60_000);
  assert.equal(b.waitingMs, (4 + 2) * 60_000);
  assert.equal(b.agentMs, 4 * 60_000);
});

test("turn tokens: Claude reports per turn, Codex reports a thread total that is differenced", () => {
  const claude = thread([
    act("context-window.updated", 1, { usedTokens: 10, totalProcessedTokens: 20_000_000 }, "t1"),
    act("context-window.updated", 4, { usedTokens: 12, totalProcessedTokens: 2_600_000 }),
  ]);
  assert.equal(turnBreakdown(claude, T0 + 5 * 60_000)!.tokens, 2_600_000);
  const codex = thread([
    act("context-window.updated", 1, { usedTokens: 10, lastUsedTokens: 10, totalProcessedTokens: 500_000 }, "t1"),
    act("context-window.updated", 3, { usedTokens: 12, lastUsedTokens: 2, totalProcessedTokens: 640_000 }),
    act("context-window.updated", 4, { usedTokens: 15, lastUsedTokens: 3, totalProcessedTokens: 700_000 }),
  ]);
  assert.equal(turnBreakdown(codex, T0 + 5 * 60_000)!.tokens, 200_000);
  assert.equal(turnBreakdown(thread([]), T0)!.tokens, undefined);
});

test("compactions are counted with the latest before/after", () => {
  const c = compactions(thread([
    act("context-compaction", 1, { state: "compacting" }),
    act("context-compaction", 2, { state: "compacted", beforeTokens: 196_915, afterTokens: 14_703 }),
  ]));
  assert.deepEqual(c, { count: 1, last: { beforeTokens: 196_915, afterTokens: 14_703, at: at(2) } });
});

test("a running turn is quiet only after 10 minutes without news, and never while waiting on you", () => {
  const now = (min: number) => T0 + min * 60_000;
  const busy = thread([act("tool.started", 1, { toolCallId: "x" }), act("tool.completed", 2, { toolCallId: "x" })]);
  assert.equal(quietness(shell(), busy, now(11)), undefined);
  assert.deepEqual(quietness(shell(), busy, now(13)), { kind: "quiet", ms: 11 * 60_000 });
  assert.equal(quietness(shell({ hasPendingApprovals: true }), busy, now(30)), undefined);
  assert.equal(quietness(shell(), thread(busy.activities, { state: "completed", completedAt: at(3) }), now(30)), undefined);
  // A streaming message counts as news.
  const streaming = thread(busy.activities, {}, [{ id: "m", role: "assistant", text: "", turnId: "t2", streaming: true, createdAt: at(2), updatedAt: at(12) }]);
  assert.equal(quietness(shell(), streaming, now(13)), undefined);
  assert.ok(QUIET_MS === 10 * 60_000);
});

test("a long-open tool call or background tasks are reported as such, not as a stuck agent", () => {
  const tool = thread([act("tool.started", 1, { toolCallId: "x", detail: "npm test\n--watch" })]);
  assert.deepEqual(quietness(shell(), tool, T0 + 15 * 60_000), { kind: "tool", ms: 14 * 60_000, doing: "npm test" });
  const tasks = thread([act("task.started", 1, { taskId: "k" })]);
  assert.deepEqual(quietness(shell(), tasks, T0 + 15 * 60_000), { kind: "tasks", ms: 14 * 60_000, tasks: 1 });
});

test("token labels stay short", () => {
  assert.deepEqual([940, 12_400, 3_400_000, 20_171_499].map(tokenLabel), ["940", "12k", "3.4M", "20M"]);
});

test("a nearly full context warns, saying what happens next", async () => {
  const { contextWarning } = await import("./progress");
  assert.equal(contextWarning(0.85, true), undefined);
  assert.match(contextWarning(0.95, true)!, /^5% context left: it will compact automatically soon/);
  assert.match(contextWarning(0.97, false)!, /won't compact automatically: turns may start failing/);
  assert.match(contextWarning(0.92, undefined)!, /nearly full/);
});
