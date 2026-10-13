// Working the queue: one run through everything waiting on you — approvals and questions first,
// longest wait first, then unread reports oldest first — one card at a time, ending on a "queue
// clear" card. Anything that starts waiting on you mid-run goes before the remaining reports.

import { openEvent, useGame } from "../store";
import { pendingRequests } from "../t3/derive";
import { openDebrief, unreadReports } from "./debrief";
import { waitQueue } from "./queue";

type Item = { envId: string; threadId: string };
const key = (i: Item) => `${i.envId}:${i.threadId}`;

/** Approvals and questions plus unread reports: what a run would go through. */
export function queueLength(): number {
  const s = useGame.getState();
  return waitQueue(s.envs, s.details).length + unreadReports().length;
}

export function startQueue(): void {
  useGame.setState({ queueRun: { seen: [] }, queueClear: null });
  if (!advanceQueue(null)) finishQueue();
}

/** Open the next card in the run, never `skip` (the one just handled). False when nothing is left. */
export function advanceQueue(skip: string | null): boolean {
  const s = useGame.getState();
  const run = s.queueRun;
  if (!run) return false;
  const seen = (i: Item) => useGame.setState((st) => (st.queueRun && !st.queueRun.seen.includes(key(i)) ? { queueRun: { seen: [...st.queueRun.seen, key(i)] } } : {}));
  // One already handled in this run whose request is answered but whose summary still says
  // "waiting" (the shell update lags the decision) is not opened again.
  const answered = (i: Item) => {
    const detail = s.details[key(i)];
    return run.seen.includes(key(i)) && !!detail?.synced && pendingRequests(detail.thread).length === 0;
  };
  const waiting = waitQueue(s.envs, s.details).find((i) => key(i) !== skip && !answered(i));
  if (waiting) { seen(waiting); openDebrief(null); openEvent(waiting); return true; }
  const report = unreadReports().find((i) => key(i) !== skip);
  if (report) { seen(report); openEvent(null); openDebrief(report); return true; }
  return false;
}

/** The run is done: close its cards and show how many it went through. */
export function finishQueue(): void {
  const run = useGame.getState().queueRun;
  openEvent(null);
  openDebrief(null);
  useGame.setState({ queueRun: null, queueClear: run ? { handled: run.seen.length, at: Date.now() } : null });
}

/** You stepped out of the run (Esc, or went to a crew log): leave everything as it is. */
export function stopQueue(): void {
  if (useGame.getState().queueRun) useGame.setState({ queueRun: null });
}
