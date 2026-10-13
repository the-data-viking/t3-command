import assert from "node:assert/strict";
import test from "node:test";
import type { EnvWorld, GameState, LogEntry } from "../store";
import type { ThreadShell } from "../t3/types";
import { digest } from "./away";
import { formatHash, parseHash, ready } from "./deeplink";
import { fleetCounts, reportRead } from "./util";

test("deep links round-trip every kind of target, including odd characters", () => {
  const targets = [
    { kind: "unit", envId: "hermes-7a/89", threadId: "t 1" },
    { kind: "building", envId: "e", projectId: "p#2" },
    { kind: "library", envId: "e", projectId: "p" },
    { kind: "hermes", envId: "h", profile: "Money Guy" },
    { kind: "hermes", envId: "h" },
  ] as const;
  for (const t of targets) assert.deepEqual(parseHash(formatHash(t, null)), t);
  assert.equal(formatHash(null, "box"), "#host/box");
  assert.deepEqual(parseHash("#host/box"), { kind: "host", envId: "box" });
  assert.equal(parseHash("#nonsense"), undefined);
  assert.equal(formatHash(null, null), "");
});

test("a link waits until its machine has reported the target", () => {
  const state = { envs: { e: { threads: { t: {} }, projects: {} } } } as unknown as GameState;
  assert.equal(ready({ kind: "unit", envId: "e", threadId: "t" }, state), true);
  assert.equal(ready({ kind: "unit", envId: "e", threadId: "later" }, state), false);
  assert.equal(ready({ kind: "host", envId: "other" }, state), false);
});

test("the away digest counts jobs, failures and waits, and keeps the alarming lines", () => {
  const e = (at: number, tone: LogEntry["tone"], text: string): LogEntry => ({ id: `s${at}`, at, tone, text });
  const d = digest([
    e(5, "good", "Job's done: \"old\""),
    e(20, "good", "Job's done: \"a\""), e(21, "good", "Job's done: \"b\""),
    e(22, "bad", "\"c\" was hurt — the turn failed"),
    e(23, "alert", "\"d\" needs your approval"),
    e(24, "bad", "Lost contact with tls-agent-02"),
    e(25, "info", "\"e\" got to work"),
  ], 10)!;
  assert.deepEqual({ done: d.done, failed: d.failed, waiting: d.waiting }, { done: 2, failed: 1, waiting: 1 });
  assert.deepEqual(d.notable.map((n) => n.text), ["\"c\" was hurt — the turn failed", "Lost contact with tls-agent-02"]);
  assert.equal(digest([e(5, "good", "Job's done")], 10), undefined, "nothing new");
});

test("the briefing counts by entry kind, with landed PRs listed, and reads new plain wording", () => {
  const e = (at: number, tone: LogEntry["tone"], text: string, kind?: LogEntry["kind"]): LogEntry => ({ id: `s${at}`, at, tone, text, kind });
  const d = digest([
    e(20, "good", "\"a\" finished", "done"),
    e(21, "good", "\"b\": PR #9 merged (Fix)", "merged"),
    e(22, "bad", "\"c\" failed: npm test exited 1", "failed"),
    e(23, "info", "\"d\" started work", "started"),
    e(24, "good", "\"e\" finished"),
  ], 10)!;
  assert.deepEqual({ done: d.done, merged: d.merged, failed: d.failed }, { done: 2, merged: 1, failed: 1 });
  assert.deepEqual(d.landed.map((x) => x.text), ["\"b\": PR #9 merged (Fix)"]);
  assert.deepEqual(d.notable.map((x) => x.text), ["\"c\" failed: npm test exited 1"]);
});

test("a report marked read leaves the count until the thread's next turn", () => {
  const done = (turnId: string) => ({ id: "t", latestTurn: { turnId, state: "completed" }, session: null, latestUserMessageAt: "x", archivedAt: null, settledAt: null }) as unknown as ThreadShell;
  const envs = (turnId: string) => ({ e: { summary: { id: "e" }, threads: { t: done(turnId) } } }) as unknown as Record<string, EnvWorld>;
  const read = { "e:t": "turn-1" };
  assert.equal(reportRead(read, "e", done("turn-1")), true);
  assert.equal(fleetCounts(envs("turn-1"), read).reports, 0);
  assert.equal(fleetCounts(envs("turn-2"), read).reports, 1, "a new turn's report shows again");
});
