import assert from "node:assert/strict";
import test from "node:test";
import { applyThreadEvent } from "../src/t3/reducer.ts";
import type { Activity, Message, OrchestrationEvent, OrchestrationThread } from "../src/t3/types.ts";
import { recentTurns, recordThread, threadEvents } from "./hermes/bridge.ts";

type BridgeThread = Parameters<typeof threadEvents>[1];
const at = (n: number) => new Date(Date.UTC(2026, 9, 12, 12, 0, n)).toISOString();

function thread(messages: Message[] = [], activities: Activity[] = []): BridgeThread {
  return {
    id: "worker", projectId: "hermes", title: "Worker", modelSelection: { instanceId: "hermes", model: "default" },
    runtimeMode: "approval-required", interactionMode: "default", branch: null, worktreePath: null,
    latestTurn: { turnId: "t1", state: "running", requestedAt: at(0), startedAt: at(0), completedAt: null, assistantMessageId: null },
    session: null, latestUserMessageAt: at(0), hasPendingApprovals: false, hasPendingUserInput: false,
    createdAt: at(0), updatedAt: at(0), archivedAt: null, settledAt: null, snoozedUntil: null,
    messages, activities, checkpoints: [],
  } as unknown as BridgeThread;
}
const message = (id: string, text: string, streaming = false, turnId: string | null = "t1", n = 1): Message =>
  ({ id, role: "assistant", text, streaming, turnId, createdAt: at(n), updatedAt: at(n) });
const activity = (id: string, n = 1): Activity =>
  ({ id, kind: "tool.started", summary: "Tool", payload: null, tone: "tool", turnId: "t1", createdAt: at(n) });

/** Replay events onto what the browser holds, exactly as the client's thread subscription does. */
function replay(browser: BridgeThread | OrchestrationThread, events: Array<{ event: Record<string, unknown> }>): OrchestrationThread {
  return events.reduce((t, { event }) => applyThreadEvent(t, event as unknown as OrchestrationEvent), browser as OrchestrationThread);
}

/** Events for one flush, given what the previous flush recorded as sent. */
function step(before: BridgeThread, after: BridgeThread) {
  let seq = 10;
  return threadEvents(recordThread(before), after, () => ++seq);
}

test("streamed replies travel as appended text, new messages and activities, and replay to the same transcript", () => {
  const before = thread([message("u", "hello", false)], [activity("a1")]);
  const after = structuredClone(before);
  after.messages.push(message("r", "Hello ", true, "t1", 2));
  after.activities.push(activity("a2", 2));
  let events = step(before, after)!;
  assert.deepEqual(events.map((e) => e.event.type), ["thread.message-sent", "thread.activity-appended"]);
  let browser = replay(before, events);

  const later = structuredClone(after);
  later.messages[1].text += "world";
  later.updatedAt = at(9); // Shell-only churn never forces a snapshot.
  events = step(after, later)!;
  assert.equal(events.length, 1);
  const delta = events[0].event.payload as { messageId: string; text: string; streaming: boolean };
  assert.deepEqual([delta.messageId, delta.text, delta.streaming], ["r", "world", true]);
  browser = replay(browser, events);

  const done = structuredClone(later);
  done.messages[1].streaming = false;
  events = step(later, done)!;
  assert.deepEqual(events.map((e) => (e.event.payload as { streaming: boolean }).streaming), [false]);
  browser = replay(browser, events);
  assert.deepEqual(browser.messages.map((m) => [m.id, m.text, m.streaming]), done.messages.map((m) => [m.id, m.text, m.streaming]));
  assert.deepEqual(browser.activities, done.activities);

  // Sequences keep increasing within a flush so the browser applies every event.
  const seqs = step(before, done)!.map((e) => e.event.sequence as number);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
});

test("unchanged threads send nothing", () => {
  const t = thread([message("r", "done")], [activity("a1")]);
  assert.deepEqual(step(t, structuredClone(t)), []);
});

test("turn, session, approval, replaced or reordered transcripts and non-append edits resnapshot", () => {
  const before = thread([message("a", "one"), message("b", "Hello", true)], [activity("x")]);
  const variants: Array<(t: BridgeThread) => void> = [
    (t) => { t.latestTurn = { ...t.latestTurn!, state: "completed", completedAt: at(5) }; },
    (t) => { t.hasPendingApprovals = true; },
    (t) => { t.messages = [message("z", "replaced")]; }, // Bot Chat sync replaces history.
    (t) => { t.messages.shift(); }, // Trimmed history.
    (t) => { t.messages.splice(1, 0, message("mid", "inserted")); },
    (t) => { t.messages[1].text = "Goodbye"; }, // Streaming text that is not an append.
    (t) => { t.messages[0].text = ""; }, // An empty final text cannot overwrite in the browser.
    (t) => { t.activities = []; },
  ];
  for (const change of variants) {
    const after = structuredClone(before);
    change(after);
    assert.equal(step(before, after), undefined);
  }
});

test("snapshots carry the requested recent turns, and untagged Bot Chat history is bounded", () => {
  const messages = [1, 2, 3, 4].flatMap((n) => [message(`u${n}`, "q", false, `t${n}`, n * 10), message(`r${n}`, "a", false, `t${n}`, n * 10 + 1)]);
  const activities = [1, 2, 3, 4].map((n) => activity(`a${n}`, n * 10 + 2));
  const t = thread(messages, activities);
  const recent = recentTurns(t, 2);
  assert.deepEqual(recent.messages.map((m) => m.id), ["u3", "r3", "u4", "r4"]);
  assert.deepEqual(recent.activities.map((a) => a.id), ["a3", "a4"]);
  assert.equal(recentTurns(t, 6), t);
  assert.equal(recentTurns(t, undefined), t);
  const chat = thread(Array.from({ length: 450 }, (_, i) => message(`m${i}`, "x", false, null, i)));
  assert.equal(recentTurns(chat, 6).messages.length, 200);
  assert.equal(recentTurns(chat, 6).messages.at(-1)!.id, "m449");
});

