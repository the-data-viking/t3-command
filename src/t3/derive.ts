import type { OrchestrationThread, PendingRequest, ThreadShell } from "./types.ts";

/** What a worker unit is doing, in game terms. Ordered roughly by how urgently it wants your attention. */
export type UnitState =
  | "alert" // waiting for a tool-use approval
  | "question" // waiting for an answer to a question
  | "working" // a turn is running, or background agents are
  | "monitoring" // the turn is over, but watch loops (monitors, background shells) are still live
  | "error" // last turn or session failed
  | "done" // finished a turn and hasn't been reviewed (settled) yet
  | "idle" // nothing to report
  | "sleeping"; // settled or snoozed

/**
 * Imported CLI session history: a transcript that never ran as a T3 turn. T3 can import old
 * Claude/Codex sessions, and resumed/forked sessions import as near-duplicates. These live in a
 * project's archive building instead of the workforce.
 */
export function isHistory(t: ThreadShell): boolean {
  // Canonical Hermes chats are writable even before their first Command turn.
  return !t.hermesBotChat && !isNativeSubagent(t) && t.latestTurn === null && t.session === null && t.latestUserMessageAt === null;
}

export function isNativeSubagent(t: ThreadShell): boolean {
  return t.creationSource === "provider" && t.lineage?.relationshipToParent === "subagent";
}

export function isSettled(t: ThreadShell): boolean {
  if (!t.settledAt) return false;
  return !t.unsettledAt || Date.parse(t.settledAt) >= Date.parse(t.unsettledAt);
}

/**
 * Busy as the Command server counts it for a follow-up: a turn running, or waiting on you. (A
 * crew member working only in the background has no turn to wait for: an order goes now.)
 */
export function turnBusy(t: ThreadShell): boolean {
  return t.latestTurn?.state === "running" || t.hasPendingApprovals || t.hasPendingUserInput;
}

export function unitState(t: ThreadShell): UnitState {
  if (t.hasPendingApprovals) return "alert";
  if (t.hasPendingUserInput) return "question";
  const status = t.session?.status;
  if (status === "running" || status === "starting" || t.latestTurn?.state === "running") return "working";
  if (t.backgroundLiveness === "working") return "working";
  if (t.backgroundLiveness === "monitoring") return "monitoring";
  const nativeStatus = t.nativeSubagent?.status;
  if (nativeStatus === "pending" || nativeStatus === "running" || nativeStatus === "waiting") return "working";
  if (isSettled(t) || (t.snoozedUntil && Date.parse(t.snoozedUntil) > Date.now())) return "sleeping";
  if (status === "error" || t.latestTurn?.state === "error" || nativeStatus === "failed") return "error";
  if (t.latestTurn?.state === "completed" || nativeStatus === "completed") return "done";
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
