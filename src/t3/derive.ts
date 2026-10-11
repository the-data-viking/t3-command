import type { OrchestrationThread, PendingRequest, ThreadShell } from "./types";

/** What a worker unit is doing, in game terms. Ordered roughly by how urgently it wants your attention. */
export type UnitState =
  | "alert" // waiting for a tool-use approval
  | "question" // waiting for an answer to a question
  | "working" // a turn is running
  | "error" // last turn or session failed
  | "done" // finished a turn and hasn't been reviewed (settled) yet
  | "idle" // nothing to report
  | "sleeping"; // settled or snoozed

export function isSettled(t: ThreadShell): boolean {
  if (!t.settledAt) return false;
  return !t.unsettledAt || Date.parse(t.settledAt) >= Date.parse(t.unsettledAt);
}

export function unitState(t: ThreadShell): UnitState {
  if (t.hasPendingApprovals) return "alert";
  if (t.hasPendingUserInput) return "question";
  const status = t.session?.status;
  if (status === "running" || status === "starting" || t.latestTurn?.state === "running") return "working";
  if (isSettled(t) || (t.snoozedUntil && Date.parse(t.snoozedUntil) > Date.now())) return "sleeping";
  if (status === "error" || t.latestTurn?.state === "error") return "error";
  if (t.latestTurn?.state === "completed") return "done";
  return "idle";
}

/** Approvals and questions the agent is still waiting on, oldest first. */
export function pendingRequests(thread: OrchestrationThread): PendingRequest[] {
  const open = new Map<string, PendingRequest>();
  for (const activity of thread.activities) {
    const requestId = activity.payload?.requestId;
    if (typeof requestId !== "string") continue;
    switch (activity.kind) {
      case "approval.requested":
        open.set(requestId, { requestId, kind: "approval", activity });
        break;
      case "user-input.requested":
        open.set(requestId, { requestId, kind: "user-input", activity });
        break;
      case "approval.resolved":
      case "user-input.resolved":
        open.delete(requestId);
        break;
    }
  }
  return [...open.values()];
}
