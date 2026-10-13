// The report queue: unread reports in the order they finished, and the card that shows one.

import { useGame } from "../store";
import { allUnits, reportRead } from "./util";

/** Unread reports, oldest first: the next debrief after this one. */
export function unreadReports(): Array<{ envId: string; threadId: string }> {
  const { envs, readReports } = useGame.getState();
  return allUnits(envs)
    .filter((u) => u.state === "done" && u.thread.latestTurn && envs[u.envId]?.summary.kind !== "hermes" && !reportRead(readReports, u.envId, u.thread))
    .sort((a, b) => (a.thread.latestTurn?.completedAt ?? "").localeCompare(b.thread.latestTurn?.completedAt ?? ""))
    .map((u) => ({ envId: u.envId, threadId: u.thread.id }));
}

export function openDebrief(at: { envId: string; threadId: string } | null): void {
  useGame.setState({ debrief: at });
}
