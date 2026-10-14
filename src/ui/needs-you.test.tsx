import assert from "node:assert/strict";
import test from "node:test";
import { loadDemoFleet } from "../demo";
import { useGame } from "../store";
import { parseHash } from "./deeplink";
import { needsYou, needsYouCounts } from "./needs-you";
import { fleetCounts } from "./util";

test("one ordered list: requests by longest wait, then plans, failures, reports", () => {
  loadDemoFleet();
  useGame.setState({ readReports: {} });
  const s = useGame.getState();
  // The Hermes operator's finished turn (Money Guy's budget review) is a report too.
  assert.deepEqual(needsYou(s).map((n) => `${n.kind} ${n.threadId}`).sort(), ["approval a2", "question b2", "failure c1", "report a3", "report h2"].sort());
  assert.deepEqual(needsYou(s).slice(0, 3).map((n) => `${n.kind} ${n.threadId}`), ["approval a2", "question b2", "failure c1"]);
  // A plan waiting for approval goes before failures and reports.
  const env = s.envs.mini;
  useGame.setState({ envs: { ...s.envs, mini: { ...env, threads: { ...env.threads, a3: { ...env.threads.a3, interactionMode: "plan" } } } } });
  assert.deepEqual(needsYou(useGame.getState()).map((n) => n.kind), ["approval", "question", "plan", "failure", "report"]);
});

test("seen failures and reports stop needing you, and every count agrees", () => {
  loadDemoFleet();
  const s = useGame.getState();
  useGame.setState({ readReports: { "wes:c1": s.envs.wes.threads.c1.latestTurn!.turnId } });
  const needs = needsYou(useGame.getState());
  assert.ok(!needs.some((n) => n.threadId === "c1"), "a dismissed failure is gone");
  const counts = needsYouCounts(needs), fleet = fleetCounts(useGame.getState().envs, useGame.getState().readReports);
  assert.equal(counts.failure, fleet.failed);
  assert.equal(counts.report + counts.plan, fleet.reports);
  assert.equal(counts.approval + counts.question, fleet.waiting);
});

test("a notification link opens the decision", () => {
  assert.deepEqual(parseHash("#decide/mini/t%201"), { kind: "unit", envId: "mini", threadId: "t 1", decide: true });
  assert.deepEqual(parseHash("#crew/mini/t1"), { kind: "unit", envId: "mini", threadId: "t1" });
});
