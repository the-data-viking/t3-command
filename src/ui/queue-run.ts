// Working the queue: one run through everything that needs you (needs-you.ts) — approvals and
// questions first, longest wait first, then plans, failures and reports — one card at a time,
// ending on a "queue clear" card. Anything that starts waiting on you mid-run goes next.

import { openEvent, useGame } from "../store";
import { pendingRequests } from "../t3/derive";
import { openDebrief } from "./debrief";
import { needsYou } from "./needs-you";

type Item = { envId: string; threadId: string };
const key = (i: Item) => `${i.envId}:${i.threadId}`;

/** Everything that needs you: what a run would go through (less what it skipped). */
export function queueLength(): number {
  const s = useGame.getState();
  const skipped = new Set(s.queueRun?.skipped ?? []);
  return needsYou(s).filter((i) => !skipped.has(key(i))).length;
}

export function startQueue(): void {
  useGame.setState({ queueRun: { seen: [], skipped: [] }, queueClear: null });
  if (!advanceQueue(null)) finishQueue();
}

/** Open the next card in the run, never `skip` (the one just handled). False when nothing is left. */
export function advanceQueue(skip: string | null): boolean {
  const s = useGame.getState();
  const run = s.queueRun;
  if (!run) return false;
  const seen = (i: Item) => useGame.setState((st) => (st.queueRun && !st.queueRun.seen.includes(key(i)) ? { queueRun: { ...st.queueRun, seen: [...st.queueRun.seen, key(i)] } } : {}));
  // One already handled in this run whose request is answered but whose summary still says
  // "waiting" (the shell update lags the decision) is not opened again.
  const answered = (i: Item) => {
    const detail = s.details[key(i)];
    return run.seen.includes(key(i)) && !!detail?.synced && pendingRequests(detail.thread).length === 0;
  };
  const passed = (i: Item) => key(i) === skip || run.skipped.includes(key(i));
  const next = needsYou(s).find((i) => !passed(i) && !answered(i));
  if (!next) return false;
  seen(next);
  // Requests open the event card; plans, failures and reports open the report card in their variant.
  if (next.kind === "approval" || next.kind === "question") openEvent(next);
  else openDebrief(next);
  return true;
}

/** The run is done: close its cards and show how many it went through. */
export function finishQueue(): void {
  const run = useGame.getState().queueRun;
  openEvent(null);
  openDebrief(null);
  useGame.setState({ queueRun: null, queueClear: run ? { handled: run.seen.length - run.skipped.length, skipped: run.skipped.length, at: Date.now() } : null });
}

/** Leave this card for later: the run moves on and won't bring it back; it stays waiting. */
export function skipInQueue(current: Item): void {
  const run = useGame.getState().queueRun;
  if (!run) return;
  useGame.setState({ queueRun: { ...run, skipped: [...run.skipped, key(current)] } });
  if (!advanceQueue(key(current))) finishQueue();
}

/** You stepped out of the run (Esc, or went to a crew log): leave everything as it is. */
export function stopQueue(): void {
  if (useGame.getState().queueRun) useGame.setState({ queueRun: null });
}
