// Turn-level telemetry from T3's own activity stream: the agent's plan, how a turn's time split
// between the agent and waiting on you, tokens processed, and turns that have gone quiet.
// Like telemetry.ts, nothing here is inferred beyond what T3 reports.

import { elapsed } from "./timing";
import type { Activity, OrchestrationThread, ThreadShell } from "./types";

export type PlanStatus = "pending" | "inProgress" | "completed";
export interface PlanStep { step: string; status: PlanStatus }

export interface Plan {
  turnId: string | null;
  steps: PlanStep[];
  explanation?: string;
  /** From the running turn (vs. the last plan of a finished one). */
  current: boolean;
  completed: number;
}

/** The latest plan the agent published (Claude tasks/todos, Codex plans, ACP plans). */
export function latestPlan(thread: OrchestrationThread): Plan | undefined {
  for (let i = thread.activities.length - 1; i >= 0; i--) {
    const a = thread.activities[i];
    if (a.kind !== "turn.plan.updated") continue;
    const raw = Array.isArray(a.payload?.plan) ? (a.payload.plan as Array<Record<string, unknown>>) : [];
    const steps = raw
      .filter((s) => typeof s.step === "string" && s.step.trim())
      .map((s): PlanStep => ({ step: String(s.step).trim(), status: s.status === "completed" || s.status === "inProgress" ? s.status : "pending" }));
    if (!steps.length) continue;
    const running = thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null;
    return {
      turnId: a.turnId,
      steps,
      explanation: typeof a.payload?.explanation === "string" ? a.payload.explanation : undefined,
      current: !!running && a.turnId === running,
      completed: steps.filter((s) => s.status === "completed").length,
    };
  }
  return undefined;
}

export interface TurnBreakdown {
  turnId: string;
  running: boolean;
  /** Wall time from start to end (or now). */
  totalMs: number;
  /** Time with an approval or question waiting on you. */
  waitingMs: number;
  agentMs: number;
  /** Tokens the provider reports processing during this turn (cached input included). */
  tokens?: number;
}

/** Overlapping waits count once: merge [start, end] intervals before summing. */
function mergedLength(intervals: Array<[number, number]>): number {
  let total = 0;
  let end = -Infinity;
  for (const [s, e] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (e <= end) continue;
    total += e - Math.max(s, end);
    end = e;
  }
  return total;
}

/** Codex reports a running total for the whole thread; Claude reports each turn's own total. */
const cumulativeTotals = (a: Activity) => a.payload?.lastInputTokens !== undefined || a.payload?.lastUsedTokens !== undefined;

function turnTokens(thread: OrchestrationThread, turnId: string): number | undefined {
  let previous: number | undefined;
  let current: Activity | undefined;
  for (const a of thread.activities) {
    if (a.kind !== "context-window.updated") continue;
    const total = Number(a.payload?.totalProcessedTokens);
    if (!Number.isFinite(total)) continue;
    if (a.turnId === turnId) current = a;
    else if (!current) previous = total;
  }
  if (!current) return undefined;
  const total = Number(current.payload!.totalProcessedTokens);
  return cumulativeTotals(current) && previous !== undefined && previous <= total ? total - previous : total;
}

export function turnBreakdown(thread: OrchestrationThread, now: number): TurnBreakdown | undefined {
  const turn = thread.latestTurn;
  const start = Date.parse(turn?.startedAt ?? "");
  if (!turn || !Number.isFinite(start)) return undefined;
  const running = turn.state === "running";
  const end = running ? now : Date.parse(turn.completedAt ?? "");
  if (!Number.isFinite(end)) return undefined;
  const opened = new Map<string, number>();
  const waits: Array<[number, number]> = [];
  for (const a of thread.activities) {
    const id = a.payload?.requestId;
    if (typeof id !== "string") continue;
    const at = Date.parse(a.createdAt);
    if (a.kind === "approval.requested" || a.kind === "user-input.requested") opened.set(id, at);
    else if ((a.kind === "approval.resolved" || a.kind === "user-input.resolved") && opened.has(id)) {
      waits.push([opened.get(id)!, at]);
      opened.delete(id);
    }
  }
  // Still open: waiting until now (or until the turn ended without an answer).
  for (const at of opened.values()) waits.push([at, end]);
  const inTurn = waits.map(([s, e]): [number, number] => [Math.max(s, start), Math.min(e, end)]).filter(([s, e]) => e > s);
  const totalMs = Math.max(0, end - start);
  const waitingMs = Math.min(totalMs, mergedLength(inTurn));
  return { turnId: turn.turnId, running, totalMs, waitingMs, agentMs: totalMs - waitingMs, tokens: turnTokens(thread, turn.turnId) };
}

