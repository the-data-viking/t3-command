import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import test from "node:test";
import { CommsLog } from "./comms.ts";
import { LongTurns, passed } from "./long-turns.ts";
import type { HistoryRecorder } from "./history-recorder.ts";
import type { Registry } from "./registry.ts";
import type { ThreadShell } from "../src/t3/types.ts";

const H = 3_600_000;
const running = (id: string, startedAt: number) => ({ id, title: id, latestTurn: { turnId: `${id}-t`, state: "running", requestedAt: new Date(startedAt).toISOString(), startedAt: new Date(startedAt).toISOString() } }) as unknown as ThreadShell;

test("thresholds passed are counted from the turn's start", () => {
  assert.deepEqual(passed(running("a", 0), 7 * H), [2, 6]);
  assert.deepEqual(passed(running("a", 0), H), []);
  assert.deepEqual(passed({ latestTurn: { state: "completed" } } as unknown as ThreadShell, 30 * H), []);
});

test("each threshold is noted once; what had already passed before a restart stays quiet", async () => {
  const comms = new CommsLog(await fs.mkdtemp(path.join(os.tmpdir(), "long-")));
  let threads = [running("glass", 0)];
  const recorder = { snapshot: () => ({ projects: {}, threads }) } as unknown as HistoryRecorder;
  const registry = { ids: () => ["e"] } as unknown as Registry;
  const long = new LongTurns(registry, recorder, comms);
  long.check(3 * H); // First pass after start: 2h already passed, recorded silently.
  long.check(4 * H);
  long.check(7 * H); // 6h crossed while watching.
  long.check(8 * H);
  threads = [running("glass", 0), running("new", 7 * H)];
  long.check(9.5 * H);
  assert.deepEqual(comms.since().map((e) => e.text), ['"glass" has been running for 6 hours', '"new" has been running for 2 hours']);
});
