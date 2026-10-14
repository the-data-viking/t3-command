// "Is this done?": the evidence for a finished turn, kept apart from the agent's own account of
// it. What the agent says (its report) is a claim; what Command can observe — the PR's checks,
// the tests it actually ran this turn and how they ended, the PR's state against its base — is
// evidence. Pure functions over the thread and PR detail; the panel lays them side by side.

import { useGame } from "../store";
import type { OrchestrationThread, PullRequestDetail, ThreadPullRequest, ThreadShell } from "../t3/types";

/** Commands that run tests or checks, by the usual runners. */
const TEST_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|check|lint|typecheck)\b|\b(vitest|jest|pytest|mocha|playwright\s+test|cargo\s+test|go\s+test|tsc\b|eslint|rspec|phpunit)\b/i;

export interface TestRun {
  command: string;
  outcome: "passed" | "failed" | "running";
}

/** The test and check commands the agent ran in its latest turn, and how each ended (last run of each). */
export function testsRun(thread: OrchestrationThread): TestRun[] {
  const turnId = thread.latestTurn?.turnId;
  if (!turnId) return [];
  const calls = new Map<string, TestRun>();
  for (const a of thread.activities) {
    if (a.turnId !== turnId || !a.kind.startsWith("tool.")) continue;
    const p = a.payload ?? {};
    const command = typeof p.detail === "string" && p.detail.trim() ? p.detail.split("\n")[0].trim() : a.summary;
    if (!command || !TEST_COMMAND.test(command)) continue;
    const id = String(p.toolCallId ?? a.id);
    const failed = p.status === "failed" || a.tone === "error" || (typeof p.exitCode === "number" && p.exitCode !== 0);
    const done = a.kind === "tool.completed" || p.status === "completed" || p.status === "failed";
    calls.set(id, { command: command.length > 100 ? `${command.slice(0, 99)}…` : command, outcome: failed ? "failed" : done ? "passed" : "running" });
  }
  // The last run of each distinct command is what counts.
  const byCommand = new Map<string, TestRun>();
  for (const run of calls.values()) { byCommand.delete(run.command); byCommand.set(run.command, run); }
  return [...byCommand.values()];
}

export interface ChecksSummary { passing: number; failing: number; pending: number; total: number; verdict: "passing" | "failing" | "pending" | "none" }

export function checksSummary(detail: PullRequestDetail | undefined): ChecksSummary {
  const checks = detail?.checks ?? [];
  const passing = checks.filter((c) => c.status === "success" || c.status === "skipped" || c.status === "neutral").length;
  const failing = checks.filter((c) => c.status === "failure" || c.status === "cancelled" || c.status === "action-required").length;
  const pending = checks.filter((c) => c.status === "pending").length;
  const verdict = !checks.length ? "none" : failing ? "failing" : pending ? "pending" : "passing";
  return { passing, failing, pending, total: checks.length, verdict };
}

/**
 * The PR a review is about: the one on the thread's current branch, else its newest open, else its
 * newest. Only PRs T3 has a snapshot of: a bare "linked" reference can't be read from the host.
 */
export function reviewPullRequest(thread: ThreadShell): ThreadPullRequest | undefined {
  const prs = (thread.pullRequests ?? []).filter((pr) => pr.snapshot);
  return prs.find((pr) => thread.branch && pr.snapshot?.headBranch === thread.branch && pr.snapshot?.state !== "closed")
    ?? [...prs].filter((pr) => pr.snapshot?.state === "open").sort((a, b) => b.number - a.number)[0]
    ?? [...prs].sort((a, b) => b.number - a.number)[0];
}

/** The order sent by "Request changes": your notes, framed so the agent knows it's a review. */
export function changesOrder(notes: string): string {
  return `Review feedback on your last turn. Please address all of it, then summarize what you changed and how you verified it:\n\n${notes.trim()}`;
}

/** Open (or close) the review of a crew member's latest turn; it replaces any open card. */
export function openReview(at: { envId: string; threadId: string } | null): void {
  useGame.setState({ review: at, ...(at ? { event: null, debrief: null } : {}) });
}
