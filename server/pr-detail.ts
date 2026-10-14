// A pull request's detail read by the Command server itself, through the GitHub CLI signed in on
// its own host. T3 reads PR detail on each agent's machine with that machine's GitHub login, and a
// fine-grained token there can't read checks (GitHub offers no such permission for them), so its
// whole read fails and PR states go stale. One login on the Command host reads them all.

import { execFile } from "node:child_process";
import type { PullRequestDetail } from "../src/t3/types.ts";

/** Runs `gh` with arguments (no shell) and returns its stdout. */
export type RunGh = (args: string[]) => Promise<string>;

export const runGh: RunGh = (args) => new Promise((resolve, reject) => {
  execFile("gh", args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    if (err) reject(new Error((stderr || err.message).trim().split("\n")[0]));
    else resolve(stdout);
  });
});

/** `owner/name`, as GitHub spells repositories. */
export const REPO = /^[\w.-]+\/[\w.-]+$/;

/** How long a read is reused: the dock and the review panel can ask again and again. */
export const PR_DETAIL_TTL_MS = 30_000;

type Check = PullRequestDetail["checks"][number];

interface GhRollup {
  __typename?: string;
  name?: string; status?: string; conclusion?: string; detailsUrl?: string; workflowName?: string;
  context?: string; state?: string; targetUrl?: string; description?: string;
}

/** One entry of gh's statusCheckRollup (a check run or a commit status) as T3 reports a check. */
export function checkOf(c: GhRollup): Check {
  if (c.__typename === "StatusContext" || c.context !== undefined) {
    const state = (c.state ?? "").toUpperCase();
    return { name: c.context ?? "status", status: state === "SUCCESS" ? "success" : state === "FAILURE" || state === "ERROR" ? "failure" : "pending", description: c.description ?? null, url: c.targetUrl ?? null };
  }
  const status = (c.status ?? "").toUpperCase(), conclusion = (c.conclusion ?? "").toUpperCase();
  const mapped: Check["status"] = status !== "COMPLETED" ? "pending"
    : conclusion === "SUCCESS" ? "success"
    : conclusion === "SKIPPED" ? "skipped"
    : conclusion === "NEUTRAL" ? "neutral"
    : conclusion === "CANCELLED" ? "cancelled"
    : conclusion === "ACTION_REQUIRED" ? "action-required"
    : "failure";
  return { name: c.workflowName ? `${c.workflowName} / ${c.name}` : c.name ?? "check", status: mapped, description: null, url: c.detailsUrl ?? null };
}

const FIELDS = "number,title,body,url,state,isDraft,mergeable,additions,deletions,changedFiles,headRefName,headRefOid,baseRefName,mergedAt,reviewRequests,statusCheckRollup";

/** Read a PR's detail with `gh`: state, checks, mergeability, and (while open) how far behind its base it is. */
export async function readPrDetail(repo: string, number: number, gh: RunGh = runGh): Promise<PullRequestDetail> {
  const pr = JSON.parse(await gh(["pr", "view", String(number), "-R", repo, "--json", FIELDS])) as {
    number: number; title: string; body: string; url: string; state: string; isDraft: boolean; mergeable: string;
    additions: number; deletions: number; changedFiles: number; headRefName: string; headRefOid: string; baseRefName: string;
    mergedAt: string | null; reviewRequests?: Array<{ login?: string; name?: string; __typename?: string }>; statusCheckRollup?: GhRollup[];
  };
  const state = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open";
  let baseComparison: PullRequestDetail["baseComparison"] = "unknown";
  let behindBy: number | undefined;
  if (state === "open") {
    try {
      const cmp = JSON.parse(await gh(["api", `repos/${repo}/compare/${encodeURIComponent(pr.baseRefName)}...${pr.headRefOid}`, "--jq", "{behind_by}"])) as { behind_by?: number };
      if (typeof cmp.behind_by === "number") { behindBy = cmp.behind_by; baseComparison = cmp.behind_by > 0 ? "behind" : "up-to-date"; }
    } catch { /* Unknown is said as unknown. */ }
  }
  return {
    repository: repo, number: pr.number, title: pr.title, body: pr.body ?? "", url: pr.url, state, isDraft: pr.isDraft,
    mergeability: pr.mergeable === "MERGEABLE" ? "mergeable" : pr.mergeable === "CONFLICTING" ? "conflicting" : "unknown",
    additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changedFiles,
    headBranch: pr.headRefName, baseBranch: pr.baseRefName, mergedAt: pr.mergedAt,
    reviewers: (pr.reviewRequests ?? []).filter((r) => r.login || r.name).map((r) => ({ login: r.login ?? r.name!, name: r.name ?? null, ...(r.__typename === "Bot" ? { isBot: true } : {}) })),
    checks: (pr.statusCheckRollup ?? []).map(checkOf),
    baseComparison, ...(behindBy !== undefined ? { behindBy } : {}),
  };
}

/** PR reads with a short cache, and one read at a time per PR. */
export class PrDetails {
  private cache = new Map<string, { at: number; read: Promise<PullRequestDetail> }>();
  private readonly gh: RunGh;

  constructor(gh: RunGh = runGh) {
    this.gh = gh;
  }

  get(repo: string, number: number, now = Date.now()): Promise<PullRequestDetail> {
    if (!REPO.test(repo) || !Number.isInteger(number) || number < 1) return Promise.reject(new Error("Not a GitHub pull request"));
    const key = `${repo.toLowerCase()}#${number}`;
    const hit = this.cache.get(key);
    if (hit && now - hit.at < PR_DETAIL_TTL_MS) return hit.read;
    const read = readPrDetail(repo, number, this.gh);
    this.cache.set(key, { at: now, read });
    // A failed read isn't kept: the next ask tries again.
    read.catch(() => { if (this.cache.get(key)?.read === read) this.cache.delete(key); });
    for (const [k, v] of this.cache) if (now - v.at > PR_DETAIL_TTL_MS * 4) this.cache.delete(k);
    return read;
  }
}
