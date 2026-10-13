import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectShell, ThreadShell } from "../src/t3/types.ts";
import { summarizeHistory, type TurnRecord } from "../shared/history.ts";
import { TurnHistory } from "./history.ts";

const T0 = Date.parse("2026-10-12T15:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const projects = { p: { id: "p", title: "t3-command" } as ProjectShell };

function thread(id: string, turn: { id: string; state: string; started?: number; done?: number } | null, extra: Partial<ThreadShell> = {}): ThreadShell {
  return {
    id, projectId: "p", title: `Thread ${id}`, modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    session: { providerInstanceId: "codex", lastError: null } as ThreadShell["session"],
    latestTurn: turn && { turnId: turn.id, state: turn.state, requestedAt: iso(turn.started ?? T0), startedAt: iso(turn.started ?? T0), completedAt: turn.done ? iso(turn.done) : null, assistantMessageId: null },
    ...extra,
  } as ThreadShell;
}

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3c-history-"));
  let now = T0;
  const clock = { set: (ms: number) => { now = ms; } };
  const history = new TurnHistory(dir, () => now);
  await history.load();
  return { dir, history, clock, reload: async () => { await history.flush(); const h = new TurnHistory(dir, () => now); await h.load(); return h; } };
}

const recorded = (h: TurnHistory) => h.summary(90, "UTC").recent;

test("the first start records nothing old, then records turns as they finish", async () => {
  const { history, clock } = await setup();
  history.connected("env", "Mac mini");
  history.observe("env", projects, [thread("old", { id: "t0", state: "completed", started: T0 - 7_200_000, done: T0 - 3_600_000 })]);
  assert.equal(recorded(history).length, 0, "no backfill");
  clock.set(T0 + 1_000);
  history.observe("env", projects, [thread("old", { id: "t0", state: "completed", done: T0 - 3_600_000 }), thread("a", { id: "t1", state: "running", started: T0 + 1_000 })]);
  // Another thread's update advances the watermark before this turn's completion arrives.
  clock.set(T0 + 90_000);
  history.observe("env", projects, [thread("old", { id: "t0", state: "completed", done: T0 - 3_600_000 }, { title: "renamed" }), thread("a", { id: "t1", state: "running", started: T0 + 1_000 })]);
  clock.set(T0 + 120_000);
  history.observe("env", projects, [thread("a", { id: "t1", state: "completed", started: T0 + 1_000, done: T0 + 61_000 })]);
  const [r] = recorded(history);
  assert.equal(recorded(history).length, 1);
  assert.equal(r.durationMs, 60_000);
  assert.deepEqual([r.envLabel, r.projectTitle, r.provider, r.model, r.outcome], ["Mac mini", "t3-command", "codex", "gpt-6.1-sol", "completed"]);
  // Re-upserts of a finished thread (settle, rename) don't record it again.
  history.observe("env", projects, [thread("a", { id: "t1", state: "completed", started: T0 + 1_000, done: T0 + 61_000 }, { title: "settled" })]);
  assert.equal(recorded(history).length, 1);
});

test("failed turns keep the provider's reason", async () => {
  const { history, clock } = await setup();
  history.connected("env", "Wesley");
  history.observe("env", projects, [thread("a", { id: "t1", state: "running" })]);
  clock.set(T0 + 5_000);
  history.observe("env", projects, [thread("a", { id: "t1", state: "error", done: T0 + 5_000 }, { session: { lastError: "Claude usage limit reached." } as ThreadShell["session"] })]);
  assert.equal(recorded(history)[0].outcome, "error");
  assert.equal(recorded(history)[0].error, "Claude usage limit reached.");
});

