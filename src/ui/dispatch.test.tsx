import assert from "node:assert/strict";
import test from "node:test";
import type { Dispatch, DispatchMember } from "../../shared/dispatches";
import type { EnvWorld } from "../store";
import type { ThreadShell } from "../t3/types";
import { dispatchTitle, progressOf, receiptOf, replyOf } from "./dispatch";

const shell = (id: string, turnId: string, state: string, extra: Partial<ThreadShell> = {}) =>
  ({ id, title: id, latestTurn: { turnId, state }, session: null, hasPendingApprovals: false, hasPendingUserInput: false, ...extra }) as unknown as ThreadShell;
const envs = { e: { threads: {
  working: shell("working", "t2", "running"),
  asking: shell("asking", "t2", "running", { hasPendingApprovals: true }),
  done: shell("done", "t2", "completed"),
  broke: shell("broke", "t2", "error"),
  halted: shell("halted", "t2", "interrupted"),
  waiting: shell("waiting", "t1", "running"),
  archived: shell("archived", "t2", "completed", { archivedAt: "2026-10-13T00:00:00Z" }),
} } } as unknown as Record<string, EnvWorld>;
const m = (threadId: string, how: DispatchMember["how"] = "sent", baseTurnId: string | null = "t1"): DispatchMember => ({ envId: "e", threadId, title: threadId, how, baseTurnId });

test("a receipt: a new turn since the order means it arrived; that turn's state says what came of it", () => {
  assert.equal(receiptOf(m("working"), envs), "working");
  assert.equal(receiptOf(m("asking"), envs), "needs-you");
  assert.equal(receiptOf(m("done"), envs), "reported");
  assert.equal(receiptOf(m("broke"), envs), "failed");
  assert.equal(receiptOf(m("halted"), envs), "stopped");
  assert.equal(receiptOf(m("waiting"), envs), "sent");
  assert.equal(receiptOf(m("done", "failed"), envs), "unsent");
  assert.equal(receiptOf(m("archived"), envs), "gone");
  assert.equal(receiptOf(m("missing"), envs), "gone");
});

test("a queued receipt holds while its follow-up is queued, and says so once it's dropped unsent", () => {
  assert.equal(receiptOf(m("waiting", "queued"), envs), "queued", "even once its follow-up left the queue, until its turn shows");
  assert.equal(receiptOf({ ...m("waiting", "queued"), dropped: true }, envs), "undelivered");
  assert.equal(receiptOf({ ...m("done", "queued"), dropped: true }, envs), "undelivered", "a later turn isn't this order's");
  assert.equal(receiptOf(m("done", "queued"), envs), "reported");
});

test("progress counts what's over, what was reported, what needs you and what went wrong", () => {
  const d: Dispatch = { id: "d", at: 0, text: "Status please.", members: [m("working"), m("asking"), m("done"), m("broke"), m("done", "failed")] };
  const p = progressOf(d, envs);
  assert.deepEqual({ done: p.done, reported: p.reported, needsYou: p.needsYou, trouble: p.trouble, total: p.total }, { done: 3, reported: 1, needsYou: 1, trouble: 2, total: 5 });
  assert.equal(dispatchTitle({ ...d, text: "\n  Status please.\nMore detail" }), "Status please.");
  assert.equal(dispatchTitle({ ...d, text: "x".repeat(100) }, 10), `${"x".repeat(9)}…`);
});

test("a reply is the crew member's last message in its latest turn, once the order reached them", () => {
  const thread = shell("done", "t2", "completed");
  const msg = (text: string, turnId: string, role = "assistant") => ({ id: text, role, text, turnId, streaming: false, createdAt: "", updatedAt: "" });
  const detail = { synced: true, thread: { messages: [msg("old answer", "t1"), msg("Status please.", "t2", "user"), msg("first half", "t2"), msg("All green, PR #9 open.", "t2"), msg("  ", "t2")] } } as never;
  assert.equal(replyOf("reported", thread, detail), "All green, PR #9 open.");
  assert.equal(replyOf("sent", thread, detail), undefined, "not reached yet: the latest turn isn't the order's");
  assert.equal(replyOf("reported", thread, undefined), undefined, "not loaded");
});
