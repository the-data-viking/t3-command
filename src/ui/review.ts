// "Is this done?": the evidence for a finished turn, kept apart from the agent's own account of
// it. What the agent says (its report) is a claim; what Command can observe — the PR's checks,
// the tests it actually ran this turn and how they ended, the PR's state against its base — is
// evidence. Pure functions over the thread and PR detail; the panel lays them side by side.

import { useGame } from "../store";
import { openDebrief } from "./debrief";
import { advanceQueue, finishQueue } from "./queue-run";
import { reportRead } from "./util";
import type { PullRequestDetail, ThreadPullRequest, ThreadShell } from "../t3/types";
import type { TestRun } from "../t3/tests-run";

// What the agent ran this turn by way of tests, and how each ended: in src/t3 so the Command server
// can read it too (a turn's pulse).
export { testsRun, type TestRun } from "../t3/tests-run";

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

/**
 * Open (or close) the review of a crew member's latest turn; it replaces any open card. Opened
 * from a queue run, the run carries on when it closes: back to that report's card, or on to the
 * next one if the review marked it read.
 */
export function openReview(at: { envId: string; threadId: string } | null): void {
  const { review, queueRun } = useGame.getState();
  useGame.setState({ review: at, ...(at ? { event: null, debrief: null } : {}) });
  if (at || !review || !queueRun) return;
  const { envs, readReports } = useGame.getState();
  const thread = envs[review.envId]?.threads[review.threadId];
  if (thread && reportRead(readReports, review.envId, thread)) { if (!advanceQueue(`${review.envId}:${review.threadId}`)) finishQueue(); }
  else openDebrief(review);
}

/** Where a report's claim and Command's evidence disagree: a doubt, not a verdict. */
export interface Doubt { claim: string; evidence: string }

const CLAIMS = {
  checks: /\b(checks?|ci)\b[^.\n]{0,40}\b(green|pass(ed|ing)?|succeed(ed|ing)?)\b|\bgreen (checks|ci)\b/i,
  tests: /\b(all |the )?tests?\b[^.\n]{0,30}\b(pass(ed|ing|es)?|green|succeed(ed)?)\b/i,
  pr: /\b(?:opened|created|raised|pushed)\b[^.\n]{0,30}\bPR\s*#(\d+)/i,
};

/**
 * Claims in a report that the evidence doesn't back up: checks said to be green while some are
 * pending or failing, tests said to pass when none ran this turn (or one failed), a PR said to be
 * opened that this crew member doesn't have. Plain pattern matching, so these are doubts to look
 * at, never a ruling on the work.
 */
export function doubts(report: string | undefined, tests: TestRun[], checks: ChecksSummary, prNumbers: number[]): Doubt[] {
  if (!report) return [];
  const out: Doubt[] = [];
  if (CLAIMS.checks.test(report)) {
    if (checks.verdict === "failing") out.push({ claim: "Says checks are green", evidence: `${checks.failing} failing` });
    else if (checks.verdict === "pending") out.push({ claim: "Says checks are green", evidence: `${checks.pending} still pending` });
  }
  if (CLAIMS.tests.test(report)) {
    const failed = tests.filter((t) => t.outcome === "failed");
    if (!tests.length) out.push({ claim: "Says tests pass", evidence: "no test command ran this turn" });
    else if (failed.length) out.push({ claim: "Says tests pass", evidence: `${failed[0].command} failed this turn` });
  }
  const pr = CLAIMS.pr.exec(report);
  if (pr && !prNumbers.includes(Number(pr[1]))) out.push({ claim: `Says it opened PR #${pr[1]}`, evidence: "no such PR is linked to this crew member" });
  return out;
}
