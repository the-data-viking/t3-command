import assert from "node:assert/strict";
import test from "node:test";
import type { EnvWorld } from "../store";
import type { ThreadShell } from "./types";
import { attentionCount, titleFor } from "../ui/attention";

const t = (id: string, extra: Partial<ThreadShell>) => ({ id, session: null, latestTurn: null, archivedAt: null, settledAt: null, ...extra }) as unknown as ThreadShell;

test("the tab title counts crew waiting on approvals and questions", () => {
  const envs = { a: { threads: {
    one: t("one", { hasPendingApprovals: true }),
    two: t("two", { hasPendingUserInput: true }),
    three: t("three", { session: { status: "running" } as ThreadShell["session"] }),
  } } } as unknown as Record<string, EnvWorld>;
  assert.equal(attentionCount(envs), 2);
  assert.equal(titleFor(2), "(2) T3 Command");
  assert.equal(titleFor(0), "T3 Command");
});

test("a quiet turn is announced once, in the comms log", async () => {
  const { announceQuiet } = await import("../ui/attention");
  const { useGame } = await import("../store");
  const start = Date.parse("2026-10-12T10:00:00Z");
  const turn = { turnId: "t1", state: "running", requestedAt: new Date(start).toISOString(), startedAt: new Date(start).toISOString(), completedAt: null, assistantMessageId: null };
  const shell = t("th", { title: "Refactor", latestTurn: turn as ThreadShell["latestTurn"], hasPendingApprovals: false, hasPendingUserInput: false });
  useGame.setState({
    log: [], notify: false,
    envs: { e: { summary: { id: "e", label: "Box" }, connection: "live", threads: { th: shell } } } as unknown as Record<string, EnvWorld>,
    details: { "e:th": { thread: { ...shell, activities: [], messages: [], checkpoints: [] } } } as never,
  });
  const announced = new Set<string>();
  announceQuiet(announced, start + 5 * 60_000);
  assert.equal(useGame.getState().log.length, 0);
  announceQuiet(announced, start + 12 * 60_000);
  announceQuiet(announced, start + 20 * 60_000);
  assert.deepEqual(useGame.getState().log.map((l) => l.text), ["Refactor has had no activity for 12m 0s"]);
});
