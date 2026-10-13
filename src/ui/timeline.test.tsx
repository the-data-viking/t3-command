import assert from "node:assert/strict";
import test from "node:test";
import type { TurnRecord } from "../../shared/history";
import type { EnvWorld } from "../store";
import { buildTimeline, ticks } from "./timeline";

const H = 3_600_000;
const now = Date.UTC(2026, 9, 13, 12);
const rec = (threadId: string, turnId: string, startH: number, endH: number, outcome: TurnRecord["outcome"] = "completed", projectTitle = "alpha") => ({
  envId: "e", envLabel: "Box", projectId: "p", projectTitle, threadId, threadTitle: `T ${threadId}`, turnId, provider: "codex", model: "m",
  startedAt: new Date(now - startH * H).toISOString(), completedAt: new Date(now - endH * H).toISOString(), durationMs: (startH - endH) * H, outcome,
}) as TurnRecord;

const envs = {
  e: { summary: { id: "e", label: "Box" }, connection: "live", projects: { p: { id: "p", title: "alpha" } }, threads: {
    t1: { id: "t1", projectId: "p", title: "Live one", latestTurn: { turnId: "run", state: "running", startedAt: new Date(now - 2 * H).toISOString(), requestedAt: "" }, session: { status: "running" }, latestUserMessageAt: "x" },
  } },
} as unknown as Record<string, EnvWorld>;

test("turns become bars in lanes grouped by project, newest activity first, live turns at the edge", () => {
  const groups = buildTimeline({ from: now - 24 * H, to: now, turns: [rec("t1", "a", 10, 9), rec("t2", "b", 30, 5, "error", "beta"), rec("t1", "c", 4, 3)] }, envs, now);
  assert.deepEqual(groups.map((g) => g.project), ["alpha", "beta"]);
  const live = groups[0].lanes[0];
  assert.equal(live.title, "Live one", "a thread still on the fleet uses its current title");
  assert.deepEqual(live.bars.map((b) => b.tone), ["done", "done", "working"]);
  assert.equal(live.bars[2].end, now);
  const clipped = groups[1].lanes[0].bars[0];
  assert.equal(clipped.start, now - 24 * H, "a turn that began before the window is clipped to it");
  assert.equal(clipped.tone, "error");
});

test("a running turn that history already closed isn't drawn twice", () => {
  const groups = buildTimeline({ from: now - 24 * H, to: now, turns: [rec("t1", "run", 2, 1)] }, envs, now);
  assert.equal(groups[0].lanes[0].bars.length, 1);
});

test("ticks land on whole hours, sparser for longer windows", () => {
  const six = ticks(now - 6 * H, now), day = ticks(now - 24 * H, now), three = ticks(now - 72 * H, now);
  assert.ok(six.length >= 5 && six.length <= 6);
  assert.ok(day.length >= 7 && day.length <= 8);
  assert.ok(three.length >= 5 && three.length <= 6);
  for (const t of [...six, ...day, ...three]) assert.equal(new Date(t).getMinutes(), 0);
});
