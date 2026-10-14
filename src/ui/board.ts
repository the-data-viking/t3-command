// The mission board's model: every crew member's current work in one column, by what it needs
// next — you, a plan, building, review of an open PR, or reading its report.

import type { EnvWorld, GameState } from "../store";
import type { UnitState } from "../t3/derive";
import type { ThreadShell } from "../t3/types";
import { allUnits, reportRead } from "./util";
import { needsYou } from "./needs-you";

export type Column = "needs-you" | "building" | "review" | "report";

export const COLUMNS: Array<{ id: Column; title: string; hint: string }> = [
  { id: "needs-you", title: "Blocked on you", hint: "Approvals, questions, plans to approve, failed turns and turns that may be stuck: Needs you, less the reports (they have their own column), in the same order" },
  { id: "building", title: "Building", hint: "Turns and background work running (plan-mode crew are drafting their plan)" },
  { id: "report", title: "Report ready", hint: "Finished, report not read yet" },
  { id: "review", title: "In review", hint: "Report read, a PR still open" },
];

export interface Card { envId: string; thread: ThreadShell; state: UnitState; column: Column }

/** The column a crew member's work is in now, or undefined when it's off the board (idle, at camp). */
export function columnOf(thread: ThreadShell, state: UnitState, read: boolean): Column | undefined {
  // The same "needs you" as everywhere else (needs-you.ts): a plan waiting for approval and an
  // unseen failure are decisions; a seen failure leaves the board until the next turn.
  if (state === "alert" || state === "question") return "needs-you";
  if (state === "error") return read ? undefined : "needs-you";
  if (thread.interactionMode === "plan" && state === "done" && !read) return "needs-you";
  if (state === "working" || state === "monitoring") return "building";
  // An unread report is the next thing to do; once read, an open PR keeps it in review.
  if (state === "done" && !read) return "report";
  const openPr = (thread.pullRequests ?? []).some((pr) => pr.snapshot?.state === "open");
  if (openPr && state !== "sleeping") return "review";
  return undefined;
}

/**
 * The board: each column's cards, the longest-standing first; the first column in Needs you's own
 * order, with turns that may be stuck moved into it from Building. Hermes operators aren't missions.
 */
export function boardOf(envs: Record<string, EnvWorld>, readReports: Record<string, string>,
  watch: Partial<Pick<GameState, "details" | "stuckOk">> = {}, now = Date.now()): Record<Column, Card[]> {
  const board: Record<Column, Card[]> = { "needs-you": [], building: [], review: [], report: [] };
  for (const u of allUnits(envs)) {
    if (envs[u.envId]?.summary.kind === "hermes") continue;
    const column = columnOf(u.thread, u.state, reportRead(readReports, u.envId, u.thread));
    if (column) board[column].push({ envId: u.envId, thread: u.thread, state: u.state, column });
  }
  const since = (c: Card) => Date.parse(c.thread.latestTurn?.completedAt ?? c.thread.latestTurn?.startedAt ?? c.thread.updatedAt) || 0;
  for (const cards of Object.values(board)) cards.sort((a, b) => since(a) - since(b) || a.thread.id.localeCompare(b.thread.id));
  const needs = needsYou({ envs, readReports, ...watch }, now);
  const order = new Map(needs.map((n, i) => [`${n.envId}:${n.threadId}`, i]));
  const stuck = new Set(needs.filter((n) => n.kind === "stuck").map((n) => `${n.envId}:${n.threadId}`));
  const key = (c: Card) => `${c.envId}:${c.thread.id}`;
  board["needs-you"].push(...board.building.filter((c) => stuck.has(key(c))).map((c) => ({ ...c, column: "needs-you" as const })));
  board.building = board.building.filter((c) => !stuck.has(key(c)));
  board["needs-you"].sort((a, b) => (order.get(key(a)) ?? Infinity) - (order.get(key(b)) ?? Infinity));
  return board;
}
