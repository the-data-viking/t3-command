import assert from "node:assert/strict";
import test from "node:test";
import { loadDemoFleet } from "../demo";
import { useGame } from "../store";
import type { ThreadShell } from "../t3/types";
import { boardOf, columnOf } from "./board";

const pr = (state: string) => ({ pullRequests: [{ number: 1, repository: "r", snapshot: { state } }] }) as unknown as ThreadShell;
const plan = { interactionMode: "plan" } as ThreadShell;
const plain = { interactionMode: "default" } as ThreadShell;

test("each mission sits in the column for what it needs next", () => {
  for (const state of ["alert", "question", "error"] as const) assert.equal(columnOf(plain, state, false), "needs-you");
  assert.equal(columnOf(plan, "working", false), "building", "drafting a plan is work in progress");
  assert.equal(columnOf(plan, "done", false), "needs-you", "a finished plan waits for your approval");
  assert.equal(columnOf(plain, "error", true), undefined, "a seen failure leaves the board");
  assert.equal(columnOf(plain, "working", false), "building");
  assert.equal(columnOf(plain, "monitoring", false), "building");
  assert.equal(columnOf(pr("open"), "done", false), "report", "read the report before the PR");
  assert.equal(columnOf(pr("open"), "done", true), "review");
  assert.equal(columnOf(pr("merged"), "done", true), undefined);
  assert.equal(columnOf(pr("open"), "sleeping", true), undefined, "at camp is off the board");
  assert.equal(columnOf(plain, "idle", false), undefined);
});

test("the demo fleet's board: no Hermes operators, longest-standing first", () => {
  loadDemoFleet();
  const { envs, readReports } = useGame.getState();
  const board = boardOf(envs, readReports);
  const all = Object.values(board).flat();
  assert.ok(all.every((c) => envs[c.envId].summary.kind !== "hermes"));
  const needsYou = board["needs-you"].map((c) => c.thread.id);
  assert.ok(needsYou.includes("a2") && needsYou.includes("b2"), "the approval and the question need you");
  assert.equal(needsYou[0], "a2", "the longest wait leads");
  assert.equal(board.report[0]?.thread.id, "a3");
});
