import assert from "node:assert/strict";
import test from "node:test";
import type { EnvWorld, GameState } from "../store";
import type { ThreadShell } from "../t3/types";
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

test("a report marked read leaves the count until the thread's next turn", () => {
  const done = (turnId: string) => ({ id: "t", latestTurn: { turnId, state: "completed" }, session: null, latestUserMessageAt: "x", archivedAt: null, settledAt: null }) as unknown as ThreadShell;
  const envs = (turnId: string) => ({ e: { summary: { id: "e" }, threads: { t: done(turnId) } } }) as unknown as Record<string, EnvWorld>;
  const read = { "e:t": "turn-1" };
  assert.equal(reportRead(read, "e", done("turn-1")), true);
  assert.equal(fleetCounts(envs("turn-1"), read).reports, 0);
  assert.equal(fleetCounts(envs("turn-2"), read).reports, 1, "a new turn's report shows again");
});
