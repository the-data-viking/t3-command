// Follow-ups from the browser: queue an order for a busy crew member (the Command server sends it
// when their turn ends), cancel it, or pause them all.

import type { FollowUp, FollowUpsView } from "../../shared/followups";
import { useGame } from "../store";
import { fetchJson } from "./environment";

export function queueFollowUp(envId: string, threadId: string, text: string): Promise<FollowUp> {
  return fetchJson<FollowUp>("/api/followups", { method: "POST", body: JSON.stringify({ envId, threadId, text }) });
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
