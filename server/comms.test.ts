import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CommsLog } from "./comms.ts";
import { bucket, toSample } from "./host-history.ts";
import type { ThreadShell } from "../src/t3/types.ts";

const thread = (id: string, over: Partial<ThreadShell> = {}) => ({
  id, title: `T ${id}`, hasPendingApprovals: false, hasPendingUserInput: false, session: null, archivedAt: null, settledAt: null,
  latestUserMessageAt: "2026-10-12T00:00:00Z", latestTurn: { turnId: "a", state: "completed", requestedAt: "", startedAt: "", completedAt: "", assistantMessageId: null }, ...over,
}) as unknown as ThreadShell;
const running = (id: string, over: Partial<ThreadShell> = {}) => thread(id, { latestTurn: { turnId: "b", state: "running", requestedAt: "", startedAt: "", completedAt: null, assistantMessageId: null }, ...over });

async function tempLog() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "comms-"));
  return { dir, log: new CommsLog(dir) };
}

test("the first snapshot after connecting is a baseline; later changes are logged like the map shows them", async () => {
  const { dir, log } = await tempLog();
  log.observe("e", [running("1"), thread("2")]);
  assert.equal(log.since().length, 0);
  log.observe("e", [running("1", { hasPendingApprovals: true }), running("2")]);
  log.observe("e", [thread("1"), running("2")]);
  assert.deepEqual(log.since().map((e) => [e.tone, e.text, e.threadId]), [
    ["alert", `"T 1" needs your approval`, "1"],
    ["info", `"T 2" got to work`, "2"],
  ]);
  await log.flush();
  const saved = (await fs.readFile(path.join(dir, "comms-log.jsonl"), "utf8")).trim().split("\n");
  assert.equal(saved.length, 2);
  assert.equal((await fs.stat(path.join(dir, "comms-log.jsonl"))).mode & 0o777, 0o600);
  const reloaded = new CommsLog(dir);
  await reloaded.load();
  assert.equal(reloaded.add({ tone: "info", text: "x" }).id, 3, "ids continue after a restart");
  assert.deepEqual(reloaded.since(1).map((e) => e.id), [2, 3]);
});

test("a reconnect resets the baseline, so states missed while away aren't replayed", async () => {
  const { log } = await tempLog();
  log.observe("e", [running("1")]);
  log.disconnected("e", "Box");
  log.connected("e", "Box");
  log.observe("e", [thread("1")]);
  assert.equal(log.since().length, 0);
});

test("a machine away past the grace period is announced, then announced back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { log } = await tempLog();
  log.disconnected("e", "Box");
  log.connected("e", "Box");
  t.mock.timers.tick(200_000);
  assert.equal(log.since().length, 0, "a quick reconnect stays quiet");
  log.disconnected("e", "Box");
  t.mock.timers.tick(91_000);
  log.connected("e", "Box");
  assert.deepEqual(log.since().map((e) => [e.tone, e.text]), [["bad", "Lost contact with Box"], ["good", "Box is back online"]]);
});

test("host samples are kept as fractions and long ranges are bucketed with peaks", () => {
  assert.deepEqual(toSample({ sampledAt: 5, cpuUtilization: 0.5, availableMemoryBytes: 25, totalMemoryBytes: 100 }), [5, 0.5, 0.75]);
  assert.deepEqual(toSample({ sampledAt: 5, cpuUtilization: null, availableMemoryBytes: 200, totalMemoryBytes: 100 }), [5, null, null]);
  const samples: Array<[number, number | null, number | null]> = Array.from({ length: 10 }, (_, i) => [i * 10, i % 2 ? 0.8 : 0.2, 0.5]);
  const points = bucket(samples, 0, 100, 5);
  assert.equal(points.length, 5);
  assert.deepEqual(points[0], { at: 10, cpu: 0.5, cpuPeak: 0.8, mem: 0.5 });
  assert.deepEqual(bucket(samples, 0, 100, 50)[1], { at: 10, cpu: 0.8, cpuPeak: 0.8, mem: 0.5 }, "short ranges pass through");
});