test("a turn that finished during an outage is recovered; long outages are reported as gaps", async () => {
  const { history, clock, reload } = await setup();
  history.connected("env", "Agent 1");
  history.observe("env", projects, [thread("a", { id: "t1", state: "running" })]);
  clock.set(T0 + 60_000);
  history.disconnected("env");
  await history.flush();
  // Command restarts 20 minutes later; the turn finished while it was down.
  clock.set(T0 + 20 * 60_000);
  const restarted = await reload();
  restarted.connected("env", "Agent 1");
  restarted.observe("env", projects, [thread("a", { id: "t1", state: "completed", done: T0 + 10 * 60_000 })]);
  assert.equal(recorded(restarted).length, 1, "recovered from the snapshot after reconnecting");
  const gaps = restarted.summary(7, "UTC").gaps;
  assert.equal(gaps.length, 1);
  assert.deepEqual([gaps[0].envLabel, gaps[0].from, gaps[0].to], ["Agent 1", iso(T0 + 60_000), iso(T0 + 20 * 60_000)]);
});

test("records survive restarts without duplicates, in an owner-only file", async () => {
  const { dir, history, clock, reload } = await setup();
  history.connected("env", "Mac mini");
  history.observe("env", projects, [thread("a", { id: "t1", state: "running" })]);
  clock.set(T0 + 30_000);
  history.observe("env", projects, [thread("a", { id: "t1", state: "completed", done: T0 + 30_000 })]);
  clock.set(T0 + 60_000);
  const restarted = await reload();
  restarted.connected("env", "Mac mini");
  restarted.observe("env", projects, [thread("a", { id: "t1", state: "completed", done: T0 + 30_000 })]);
  assert.equal(recorded(restarted).length, 1);
  assert.equal((await fs.stat(path.join(dir, "turn-history.jsonl"))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(dir, "turn-history-state.json"))).mode & 0o777, 0o600);
});

test("records older than 90 days are pruned on load", async () => {
  const { dir, history, clock, reload } = await setup();
  history.connected("env", "Mac mini");
  history.observe("env", projects, [thread("a", { id: "t1", state: "running" })]);
  clock.set(T0 + 1_000);
  history.observe("env", projects, [thread("a", { id: "t1", state: "completed", done: T0 + 1_000 })]);
  clock.set(T0 + 91 * 86_400_000);
  const later = await reload();
  assert.equal(recorded(later).length, 0);
  assert.equal((await fs.readFile(path.join(dir, "turn-history.jsonl"), "utf8")).trim(), "");
});

test("the summary buckets by the viewer's calendar day and ranks work", () => {
  const rec = (completedAt: string, durationMs: number, outcome: TurnRecord["outcome"], extra: Partial<TurnRecord> = {}) =>
    ({ envId: "e", envLabel: "E", projectId: "p", projectTitle: "alpha", threadId: completedAt, threadTitle: "t", turnId: "x", provider: "codex",
      model: "sol", startedAt: completedAt, completedAt, durationMs, outcome, ...extra }) as TurnRecord;
  const records = [
    rec("2026-10-12T04:30:00Z", 60_000, "completed"), // Oct 11, 23:30 in Chicago
    rec("2026-10-12T15:00:00Z", 120_000, "completed", { projectTitle: "beta", model: "opus" }),
    rec("2026-10-12T16:00:00Z", 600_000, "completed", { projectTitle: "beta" }),
    rec("2026-10-12T17:00:00Z", 5_000, "error", { error: "limit reached" }),
    rec("2026-10-12T18:00:00Z", 5_000, "error", { error: "limit reached" }),
    rec("2026-09-01T12:00:00Z", 1, "completed"), // outside the 7-day window
  ];
  const s = summarizeHistory(records, [{ envId: "e", from: "2026-10-10T00:00:00Z", to: "2026-10-12T20:00:00Z" }], { e: "E" },
    { days: 7, timeZone: "America/Chicago", now: Date.parse("2026-10-12T20:00:00Z") });
  assert.equal(s.daily.length, 7);
  assert.deepEqual(s.daily.at(-2), { day: "2026-10-11", completed: 1, error: 0, interrupted: 0, durationMs: 60_000 });
  assert.deepEqual([s.daily.at(-1)!.completed, s.daily.at(-1)!.error], [2, 2]);
  assert.deepEqual([s.totals.turns, s.totals.medianMs, s.totals.longestMs], [5, 120_000, 600_000]);
  assert.deepEqual(s.topErrors, [{ error: "limit reached", count: 2 }]);
  assert.deepEqual(s.projects.map((p) => [p.name, p.turns]), [["alpha", 3], ["beta", 2]]);
  assert.equal(s.recordingSince, "2026-10-10T00:00:00Z");
  assert.equal(s.gaps.length, 0);
});

