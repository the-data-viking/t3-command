import assert from "node:assert/strict";
import test from "node:test";
import type { Activity, Message } from "../t3/types";
import { transcriptEntries } from "./transcript";

const at = (second: number) => new Date(Date.UTC(2026, 9, 11, 12, 0, second)).toISOString();
const activity = (second: number, overrides: Partial<Activity> = {}): Activity => ({
  id: `activity-${second}`, createdAt: at(second), kind: "tool.completed", tone: "tool",
  summary: "Read file", payload: null, turnId: "turn", ...overrides,
});
const message = (second: number): Message => ({
  id: `message-${second}`, createdAt: at(second), updatedAt: at(second), role: "assistant",
  text: "Progress report", turnId: "turn", streaming: false,
});

test("tool-heavy turns retain messages when the transcript limit is applied", () => {
  const entries = transcriptEntries({
    messages: [message(0), message(200)],
    activities: Array.from({ length: 150 }, (_, index) => activity(index + 1)),
  }, 3);
  assert.deepEqual(entries.map((entry) => entry.kind), ["message", "tools", "message"]);
  assert.equal(entries[1].kind === "tools" && entries[1].activities.length, 150);
});

test("errors, approvals, messages, and new turns interrupt collapsed tool runs", () => {
  const entries = transcriptEntries({
    messages: [message(7)],
    activities: [
      activity(1), activity(2, { kind: "task.started", tone: "info" }),
      activity(3, { tone: "error", kind: "turn.failed" }), activity(4),
      activity(5, { tone: "approval", kind: "approval.requested" }), activity(6), activity(8),
      activity(9, { turnId: "next-turn" }), activity(10, { turnId: "next-turn", payload: { status: "failed" } }),
      activity(11, { tone: "info", kind: "context-window.updated" }),
    ],
  });
  assert.deepEqual(entries.map((entry) => entry.kind), [
    "tools", "activity", "tools", "activity", "tools", "message", "tools", "tools",
  ]);
  assert.deepEqual(entries.filter((entry) => entry.kind === "activity").map((entry) => entry.activity.id),
    ["activity-3", "activity-5"]);
});

test("tool-level failures stay in their collapsed run instead of capping it with a standalone error", () => {
  const entries = transcriptEntries({
    messages: [message(0), message(6)],
    activities: [activity(1), activity(2, { payload: { status: "failed" } }),
      activity(3), activity(4, { tone: "error", payload: { status: "failed" } }), activity(5)],
  });
  assert.deepEqual(entries.map((entry) => entry.kind), ["message", "tools", "message"]);
  assert.equal(entries[1].kind === "tools" && entries[1].activities.length, 5);
});
