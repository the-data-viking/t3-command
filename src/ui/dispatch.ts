// Receipts for a squad order: where it stands with each crew member it went to, read from their
// live thread. A new turn since the order went out means it reached them; that turn's state says
// what they did with it. Pure over the store, so every device shows the same from the same fleet.

import { DISPATCH_START_MS, type Dispatch, type DispatchMember, type MissionInfo } from "../../shared/dispatches";
import type { EnvWorld, ThreadDetail } from "../store";
import { unitState } from "../t3/derive";
import { fetchJson } from "../t3/environment";

export type ReceiptStatus = "unsent" | "queued" | "undelivered" | "sent" | "unstarted" | "working" | "needs-you" | "reported" | "failed" | "stopped" | "superseded" | "gone";

export const RECEIPT: Record<ReceiptStatus, { mark: string; label: string; done: boolean }> = {
  unsent: { mark: "✕", label: "didn't send", done: true },
  queued: { mark: "…", label: "queued for after its turn", done: false },
  undelivered: { mark: "✕", label: "follow-up not sent", done: true },
  sent: { mark: "…", label: "sent, not started", done: false },
  unstarted: { mark: "✕", label: "didn't start", done: true },
  working: { mark: "▶", label: "working on it", done: false },
  "needs-you": { mark: "▲", label: "needs you", done: false },
  reported: { mark: "✓", label: "reported", done: true },
  failed: { mark: "✕", label: "turn failed", done: true },
  stopped: { mark: "■", label: "interrupted", done: true },
  superseded: { mark: "–", label: "a later turn took over", done: true },
  gone: { mark: "–", label: "no longer aboard", done: true },
};

/** `sentAt`: when the order went out; a sent order with no turn of its own after 3 minutes didn't start. */
export function receiptOf(m: DispatchMember, envs: Record<string, EnvWorld>, sentAt = Date.now(), now = Date.now()): ReceiptStatus {
  if (m.how === "failed") return "unsent";
  // The server marks a queued member whose follow-up went unsent; a later turn isn't this order's.
  if (m.dropped) return "undelivered";
  // The order's own turn, as the server pinned it and saw it end: a later turn doesn't rewrite it.
  if (m.result) return m.result === "completed" ? "reported" : m.result === "error" ? "failed" : m.result === "interrupted" ? "stopped" : "superseded";
  const thread = envs[m.envId]?.threads[m.threadId];
  if (!thread || thread.archivedAt) return "gone";
  const turn = thread.latestTurn;
  if (m.turnId && turn && turn.turnId !== m.turnId) return "superseded";
  // Not reached yet. A queued one stays "queued" in the gap between its follow-up going out and
  // the new turn showing up (the follow-up leaves the queue first).
  if (!turn || turn.turnId === m.baseTurnId) return m.how !== "sent" ? "queued" : now - sentAt > DISPATCH_START_MS ? "unstarted" : "sent";
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

export function progressOf(d: Dispatch, envs: Record<string, EnvWorld>): DispatchProgress {
  const receipts = d.members.map((member) => ({ member, status: receiptOf(member, envs, d.at) }));
  const count = (pred: (s: ReceiptStatus) => boolean) => receipts.filter((r) => pred(r.status)).length;
  return {
    receipts,
    done: count((s) => RECEIPT[s].done),
    reported: count((s) => s === "reported"),
    trouble: count((s) => s === "unsent" || s === "undelivered" || s === "unstarted" || s === "failed"),
    needsYou: count((s) => s === "needs-you"),
    total: receipts.length,
  };
}

/** The order's first line (a mission's name, after ⚑: ◆ means a question), short enough for a row. */
export function dispatchTitle(d: Dispatch, max = 80): string {
  const line = d.mission ? `⚑ ${d.mission.name}${d.round ? ` · round ${d.round}` : ""}` : d.text.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** `missionId`: this is the next round of that mission. */
export function recordDispatch(text: string, members: DispatchMember[], mission?: MissionInfo, missionId?: string): Promise<Dispatch> {
  return fetchJson<Dispatch>("/api/dispatches", { method: "POST", body: JSON.stringify({ text, members, ...(mission ? { mission } : {}), ...(missionId ? { round: { missionId } } : {}) }) });
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
export function replyOf(status: ReceiptStatus, thread: EnvWorld["threads"][string] | undefined, detail: ThreadDetail | undefined, member?: DispatchMember): string | undefined {
  if (!thread || !detail || status === "unsent" || status === "undelivered" || status === "sent" || status === "unstarted" || status === "queued" || status === "gone") return undefined;
  // The order's own turn when the server has pinned it; the latest otherwise (it hasn't moved on yet).
  const turnId = member?.turnId ?? (status === "superseded" ? undefined : thread.latestTurn?.turnId);
  if (!turnId) return undefined;
  return [...detail.thread.messages].reverse().find((m) => m.role === "assistant" && m.turnId === turnId && m.text.trim())?.text;
}
