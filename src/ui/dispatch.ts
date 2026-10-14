// Receipts for a squad order: where it stands with each crew member it went to, read from their
// live thread. A new turn since the order went out means it reached them; that turn's state says
// what they did with it. Pure over the store, so every device shows the same from the same fleet.

import type { Dispatch, DispatchMember, MissionInfo } from "../../shared/dispatches";
import type { FollowUpsView } from "../../shared/followups";
import type { EnvWorld, ThreadDetail } from "../store";
import { unitState } from "../t3/derive";
import { followUpFor } from "../t3/followups";
import { fetchJson } from "../t3/environment";

export type ReceiptStatus = "unsent" | "queued" | "undelivered" | "sent" | "working" | "needs-you" | "reported" | "failed" | "stopped" | "gone";

export const RECEIPT: Record<ReceiptStatus, { mark: string; label: string; done: boolean }> = {
  unsent: { mark: "✕", label: "didn't send", done: true },
  queued: { mark: "…", label: "queued for after its turn", done: false },
  undelivered: { mark: "✕", label: "follow-up not sent", done: true },
  sent: { mark: "…", label: "sent, not started", done: false },
  working: { mark: "▶", label: "working on it", done: false },
  "needs-you": { mark: "▲", label: "needs you", done: false },
  reported: { mark: "✓", label: "reported", done: true },
  failed: { mark: "✕", label: "turn failed", done: true },
  stopped: { mark: "■", label: "interrupted", done: true },
  gone: { mark: "–", label: "no longer aboard", done: true },
};

export function receiptOf(m: DispatchMember, envs: Record<string, EnvWorld>, followUps: FollowUpsView): ReceiptStatus {
  if (m.how === "failed") return "unsent";
  const thread = envs[m.envId]?.threads[m.threadId];
  if (!thread || thread.archivedAt) return "gone";
  const turn = thread.latestTurn;
  if (!turn || turn.turnId === m.baseTurnId) {
    if (m.how === "sent") return "sent";
    return followUpFor(followUps, m.envId, m.threadId) ? "queued" : "undelivered";
  }
  const state = unitState(thread);
  if (state === "alert" || state === "question") return "needs-you";
  if (turn.state === "running") return "working";
  if (turn.state === "completed") return "reported";
  if (turn.state === "error") return "failed";
  return "stopped";
}

export interface DispatchProgress {
  receipts: Array<{ member: DispatchMember; status: ReceiptStatus }>;
  /** Members whose part is over, one way or another. */
  done: number;
  reported: number;
  /** Members it went wrong for: never sent, never delivered, or the turn failed. */
  trouble: number;
  needsYou: number;
  total: number;
}

export function progressOf(d: Dispatch, envs: Record<string, EnvWorld>, followUps: FollowUpsView): DispatchProgress {
  const receipts = d.members.map((member) => ({ member, status: receiptOf(member, envs, followUps) }));
  const count = (pred: (s: ReceiptStatus) => boolean) => receipts.filter((r) => pred(r.status)).length;
  return {
    receipts,
    done: count((s) => RECEIPT[s].done),
    reported: count((s) => s === "reported"),
    trouble: count((s) => s === "unsent" || s === "undelivered" || s === "failed"),
    needsYou: count((s) => s === "needs-you"),
    total: receipts.length,
  };
}

/** The order's first line (a mission's name), short enough for a row. */
export function dispatchTitle(d: Dispatch, max = 80): string {
  const line = d.mission ? `◆ ${d.mission.name}` : d.text.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function recordDispatch(text: string, members: DispatchMember[], mission?: MissionInfo): Promise<Dispatch> {
  return fetchJson<Dispatch>("/api/dispatches", { method: "POST", body: JSON.stringify({ text, members, ...(mission ? { mission } : {}) }) });
}

export function updateDispatch(id: string, members: DispatchMember[]): Promise<Dispatch> {
  return fetchJson<Dispatch>("/api/dispatches/update", { method: "POST", body: JSON.stringify({ id, members }) });
}

export async function closeDispatch(id: string): Promise<void> {
  await fetchJson("/api/dispatches/close", { method: "POST", body: JSON.stringify({ id }) });
}

/**
 * What a crew member said back: their last message in the turn the order started (or the latest
 * turn since, for a standing order). Undefined until the order reached them and they've written.
 */
export function replyOf(status: ReceiptStatus, thread: EnvWorld["threads"][string] | undefined, detail: ThreadDetail | undefined): string | undefined {
  if (!thread || !detail || status === "unsent" || status === "undelivered" || status === "sent" || status === "queued" || status === "gone") return undefined;
  const turnId = thread.latestTurn?.turnId;
  return [...detail.thread.messages].reverse().find((m) => m.role === "assistant" && m.turnId === turnId && m.text.trim())?.text;
}
