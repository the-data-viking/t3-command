import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import test from "node:test";
import { CommsLog } from "./comms.ts";
import { LongTurns, spinSigns } from "./long-turns.ts";
import type { HistoryRecorder } from "./history-recorder.ts";
import type { Registry } from "./registry.ts";
import type { ThreadShell } from "../src/t3/types.ts";

const H = 3_600_000;
const running = (id: string, startedAt: number) => ({ id, title: id, latestTurn: { turnId: `${id}-t`, state: "running", requestedAt: new Date(startedAt).toISOString(), startedAt: new Date(startedAt).toISOString() } }) as unknown as ThreadShell;

test("elapsed time and inactivity never produce alerts, including after restart", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "long-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const comms = new CommsLog(dir);
  const threads = [running("glass", 0)];
  threads[0].updatedAt = new Date(0).toISOString();
  const recorder = { snapshot: () => ({ projects: {}, threads }) } as unknown as HistoryRecorder;
  const registry = { ids: () => ["e"] } as unknown as Registry;
  const long = new LongTurns(registry, recorder, comms, async () => ({ ...threads[0], activities: [] }) as never);
  for (const h of [1, 3, 7, 13, 25, 100]) {
    long.check(h * H);
    await new Promise((r) => setTimeout(r, 0));
  }
  new LongTurns(registry, recorder, comms).check(101 * H);
  assert.deepEqual(comms.since(), []);
  await comms.flush();
});

test("a long turn that may be spinning is said once per sign, read from its own activity", async () => {
  const comms = new CommsLog(await fs.mkdtemp(path.join(os.tmpdir(), "long-")));
  const iso = (ms: number) => new Date(ms).toISOString();
  const fail = (id: string, ms: number) => ({ id, kind: "tool.completed", tone: "error", summary: "python3 check.py", turnId: "glass-t", createdAt: iso(ms), payload: { toolCallId: id, detail: "python3 check.py", exitCode: 1 } });
  const full = { id: "glass", title: "glass", latestTurn: { turnId: "glass-t", state: "running", startedAt: iso(0), requestedAt: iso(0) },
    activities: [fail("a", 60_000), fail("b", 120_000), fail("c", 180_000)] };
  const recorder = { snapshot: () => ({ projects: {}, threads: [running("glass", 0)] }) } as unknown as HistoryRecorder;
  const registry = { ids: () => ["e"] } as unknown as Registry;
  const reads: string[] = [];
  const long = new LongTurns(registry, recorder, comms, async (_e, id) => { reads.push(id); return full as never; });
  long.check(10 * 60_000); // First pass seeds; too young to read anyway.
  assert.deepEqual(reads, []);
  long.check(15 * 60_000);
  await new Promise((r) => setTimeout(r, 0));
  long.check(16 * 60_000);
  await new Promise((r) => setTimeout(r, 0));
  const said = comms.since().filter((e) => e.kind === "spinning").map((e) => e.text);
  assert.deepEqual(said, ['"glass" may be spinning: python3 check.py failed 3× without progress']);
});

test("long scripts, testing, and no edits do not produce spinning signs", () => {
  const shell = running("glass", 0);
  const activity = (id: string, min: number, kind: string, payload: Record<string, unknown>) => ({
    id, turnId: "glass-t", kind, createdAt: new Date(min * 60_000).toISOString(), summary: "npm test", payload: { toolCallId: id, detail: "npm test", ...payload },
  });
  const fails = [111, 112, 113].map((min) => activity(`f${min}`, min, "tool.completed", { exitCode: 1 }));
  for (const activities of [
    [],
    [activity("tests", 1, "tool.started", { status: "running" })],
    [activity("tests", 1, "tool.completed", { exitCode: 0 })],
    [...fails, activity("script", 114, "tool.started", { status: "running" })],
    [...fails, activity("tests", 114, "tool.completed", { exitCode: 0 })],
  ]) assert.deepEqual(spinSigns({ ...shell, activities } as never, 2 * H), []);
  assert.equal(spinSigns({ ...shell, activities: fails } as never, 2 * H).length, 1, "real recent repeated failures still alert");
});

test("a completed turn cannot announce a stale spinning read", async () => {
  const comms = new CommsLog(await fs.mkdtemp(path.join(os.tmpdir(), "long-")));
  let shell = running("glass", 0);
  const recorder = { snapshot: () => ({ projects: {}, threads: [shell] }) } as unknown as HistoryRecorder;
  const registry = { ids: () => ["e"] } as unknown as Registry;
  let finish!: (thread: never) => void;
  const long = new LongTurns(registry, recorder, comms, () => new Promise((resolve) => { finish = resolve; }));
  long.check(10 * 60_000);
  long.check(20 * 60_000);
  const full = { ...shell, activities: [16, 17, 18].map((min) => ({ id: String(min), turnId: "glass-t", kind: "tool.completed", createdAt: new Date(min * 60_000).toISOString(), payload: { detail: "npm test", exitCode: 1 } })) };
  shell = { ...shell, latestTurn: { ...shell.latestTurn!, state: "completed" } };
  finish(full as never);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(comms.since().filter((e) => e.kind === "spinning").length, 0);
});

test("subagents never trigger spinning reads or alerts", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "child-alerts-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const comms = new CommsLog(dir);
  const child = { ...running("child", 0), lineage: { relationshipToParent: "subagent", parentThreadId: "parent", rootThreadId: "parent" } };
  const registry = { ids: () => ["e"] } as unknown as Registry;
  const recorder = { snapshot: () => ({ threads: [child] }) } as unknown as HistoryRecorder;
  let reads = 0;
  const long = new LongTurns(registry, recorder, comms, async () => { reads++; throw new Error("Should not read children"); });
  long.check(0);
  long.check(25 * H);
  assert.equal(reads, 0);
  assert.deepEqual(comms.since(), []);
  await comms.flush();
});
