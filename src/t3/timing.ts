import { pendingRequests } from "./derive";
import type { OrchestrationThread, ThreadShell } from "./types";

export function threadTimes(thread: ThreadShell, detail: OrchestrationThread | undefined, now: number) {
  const waiting = thread.hasPendingApprovals || thread.hasPendingUserInput;
  const requests = waiting && detail ? pendingRequests(detail).filter((r) =>
    r.kind === "approval" ? thread.hasPendingApprovals : thread.hasPendingUserInput) : [];
  const dates = requests.map((r) => Date.parse(r.activity.createdAt)).filter(Number.isFinite);
  const waitingSince = dates.length ? Math.min(...dates) : undefined;
  const turn = thread.latestTurn;
  const start = Date.parse(turn?.startedAt ?? "");
  const end = turn?.state === "running" ? now : Date.parse(turn?.completedAt ?? "");
  return { waitingMs: waitingSince === undefined ? undefined : Math.max(0, now - waitingSince),
    turnMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined,
    running: turn?.state === "running", waiting };
}

export function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
