import assert from "node:assert/strict";
import test from "node:test";
import { checkOf, PrDetails, readPrDetail } from "./pr-detail.ts";

const view = {
  number: 609, title: "ui: show, don't tell", body: "", url: "https://github.com/o/r/pull/609", state: "OPEN", isDraft: false, mergeable: "MERGEABLE",
  additions: 10, deletions: 2, changedFiles: 3, headRefName: "codex/x", headRefOid: "abc123", baseRefName: "main", mergedAt: null,
  reviewRequests: [{ __typename: "User", login: "the-data-viking" }],
  statusCheckRollup: [
    { __typename: "CheckRun", name: "test", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "u1" },
    { __typename: "CheckRun", name: "lint", workflowName: "CI", status: "IN_PROGRESS", conclusion: "" },
    { __typename: "StatusContext", context: "deploy/preview", state: "FAILURE", targetUrl: "u2", description: "broke" },
  ],
};

test("gh's checks read as T3 reports them: check runs and commit statuses alike", () => {
  assert.deepEqual(checkOf({ __typename: "CheckRun", name: "test", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "u" }),
    { name: "CI / test", status: "success", description: null, url: "u" });
  assert.equal(checkOf({ __typename: "CheckRun", name: "x", status: "QUEUED" }).status, "pending");
  assert.equal(checkOf({ __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: "TIMED_OUT" }).status, "failure");
  assert.equal(checkOf({ __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: "SKIPPED" }).status, "skipped");
  assert.equal(checkOf({ __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: "ACTION_REQUIRED" }).status, "action-required");
  assert.equal(checkOf({ __typename: "StatusContext", context: "ci", state: "ERROR" }).status, "failure");
  assert.equal(checkOf({ __typename: "StatusContext", context: "ci", state: "PENDING" }).status, "pending");
});

test("a PR read through gh: state, mergeability, checks, and how far behind its base it is", async () => {
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    return args[0] === "pr" ? JSON.stringify(view) : JSON.stringify({ behind_by: 3 });
  };
  const d = await readPrDetail("o/r", 609, gh);
  assert.equal(d.state, "open");
  assert.equal(d.mergeability, "mergeable");
  assert.deepEqual(d.checks.map((c) => c.status), ["success", "pending", "failure"]);
  assert.deepEqual([d.baseComparison, d.behindBy], ["behind", 3]);
  assert.deepEqual(d.reviewers, [{ login: "the-data-viking", name: null }]);
  assert.deepEqual(calls[1], ["api", "repos/o/r/compare/main...abc123", "--jq", "{behind_by}"]);
  const merged = await readPrDetail("o/r", 609, async () => JSON.stringify({ ...view, state: "MERGED", mergedAt: "2026-10-10T04:04:19Z" }));
  assert.equal(merged.state, "merged", "a merged PR says so (T3's snapshot may still call it open)");
  assert.equal(merged.baseComparison, "unknown", "no comparison once it's merged");
});

test("reads are cached briefly, failures aren't, and only GitHub repos are asked for", async () => {
  let n = 0;
  let fail = true;
  const details = new PrDetails(async (args) => { n++; if (fail) throw new Error("gh: not logged in"); return args[0] === "pr" ? JSON.stringify(view) : "{}"; });
  await assert.rejects(details.get("o/r", 609, 0), /not logged in/);
  fail = false;
  await details.get("o/r", 609, 1_000);
  const after = n;
  await details.get("o/r", 609, 10_000);
  assert.equal(n, after, "within 30 s: no second read");
  await details.get("o/r", 609, 40_000);
  assert.ok(n > after, "after 30 s: read again");
  await assert.rejects(details.get("o/r; rm -rf /", 1), /Not a GitHub pull request/);
  await assert.rejects(details.get("o/r", 0), /Not a GitHub pull request/);
});
