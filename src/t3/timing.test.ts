import assert from "node:assert/strict";
import test from "node:test";
import { threadTimes } from "./timing";
import type { Activity, OrchestrationThread, ThreadShell } from "./types";

const shell = { hasPendingApprovals: true, hasPendingUserInput: true, latestTurn: null } as ThreadShell;
const activity = (kind: string, requestId: string, createdAt: string): Activity => ({ id: requestId + kind, kind, createdAt, payload: { requestId }, tone: "info", summary: "", turnId: null });
const detail = (activities: Activity[]) => ({ activities } as OrchestrationThread);
const now = Date.parse("2026-10-11T12:10:00Z");

test("waiting starts at the oldest unresolved relevant request, ignoring resolved requests", () => {
  const requests = detail([
    activity("approval.requested", "resolved", "2026-10-11T11:00:00Z"),
    activity("approval.resolved", "resolved", "2026-10-11T11:01:00Z"),
    activity("user-input.requested", "question", "2026-10-11T12:08:00Z"),
    activity("approval.requested", "approval", "2026-10-11T12:03:00Z"),
    activity("user-input.requested", "invalid", "invalid"),
  ]);
  assert.equal(threadTimes(shell, requests, now).waitingMs, 7 * 60_000);
  assert.equal(threadTimes({ ...shell, hasPendingApprovals: false }, requests, now).waitingMs, 2 * 60_000);
  assert.equal(threadTimes({ ...shell, hasPendingApprovals: false, hasPendingUserInput: false }, requests, now).waitingMs, undefined);
});

test("missing original timestamps or unhydrated requests do not invent a waiting duration", () => {
  assert.equal(threadTimes(shell, undefined, now).waitingMs, undefined);
  assert.equal(threadTimes(shell, detail([activity("approval.requested", "a", "invalid")]), now).waitingMs, undefined);
});

test("completed turns stop aging even while background work continues", () => {
  const turn = { startedAt: "2026-10-11T12:00:00Z", completedAt: "2026-10-11T12:02:00Z", state: "completed" } as NonNullable<ThreadShell["latestTurn"]>;
  const thread = { ...shell, latestTurn: turn, backgroundLiveness: "working" as const };
  assert.equal(threadTimes(thread, undefined, now).turnMs, 120_000);
  assert.equal(threadTimes(thread, undefined, now + 60_000).turnMs, 120_000);
  assert.equal(threadTimes({ ...thread, latestTurn: { ...turn, state: "running" } }, undefined, now).turnMs, 600_000);
  assert.equal(threadTimes({ ...thread, latestTurn: { ...turn, startedAt: null } }, undefined, now).turnMs, undefined);
});
