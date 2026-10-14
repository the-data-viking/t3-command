import assert from "node:assert/strict";
import test from "node:test";
import type { OrchestrationThread, PullRequestDetail, ThreadShell } from "../t3/types";
import { changesOrder, checksSummary, reviewPullRequest, testsRun } from "./review";

const act = (id: string, kind: string, detail: string, extra: Record<string, unknown> = {}, turnId = "t2") =>
  ({ id, kind, tone: "tool", summary: detail, createdAt: "2026-10-13T10:00:00Z", turnId, payload: { toolCallId: id.split(":")[0], detail, ...extra } });

test("tests run this turn: the last run of each test command, with how it ended (passed only on exit 0)", () => {
  const thread = { latestTurn: { turnId: "t2" }, activities: [
    act("a:1", "tool.started", "npm test"), act("a:2", "tool.completed", "npm test", { status: "failed" }),
    act("b:1", "tool.completed", "npm test", { exitCode: 0 }),
    act("c:1", "tool.completed", "npx vitest run src/x"),
    act("d:1", "tool.completed", "ls -la"),
    act("e:1", "tool.completed", "pnpm lint", {}, "t1"),
    act("f:1", "tool.started", "cargo test"),
  ] } as unknown as OrchestrationThread;
  assert.deepEqual(testsRun(thread), [
    { command: "npm test", outcome: "passed" },
    { command: "npx vitest run src/x", outcome: "ran" },
    { command: "cargo test", outcome: "running" },
  ]);
});

test("checks summarize to a verdict; no checks is 'none', not passing", () => {
  const pr = (statuses: string[]) => ({ checks: statuses.map((status, i) => ({ name: `c${i}`, status })) }) as PullRequestDetail;
  assert.equal(checksSummary(pr(["success", "skipped"])).verdict, "passing");
  assert.equal(checksSummary(pr(["success", "pending"])).verdict, "pending");
  assert.equal(checksSummary(pr(["success", "failure", "pending"])).verdict, "failing");
  assert.equal(checksSummary(pr([])).verdict, "none");
  assert.equal(checksSummary(undefined).verdict, "none");
});

test("the PR under review: the current branch's, else the newest open, else the newest", () => {
  const pr = (number: number, state: string, headBranch = `b${number}`) => ({ number, repository: "r", url: "", host: "github.com", snapshot: { state, headBranch } });
  const t = (branch: string | null, prs: unknown[]) => ({ branch, pullRequests: prs }) as unknown as ThreadShell;
  assert.equal(reviewPullRequest(t("b5", [pr(9, "open"), pr(5, "merged")]))?.number, 5);
  assert.equal(reviewPullRequest(t("x", [pr(3, "open"), pr(9, "merged"), pr(7, "open")]))?.number, 7);
  assert.equal(reviewPullRequest(t(null, [pr(2, "merged"), pr(4, "closed")]))?.number, 4);
  assert.equal(reviewPullRequest(t(null, [])), undefined);
  assert.equal(reviewPullRequest(t(null, [{ number: 646, repository: "r", url: "", snapshot: null }, pr(3, "merged")]))?.number, 3, "a bare linked reference isn't reviewable");
  assert.match(changesOrder("  rename foo  "), /Review feedback[\s\S]*\n\nrename foo$/);
});

test("doubts: a report's claims that the evidence doesn't back up", async () => {
  const { doubts } = await import("./review");
  const none = { passing: 0, failing: 0, pending: 0, total: 0, verdict: "none" as const };
  const pending = { passing: 2, failing: 0, pending: 1, total: 3, verdict: "pending" as const };
  const report = "Opened PR #72; checks are green. All tests pass.";
  assert.deepEqual(doubts(report, [], pending, [72]), [
    { claim: "Says checks are green", evidence: "1 still pending" },
    { claim: "Says tests pass", evidence: "no test command ran this turn" },
  ]);
  assert.deepEqual(doubts(report, [{ command: "npm test", outcome: "failed" }], { ...pending, pending: 0, failing: 1, verdict: "failing" }, [9]).map((d) => d.evidence),
    ["1 failing", "npm test failed this turn", "no such PR is linked to this crew member"]);
  assert.deepEqual(doubts(report, [{ command: "npm test", outcome: "passed" }], { ...none, passing: 3, total: 3, verdict: "passing" }, [72]), [], "everything backs it up");
  assert.deepEqual(doubts("Refactored the loader.", [], none, []), [], "no claims, no doubts");
});
