import assert from "node:assert/strict";
import test from "node:test";
import { loadDemoFleet } from "../demo";
import { useGame } from "../store";
import { advanceQueue, skipInQueue, startQueue, stopQueue } from "./queue-run";

/** Answer a crew member's open request in its loaded details (its summary still says waiting). */
const answer = (key: string) => {
  const st = useGame.getState();
  const d = st.details[key]!;
  useGame.setState({ details: { ...st.details, [key]: { ...d, thread: { ...d.thread, activities: d.thread.activities.map((a) => ({ ...a, kind: a.kind.replace("requested", "resolved") })) } } } });
};
const open = () => { const s = useGame.getState(); return s.event ? `event ${s.event.envId}:${s.event.threadId}` : s.debrief ? `report ${s.debrief.envId}:${s.debrief.threadId}` : "none"; };

test("a run goes through approvals and questions, longest wait first, then failures and reports, then ends clear", () => {
  loadDemoFleet();
  startQueue();
  assert.equal(open(), "event mini:a2", "the approval waiting 22 minutes comes first");
  answer("mini:a2");
  assert.ok(advanceQueue("mini:a2"));
  assert.equal(open(), "event agent1:b2");
  answer("agent1:b2");
  assert.ok(advanceQueue("agent1:b2"));
  assert.equal(open(), "report wes:c1", "answered requests aren't reopened while their summaries lag; a failed turn comes next");
  useGame.setState((s) => ({ readReports: { ...s.readReports, "wes:c1": s.envs.wes.threads.c1.latestTurn!.turnId } }));
  assert.ok(advanceQueue("wes:c1"));
  assert.equal(open(), "report mini:a3");
  useGame.setState((s) => ({ readReports: { ...s.readReports, "mini:a3": s.envs.mini.threads.a3.latestTurn!.turnId } }));
  assert.equal(advanceQueue("mini:a3"), false);
});

test("stepping out ends the run without touching anything", () => {
  loadDemoFleet();
  startQueue();
  stopQueue();
  assert.equal(useGame.getState().queueRun, null);
  assert.equal(advanceQueue(null), false);
});

test("leaving a card for later moves on without it and doesn't count it as handled", () => {
  loadDemoFleet();
  useGame.setState({ readReports: {} });
  startQueue();
  assert.equal(open(), "event mini:a2");
  skipInQueue({ envId: "mini", threadId: "a2" });
  assert.equal(open(), "event agent1:b2", "the skipped approval stays waiting but the run moves on");
  answer("agent1:b2");
  assert.ok(advanceQueue("agent1:b2"));
  assert.equal(open(), "report wes:c1", "the skipped approval isn't brought back");
  skipInQueue({ envId: "wes", threadId: "c1" });
  assert.equal(open(), "report mini:a3");
  skipInQueue({ envId: "mini", threadId: "a3" });
  const clear = useGame.getState().queueClear;
  assert.deepEqual([clear?.handled, clear?.skipped], [1, 3]);
});

test("one card at a time: a request card replaces a report card and back", async () => {
  const { openEvent } = await import("../store");
  const { openDebrief } = await import("./debrief");
  openDebrief({ envId: "mini", threadId: "a3" });
  openEvent({ envId: "mini", threadId: "a2" });
  assert.equal(useGame.getState().debrief, null);
  openDebrief({ envId: "mini", threadId: "a3" });
  assert.equal(useGame.getState().event, null);
});
