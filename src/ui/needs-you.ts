// One answer to "what needs me?", used by every count and list that asks it: the top bar, the
// roster, the mission board, the queue run and the tab title. In order: approvals and questions
// (an agent is blocked; longest wait first), plans waiting for approval, failed turns, turns that
// may be stuck (stuck.ts), then reports, Hermes operators' included. A failure or report you've
// seen (marked read, or dismissed) stops needing you until that crew member's next turn; a spin
// sign you've let run, until a new sign.

import type { GameState } from "../store";
import { allUnits, reportRead } from "./util";
import { byWait, waitingSince } from "./queue";
import { openSpinSign } from "./stuck";

export type NeedKind = "approval" | "question" | "plan" | "failure" | "stuck" | "report";

export interface Need { envId: string; threadId: string; kind: NeedKind }

type Inputs = Pick<GameState, "envs" | "readReports"> & Partial<Pick<GameState, "details" | "stuckOk">>;

/** Everything that needs you, in the order to handle it. */
export function needsYou(state: Inputs, now = Date.now()): Need[] {
  const blocked: Array<Need & { since: number; key: string }> = [];
  const rest: Array<Need & { at: string }> = [];
  for (const u of allUnits(state.envs)) {
    const key = `${u.envId}:${u.thread.id}`;
    if (u.state === "alert" || u.state === "question") {
      blocked.push({ envId: u.envId, threadId: u.thread.id, kind: u.state === "alert" ? "approval" : "question", key,
        since: waitingSince(u.thread, state.details?.[key]?.thread) });
      continue;
    }
    if (!u.thread.latestTurn) continue;
    if (u.state === "working") {
      if (openSpinSign(u.thread, state.details?.[key]?.thread, state.stuckOk?.[key], now))
        rest.push({ envId: u.envId, threadId: u.thread.id, kind: "stuck", at: u.thread.latestTurn.startedAt ?? u.thread.latestTurn.requestedAt });
      continue;
    }
    if (reportRead(state.readReports, u.envId, u.thread)) continue;
    const at = u.thread.latestTurn.completedAt ?? u.thread.updatedAt;
    // A Hermes operator's finished turn is a report to read (it has no plan mode).
    const hermes = state.envs[u.envId]?.summary.kind === "hermes";
    if (u.state === "done") rest.push({ envId: u.envId, threadId: u.thread.id, kind: !hermes && u.thread.interactionMode === "plan" ? "plan" : "report", at });
    else if (u.state === "error") rest.push({ envId: u.envId, threadId: u.thread.id, kind: "failure", at });
  }
  const rank: Record<NeedKind, number> = { approval: 0, question: 0, plan: 1, failure: 2, stuck: 3, report: 4 };
  return [
    ...blocked.sort(byWait).map(({ envId, threadId, kind }) => ({ envId, threadId, kind })),
    ...rest.sort((a, b) => rank[a.kind] - rank[b.kind] || a.at.localeCompare(b.at)).map(({ envId, threadId, kind }) => ({ envId, threadId, kind })),
  ];
}

/** How many of each kind, for the top bar. */
export function needsYouCounts(needs: Need[]): Record<NeedKind, number> & { total: number } {
  const c = { approval: 0, question: 0, plan: 0, failure: 0, stuck: 0, report: 0, total: needs.length };
  for (const n of needs) c[n.kind]++;
  return c;
}
