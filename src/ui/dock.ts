// The shipping dock's model: every open pull request in the fleet, once each, ranked by how ready
// it is to merge. Readiness comes from what T3 and the host report (checks, draft, mergeability,
// commits behind, review decision); nothing here is guessed from what an agent said.

import type { EnvWorld } from "../store";
import type { PullRequestDetail, ThreadPullRequest, ThreadShell } from "../t3/types";

export type Lane = "ready" | "attention" | "waiting";

export const LANES: Array<{ id: Lane; title: string; hint: string }> = [
  { id: "ready", title: "Ready to merge", hint: "Checks passing, not a draft, no conflicts, up to date with its base" },
  { id: "attention", title: "Needs attention", hint: "Failing checks, conflicts, behind its base, or changes requested" },
  { id: "waiting", title: "In progress", hint: "Drafts and checks still running" },
];

export interface DockPr {
  key: string;
  envId: string;
  thread: ThreadShell;
  project: string;
  pr: ThreadPullRequest;
}

/** Every open PR, once (the newest thread that has it), newest number first. */
export function openPrs(envs: Record<string, EnvWorld>): DockPr[] {
  const byKey = new Map<string, DockPr>();
  for (const env of Object.values(envs)) {
    for (const thread of Object.values(env.threads)) {
      if (thread.archivedAt) continue;
      for (const pr of thread.pullRequests ?? []) {
        if (pr.snapshot?.state !== "open") continue;
        const key = `${pr.repository}#${pr.number}`;
        const have = byKey.get(key);
        if (have && have.thread.updatedAt >= thread.updatedAt) continue;
        byKey.set(key, { key, envId: env.summary.id, thread, project: env.projects[thread.projectId]?.title ?? pr.repository, pr });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.pr.number - a.pr.number);
}

export interface Readiness {
  lane: Lane;
  /** Why it's in that lane, most important first. */
  reasons: string[];
  /** Behind its base or conflicting: a rebase would help. */
  rebase: boolean;
}

/** How ready a PR is, from its snapshot and (when it's been read) the host's detail. */
export function readiness(pr: ThreadPullRequest, detail?: PullRequestDetail): Readiness {
  const s = pr.snapshot;
  const checks = detail?.checks;
  const failing = checks ? checks.filter((c) => c.status === "failure" || c.status === "cancelled" || c.status === "action-required").length : s?.checksState === "failing" ? 1 : 0;
  const pending = checks ? checks.filter((c) => c.status === "pending").length : s?.checksState === "pending" ? 1 : 0;
  const conflicting = detail?.mergeability === "conflicting";
  const behind = detail?.baseComparison === "behind";
  const changesRequested = /changes_requested/i.test(s?.reviewDecision ?? "");
  const draft = detail?.isDraft ?? s?.isDraft ?? false;
  const base = detail?.baseBranch ?? s?.baseBranch ?? "its base";
  const attention = [
    failing && `${failing} failing check${failing === 1 ? "" : "s"}`,
    conflicting && `conflicts with ${base}`,
    changesRequested && "changes requested",
    behind && `${detail?.behindBy ? `${detail.behindBy} commit${detail.behindBy === 1 ? "" : "s"} ` : ""}behind ${base}`,
  ].filter((r): r is string => !!r);
  const rebase = conflicting || behind;
  if (attention.length) return { lane: "attention", reasons: attention, rebase };
  const waiting = [draft && "draft", pending && `${pending} check${pending === 1 ? "" : "s"} running`].filter((r): r is string => !!r);
  if (waiting.length) return { lane: "waiting", reasons: waiting, rebase };
  const approved = /approved/i.test(s?.reviewDecision ?? "");
  return { lane: "ready", reasons: [checks?.length || s?.checksState === "passing" ? "checks passing" : "no checks reported", ...(approved ? ["approved"] : [])], rebase };
}
