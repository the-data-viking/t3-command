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

test("a working turn that may be stuck needs you, until you say this sign is fine", async () => {
  const { markStuckOk } = await import("../store");
  loadDemoFleet();
  const s = useGame.getState();
  const [envId, thread] = Object.entries(s.envs).flatMap(([id, e]) => Object.values(e.threads).map((t) => [id, t] as const))
    .find(([, t]) => t.latestTurn?.state === "running" && !t.hasPendingApprovals && !t.hasPendingUserInput)!;
  const turnId = thread.latestTurn!.turnId;
  const failing = (n: number) => ({ id: `f${n}`, turnId, kind: "tool.completed", createdAt: new Date().toISOString(), summary: "npm test",
    payload: { toolCallId: `call${n}`, status: "failed", detail: "npm test" } });
  const detail = { synced: true, thread: { ...thread, latestTurn: thread.latestTurn, activities: [failing(1), failing(2), failing(3)], messages: [], checkpoints: [] } };
  useGame.setState({ readReports: {}, stuckOk: {}, details: { ...s.details, [`${envId}:${thread.id}`]: detail as never } });
  const stuck = needsYou(useGame.getState()).find((n) => n.threadId === thread.id);
  assert.equal(stuck?.kind, "stuck");
  // After failures, before reports.
  const kinds = needsYou(useGame.getState()).map((n) => n.kind);
  assert.ok(kinds.indexOf("stuck") > kinds.lastIndexOf("failure") && kinds.indexOf("stuck") < kinds.indexOf("report"));
  markStuckOk(envId, thread.id, `${turnId}:fail:npm test`);
  assert.ok(!needsYou(useGame.getState()).some((n) => n.threadId === thread.id), "waved off");
});

test("waiting on a long tool or working without edits does not enter Needs you as stuck", () => {
  loadDemoFleet();
  const s = useGame.getState();
  const [envId, thread] = Object.entries(s.envs).flatMap(([id, e]) => Object.values(e.threads).map((t) => [id, t] as const))
    .find(([, t]) => t.latestTurn?.state === "running" && !t.hasPendingApprovals && !t.hasPendingUserInput)!;
  const now = Date.now();
  const turnId = thread.latestTurn!.turnId;
  const key = `${envId}:${thread.id}`;
  const failures = [3, 2, 1].map((min) => ({ id: `fail-${min}`, turnId, kind: "tool.completed", createdAt: new Date(now - min * 60_000).toISOString(), summary: "npm test", payload: { exitCode: 1, detail: "npm test" } }));
  const started = { id: "script", turnId, kind: "tool.started", createdAt: new Date(now).toISOString(), summary: "npm test", payload: { status: "running", detail: "npm test" } };
  for (const activities of [[], [started], [...failures, started]]) {
    const detail = { ...thread, activities, messages: [], checkpoints: [] };
    useGame.setState({ details: { ...s.details, [key]: { synced: true, thread: detail as never } }, stuckOk: {} });
    assert.ok(!needsYou(useGame.getState(), now + 2 * 3_600_000).some((n) => n.threadId === thread.id && n.kind === "stuck"));
    assert.ok(!needsYou(useGame.getState(), now).some((n) => n.threadId === thread.id && n.kind === "stuck"));
  }
});
