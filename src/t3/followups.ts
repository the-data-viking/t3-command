// Follow-ups from the browser: queue an order for a busy crew member (the Command server sends it
// when their turn ends), cancel it, or pause them all.

import type { FollowUp, FollowUpsView } from "../../shared/followups";
import { useGame } from "../store";
import { fetchJson } from "./environment";

/**
 * Queue an order for after a busy crew member's turn. `times` makes it a standing order; with
 * `startedAfter` (the turn that was latest before you sent it now), it repeats after that send.
 */
export function queueFollowUp(envId: string, threadId: string, text: string, opts: { times?: number; startedAfter?: string | null } = {}): Promise<FollowUp> {
  return fetchJson<FollowUp>("/api/followups", { method: "POST", body: JSON.stringify({ envId, threadId, text, ...opts }) });
}

/** "Standing order · 2 of 3 to go" or "Follow-up", for where a queued one is shown. */
export function followUpLabel(f: FollowUp): string {
  return f.total ? `Standing order · ${f.left} of ${f.total} to go` : "Follow-up";
}

export async function cancelFollowUp(id: string): Promise<void> {
  useGame.setState({ followUps: await fetchJson<FollowUpsView>("/api/followups/cancel", { method: "POST", body: JSON.stringify({ id }) }) });
}

export async function pauseFollowUps(paused: boolean): Promise<void> {
  useGame.setState({ followUps: await fetchJson<FollowUpsView>("/api/followups/pause", { method: "PUT", body: JSON.stringify({ paused }) }) });
}

/** The follow-up queued for a crew member, if any. */
export function followUpFor(view: FollowUpsView, envId: string, threadId: string): FollowUp | undefined {
  return view.queued.find((f) => f.envId === envId && f.threadId === threadId);
}
