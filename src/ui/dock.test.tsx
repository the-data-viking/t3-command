import assert from "node:assert/strict";
import test from "node:test";
import { loadDemoFleet } from "../demo";
import { useGame } from "../store";
import type { PullRequestDetail, ThreadPullRequest } from "../t3/types";
import { openPrs, readiness } from "./dock";

const pr = (snapshot: Partial<NonNullable<ThreadPullRequest["snapshot"]>>): ThreadPullRequest => ({
  host: "github.com", repository: "r", number: 1, url: "u",
  snapshot: { state: "open", title: "t", headBranch: "h", baseBranch: "main", isDraft: false, ...snapshot },
});
const detail = (d: Partial<PullRequestDetail>): PullRequestDetail => ({
  repository: "r", number: 1, title: "t", body: "", url: "u", state: "open", isDraft: false, mergeability: "mergeable",
  additions: 1, deletions: 1, changedFiles: 1, headBranch: "h", baseBranch: "main", mergedAt: null, reviewers: [], checks: [], ...d,
});
const check = (status: PullRequestDetail["checks"][number]["status"]) => ({ name: status, status, description: null, url: null });

test("a PR's lane comes from what T3 and the host report", () => {
  assert.deepEqual(readiness(pr({ checksState: "passing" })), { lane: "ready", reasons: ["checks passing"], rebase: false });
  assert.equal(readiness(pr({ checksState: "failing" })).lane, "attention");
  assert.equal(readiness(pr({ isDraft: true })).lane, "waiting");
  assert.equal(readiness(pr({ checksState: "pending" })).lane, "waiting");
  assert.deepEqual(readiness(pr({}), detail({})).reasons, ["no checks reported"], "no checks isn't the same as passing");
  assert.deepEqual(readiness(pr({ reviewDecision: "APPROVED" }), detail({ checks: [check("success")] })).reasons, ["checks passing", "approved"]);
});

test("the host's detail outranks the snapshot, and says why it needs attention", () => {
  const r = readiness(pr({ checksState: "passing" }), detail({ checks: [check("success"), check("failure"), check("cancelled")], mergeability: "conflicting" }));
  assert.equal(r.lane, "attention");
  assert.deepEqual(r.reasons, ["2 failing checks", "conflicts with main"]);
  assert.ok(r.rebase, "a conflict wants a rebase");
  const behind = readiness(pr({}), detail({ baseComparison: "behind", behindBy: 3 }));
  assert.deepEqual(behind, { lane: "attention", reasons: ["3 commits behind main"], rebase: true });
  assert.equal(readiness(pr({ isDraft: true }), detail({ isDraft: false })).lane, "ready", "marked ready on the host since");
  assert.equal(readiness(pr({ reviewDecision: "CHANGES_REQUESTED" })).lane, "attention");
  assert.deepEqual(readiness(pr({}), detail({ checks: [check("pending"), check("success")] })).reasons, ["1 check running"]);
});

test("the demo fleet's dock: open PRs once each, newest first", () => {
  loadDemoFleet();
  const prs = openPrs(useGame.getState().envs);
  assert.deepEqual(prs.map((p) => p.pr.number), [72, 63, 62, 61], "merged PRs stay off the dock");
  assert.deepEqual(prs.map((p) => readiness(p.pr).lane), ["ready", "waiting", "attention", "ready"]);
});
