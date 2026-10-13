import assert from "node:assert/strict";
import test from "node:test";
import type { EnvWorld } from "../store";
import { lastActivityAt } from "../t3/progress";
import type { OrchestrationThread, ThreadShell } from "../t3/types";
import { fleetCounts, isBackground, stateLabel } from "./util";

const t = (id: string, over: Partial<ThreadShell>) => ({
  id, title: id, session: null, latestTurn: { turnId: "x", state: "completed" }, latestUserMessageAt: "x", archivedAt: null, settledAt: null,
  hasPendingApprovals: false, hasPendingUserInput: false, ...over,
}) as unknown as ThreadShell;

test("working with no running turn is Background, not a turn", () => {
  const bg = t("bg", { session: { status: "running" } as ThreadShell["session"] });
  assert.equal(isBackground(bg, "working"), true);
  assert.equal(stateLabel(bg, "working"), "Background");
  const turn = t("turn", { latestTurn: { state: "running" } as ThreadShell["latestTurn"] });
  assert.equal(stateLabel(turn, "working"), "Working");
});

test("the top bar and the phone dock share one count, Hermes sessions included", () => {
  const envs = {
    a: { summary: { id: "a", kind: "t3" }, threads: {
      w: t("w", { latestTurn: { state: "running" } as ThreadShell["latestTurn"] }),
      b: t("b", { backgroundLiveness: "working" }),
      q: t("q", { hasPendingUserInput: true }),
      d: t("d", {}),
      e: t("e", { latestTurn: { state: "error" } as ThreadShell["latestTurn"] }),
    } },
    h: { summary: { id: "h", kind: "hermes" }, threads: { op: t("op", { hasPendingApprovals: true }) } },
  } as unknown as Record<string, EnvWorld>;
  const c = fleetCounts(envs);
  assert.deepEqual({ ...c }, { working: 1, background: 1, monitoring: 0, waiting: 2, reports: 1, failed: 1, crew: 5, awake: 5 });
});

test("last activity is the newest activity or message update", () => {
  const thread = { activities: [{ createdAt: "2026-10-12T10:00:00Z" }], messages: [{ updatedAt: "2026-10-12T10:05:00Z" }] } as unknown as OrchestrationThread;
  assert.equal(lastActivityAt(thread), Date.parse("2026-10-12T10:05:00Z"));
  assert.equal(lastActivityAt({ activities: [], messages: [] } as unknown as OrchestrationThread), undefined);
});
