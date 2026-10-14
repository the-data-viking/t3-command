// A working turn that may be spinning, as something that needs you: the same command failing again
// and again, or an hour with no file change (pulse.ts). Each sign has its own id, so "it's fine"
// waves off that sign only; a different command failing, or another hour gone by, asks again.

import type { OrchestrationThread, ThreadShell } from "../t3/types";
import { elapsed } from "../t3/timing";
import { NO_CHANGE_MS, pulseOf } from "./pulse";

export interface SpinSign {
  /** "turnId:fail:command" or "turnId:quiet:hours". */
  sign: string;
  /** The sign in a few words ("npm test failed 5×", "no file changes in 1h 20m"). */
  why: string;
}

export function spinSign(thread: ThreadShell, detail: OrchestrationThread | undefined, now: number): SpinSign | undefined {
  const turn = thread.latestTurn;
  if (!turn || turn.state !== "running" || !detail) return undefined;
  const p = pulseOf(detail, now);
  if (p?.repeatFail) return { sign: `${turn.turnId}:fail:${p.repeatFail.command}`, why: `${p.repeatFail.command} failed ${p.repeatFail.count}×` };
  if (p?.noChangeMs) return { sign: `${turn.turnId}:quiet:${Math.floor(p.noChangeMs / NO_CHANGE_MS)}`, why: `no file changes in ${elapsed(p.noChangeMs)}` };
  return undefined;
}

/** The sign, unless you've already said this one is fine. */
export function openSpinSign(thread: ThreadShell, detail: OrchestrationThread | undefined, ok: string[] | undefined, now: number): SpinSign | undefined {
  const s = spinSign(thread, detail, now);
  return s && !ok?.includes(s.sign) ? s : undefined;
}

/** What a halted crew member is asked, so they say what's in the way rather than start again. */
export function blockedOrder(why: string): string {
  return `I halted your turn because it looked stuck (${why}). What's blocking you? Tell me what you tried and what you need from me, and don't start new work until I answer.`;
}
