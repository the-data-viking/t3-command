// What GitHub says of pull requests that T3's snapshots still call open, read by the Command
// server through its own host's GitHub login (server/pr-states.ts). A machine whose GitHub login
// can't read a PR never refreshes it in T3, so a PR merged days ago can sit "open" on the map; the
// browser patches each thread's PR snapshots with these as they arrive.

import type { PullRequestDetail, ThreadPullRequest, ThreadShell } from "../src/t3/types.ts";

export interface PrState {
  state: "open" | "closed" | "merged";
  /** The checks summary, as T3's snapshot spells it. */
  checksState: "passing" | "failing" | "pending" | null;
  isDraft: boolean;
  mergedAt: string | null;
  /** When the server read it. */
  at: number;
}

/** By `owner/name#number` (lower-cased repo). */
export type PrStates = Record<string, PrState>;

export const prKey = (repository: string, number: number): string => `${repository.toLowerCase()}#${number}`;

/** A PR's checks as one word, the way T3's snapshot reports them. */
export function checksStateOf(checks: PullRequestDetail["checks"]): PrState["checksState"] {
  if (!checks.length) return null;
  if (checks.some((c) => c.status === "failure" || c.status === "cancelled" || c.status === "action-required")) return "failing";
  if (checks.some((c) => c.status === "pending")) return "pending";
  return "passing";
}

export function prStateOf(d: PullRequestDetail, at: number): PrState {
  return { state: d.state, checksState: checksStateOf(d.checks), isDraft: d.isDraft, mergedAt: d.mergedAt, at };
}

/**
 * A thread with its PR snapshots corrected by what GitHub says (the same object if nothing
 * changes). Only a snapshot T3 still calls open is corrected: one T3 already saw merge or close
 * stays as T3 has it, so an older read can't reopen it.
 */
export function withPrStates(thread: ThreadShell, states: PrStates): ThreadShell {
  if (!thread.pullRequests?.length) return thread;
  let changed = false;
  const pullRequests = thread.pullRequests.map((pr): ThreadPullRequest => {
    const s = pr.snapshot;
    const seen = states[prKey(pr.repository, pr.number)];
    if (!s || !seen || s.state !== "open") return pr;
    if (seen.state === s.state && seen.checksState === (s.checksState ?? null) && seen.isDraft === s.isDraft) return pr;
    changed = true;
    return { ...pr, snapshot: { ...s, state: seen.state, checksState: seen.checksState, isDraft: seen.isDraft, mergedAt: seen.mergedAt } };
  });
  return changed ? { ...thread, pullRequests } : thread;
}