export interface Compactions { count: number; last?: { beforeTokens: number; afterTokens: number; at: string } }

export function compactions(thread: OrchestrationThread): Compactions {
  const done = thread.activities.filter((a) => a.kind === "context-compaction" && a.payload?.state === "compacted");
  const last = done.at(-1);
  const before = Number(last?.payload?.beforeTokens), after = Number(last?.payload?.afterTokens);
  return { count: done.length, last: last && Number.isFinite(before) && Number.isFinite(after) ? { beforeTokens: before, afterTokens: after, at: last.createdAt } : undefined };
}

/** The last time anything happened on a followed thread (an activity or a message update). */
export function lastActivityAt(thread: OrchestrationThread): number | undefined {
  let last = -Infinity;
  for (const a of thread.activities) { const t = Date.parse(a.createdAt); if (t > last) last = t; }
  for (const m of thread.messages) { const t = Date.parse(m.updatedAt); if (t > last) last = t; }
  return Number.isFinite(last) ? last : undefined;
}

/** A running turn with nothing new from the agent for this long is called out. */
export const QUIET_MS = 10 * 60_000;

export type Quiet =
  /** No activity and nothing open: the agent may be stuck. */
  | { kind: "quiet"; ms: number }
  /** A tool call has been open this long (a long build or test run is normal). */
  | { kind: "tool"; ms: number; doing: string }
  /** Only background tasks are still running. */
  | { kind: "tasks"; ms: number; tasks: number };

/**
 * How long a running turn has been without news, once that passes QUIET_MS. Pending approvals
 * and questions are waits on you, not quiet agents, so they never count.
 */
export function quietness(shell: ThreadShell, thread: OrchestrationThread, now: number): Quiet | undefined {
  const turn = thread.latestTurn;
  if (turn?.state !== "running" || shell.hasPendingApprovals || shell.hasPendingUserInput) return undefined;
  let last = Date.parse(turn.startedAt ?? turn.requestedAt);
  const openTools = new Map<string, { at: number; doing: string }>();
  const openTasks = new Set<string>();
  for (const a of thread.activities) {
    if (a.turnId !== turn.turnId && !a.kind.startsWith("task.")) continue;
    const at = Date.parse(a.createdAt);
    if (a.turnId === turn.turnId && at > last) last = at;
    const p = a.payload ?? {};
    if (a.kind.startsWith("task.")) {
      const id = String(p.taskId ?? "");
      if (a.kind === "task.started") openTasks.add(id);
      else if (a.kind === "task.completed" || ["completed", "cancelled", "stopped", "failed"].includes(String(p.status ?? ""))) openTasks.delete(id);
      continue;
    }
    if (!a.kind.startsWith("tool.")) continue;
    const id = String(p.toolCallId ?? a.id);
    if (a.kind === "tool.completed" || p.status === "completed" || p.status === "failed") openTools.delete(id);
    else if (!openTools.has(id)) openTools.set(id, { at, doing: typeof p.detail === "string" && p.detail ? p.detail : a.summary });
  }
  for (const m of thread.messages) {
    if (m.turnId !== turn.turnId) continue;
    const at = Date.parse(m.updatedAt);
    if (at > last) last = at;
  }
  const ms = now - last;
  if (!Number.isFinite(ms) || ms < QUIET_MS) return undefined;
  const tool = [...openTools.values()].pop();
  if (tool) return { kind: "tool", ms: now - tool.at, doing: tool.doing.split("\n")[0].slice(0, 80) };
  if (openTasks.size) return { kind: "tasks", ms, tasks: openTasks.size };
  return { kind: "quiet", ms };
}

export function quietText(q: Quiet): string {
  if (q.kind === "tool") return `Running ${q.doing} for ${elapsed(q.ms)}`;
  if (q.kind === "tasks") return `Waiting on ${q.tasks} background task${q.tasks === 1 ? "" : "s"} · quiet ${elapsed(q.ms)}`;
  return `No activity for ${elapsed(q.ms)}`;
}

/** Context this full gets a warning: what happens next depends on whether the provider compacts. */
export const CONTEXT_WARN = 0.9;

/** A warning about a nearly full context window, or undefined below the threshold. */
export function contextWarning(context: number | undefined, compactsAutomatically: boolean | undefined): string | undefined {
  if (context === undefined || context < CONTEXT_WARN) return undefined;
  const left = Math.max(0, Math.round((1 - context) * 100));
  if (compactsAutomatically === true) return `${left}% context left: it will compact automatically soon, summarizing earlier work`;
  if (compactsAutomatically === false) return `${left}% context left and it won't compact automatically: turns may start failing; consider a fresh thread`;
  return `${left}% context left: the window is nearly full`;
}

/** Compact token counts: 940, 12k, 3.4M. */
export function tokenLabel(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}