test("turns record the model they started on and exclude time spent waiting on the operator", async () => {
  const { history, clock } = await setup();
  history.connected("env", "Mac mini");
  history.observe("env", projects, [thread("a", { id: "t1", state: "running", started: T0 })]);
  clock.set(T0 + 60_000); // waiting on an approval for two minutes
  history.observe("env", projects, [thread("a", { id: "t1", state: "running", started: T0 }, { hasPendingApprovals: true })]);
  clock.set(T0 + 180_000);
  history.observe("env", projects, [thread("a", { id: "t1", state: "running", started: T0 }, { hasPendingApprovals: false })]);
  clock.set(T0 + 300_000);
  // The thread's model changed after the turn started; the record keeps the one that ran.
  history.observe("env", projects, [thread("a", { id: "t1", state: "completed", started: T0, done: T0 + 300_000 }, { modelSelection: { instanceId: "codex", model: "gpt-7" } })]);
  const [r] = recorded(history);
  assert.deepEqual([r.model, r.durationMs, r.waitMs], ["gpt-6.1-sol", 300_000, 120_000]);
  assert.equal(history.summary(1, "UTC").totals.medianMs, 180_000, "typical turn time is the agent's own work");
});

test("Hermes turns are attributed to their bot profile, not a generic model", async () => {
  const { history, clock } = await setup();
  history.connected("hermes", "Hermes");
  const bot = (state: string, done?: number) => thread("h", { id: "t1", state, done }, { hermesProfile: "money-guy", modelSelection: { instanceId: "hermes", model: "default" }, session: { providerInstanceId: "hermes" } as ThreadShell["session"] });
  history.observe("hermes", projects, [bot("running")]);
  clock.set(T0 + 1_000);
  history.observe("hermes", projects, [bot("completed", T0 + 1_000)]);
  assert.equal(recorded(history)[0].model, "money-guy (Hermes)");
});

test("failures group by kind, not exact text", () => {
  const rec = (error: string) => ({ envId: "e", envLabel: "E", projectId: "p", projectTitle: "p", threadId: error, threadTitle: "t", turnId: "x",
    provider: "c", model: "m", startedAt: "2026-10-12T10:00:00Z", completedAt: "2026-10-12T10:00:00Z", durationMs: 1, outcome: "error" as const, error });
  const s = summarizeHistory([
    rec("Codex could not read usage (JSON-RPC -32600)."),
    rec("Codex could not read usage (JSON-RPC -32601)."),
    rec("Could not write /Users/a/tmp/x.json: ENOSPC"),
    rec("Could not write /home/b/out/y.json: ENOSPC"),
    rec("Claude usage limit reached."),
  ], [], {}, { days: 1, timeZone: "UTC", now: Date.parse("2026-10-12T12:00:00Z") });
  assert.deepEqual(s.topErrors.map((e) => e.count), [2, 2, 1]);
});

test("the longest turns rank by agent time, so a long wait on you doesn't make a turn look slow", () => {
  const rec = (threadId: string, durationMs: number, waitMs = 0) => ({ envId: "e", envLabel: "E", projectId: "p", projectTitle: "p", threadId, threadTitle: threadId, turnId: threadId,
    provider: "c", model: "m", startedAt: "2026-10-12T10:00:00Z", completedAt: "2026-10-12T11:00:00Z", durationMs, waitMs, outcome: "completed" as const });
  const s = summarizeHistory([rec("waited", 5 * 3_600_000, 4.5 * 3_600_000), rec("worked", 2 * 3_600_000), rec("quick", 60_000)], [], {},
    { days: 1, timeZone: "UTC", now: Date.parse("2026-10-12T12:00:00Z") });
  assert.deepEqual(s.longest.map((r) => r.threadId), ["worked", "waited", "quick"]);
});
