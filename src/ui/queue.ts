// The queue of crew waiting on you: who has waited longest, and what each one is asking. The
// roster, Space and the event card all use this order, so the agent blocked longest is first.

import { pendingRequests } from "../t3/derive";
import { requestQuestions } from "../t3/questions";
import type { OrchestrationThread, PendingRequest, ThreadShell } from "../t3/types";
import type { EnvWorld } from "../store";
import { allUnits } from "./util";

/** When a crew member started waiting: their oldest open request, or (before it loads) their last update. */
export function waitingSince(thread: ThreadShell, detail: OrchestrationThread | undefined): number {
  const dates = (detail ? pendingRequests(detail) : []).map((r) => Date.parse(r.activity.createdAt)).filter(Number.isFinite);
  return dates.length ? Math.min(...dates) : Date.parse(thread.updatedAt) || 0;
}

/** Longest-waiting first; ties by key so the order is stable. */
export function byWait<T extends { since: number; key: string }>(a: T, b: T): number {
  return a.since - b.since || a.key.localeCompare(b.key);
}

const VERB: Record<string, string> = {
  command: "run",
  "file-change": "edit files",
  "file-read": "read files",
  "mcp-elicitation": "use a tool",
  permission: "proceed",
};

/**
 * One line saying what a request asks, for a roster row or a notice: "▲ run pnpm migrate",
 * "▲ edit files", "◆ Which environment?". Literal: the command or question itself, not flavour.
 */
export function requestSummary(request: PendingRequest | undefined, max = 60): string | undefined {
  if (!request) return undefined;
  const p = request.activity.payload ?? {};
  let text: string;
  if (request.kind === "approval") {
    const verb = VERB[String(p.requestKind)] ?? "proceed";
    const detail = typeof p.detail === "string" ? p.detail.split("\n")[0].trim() : "";
    text = `▲ ${verb}${detail ? ` ${detail}` : ""}`;
  } else {
    const first = requestQuestions(p)[0];
    text = `◆ ${first?.question ?? "Has a question"}`;
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Every crew member waiting on you (approval or question), longest wait first. */
export function waitQueue(envs: Record<string, EnvWorld>, details: Record<string, { thread: OrchestrationThread } | undefined>): Array<{ envId: string; threadId: string }> {
  return allUnits(envs)
    .filter((u) => u.state === "alert" || u.state === "question")
    .map((u) => ({ u, key: `${u.envId}:${u.thread.id}`, since: waitingSince(u.thread, details[`${u.envId}:${u.thread.id}`]?.thread) }))
    .sort(byWait)
    .map(({ u }) => ({ envId: u.envId, threadId: u.thread.id }));
}
