import assert from "node:assert/strict";
import test from "node:test";
import { checksStateOf, prKey, withPrStates, type PrStates } from "../shared/pr-states.ts";
import type { PullRequestDetail, ThreadShell } from "../src/t3/types.ts";
import { PrDetails } from "./pr-detail.ts";
import { PR_RECHECK_MS, PrStatesWatcher } from "./pr-states.ts";

const thread = (prs: Array<[number, string]>) => ({
  id: "t", archivedAt: null,
  pullRequests: prs.map(([number, state]) => ({ host: "github.com", repository: "O/R", number, url: "", snapshot: { state, title: "", headBranch: "h", baseBranch: "main", isDraft: false, checksState: null } })),
}) as unknown as ThreadShell;

test("GitHub's word corrects a snapshot T3 still calls open, and never reopens one", () => {
  const states: PrStates = { [prKey("o/r", 1)]: { state: "merged", checksState: "passing", isDraft: false, mergedAt: "2026-10-10T04:04:19Z", at: 0 },
    [prKey("o/r", 2)]: { state: "open", checksState: null, isDraft: false, mergedAt: null, at: 0 },
    [prKey("o/r", 3)]: { state: "open", checksState: "failing", isDraft: false, mergedAt: null, at: 0 } };
  const t = thread([[1, "open"], [2, "open"], [3, "merged"]]);
  const fixed = withPrStates(t, states);
  assert.equal(fixed.pullRequests![0].snapshot!.state, "merged");
  assert.equal(fixed.pullRequests![0].snapshot!.mergedAt, "2026-10-10T04:04:19Z");
  assert.equal(fixed.pullRequests![1], t.pullRequests![1], "nothing to correct: the same object");
  assert.equal(fixed.pullRequests![2].snapshot!.state, "merged", "an older read can't reopen what T3 saw merge");
  const same = thread([[2, "open"]]);
  assert.equal(withPrStates(same, states), same, "no change: the same thread, so nothing re-renders");
});

test("checks read as one word, as T3 spells them", () => {
  const c = (status: PullRequestDetail["checks"][number]["status"]) => ({ name: "x", status, description: null, url: null });
  assert.equal(checksStateOf([]), null);
  assert.equal(checksStateOf([c("success"), c("skipped")]), "passing");
  assert.equal(checksStateOf([c("success"), c("pending")]), "pending");
  assert.equal(checksStateOf([c("pending"), c("failure")]), "failing");
});

test("the watcher reads what machines still call open, re-reads it on a clock, and says what changed", async () => {
  let reads = 0;
  const state = "MERGED";
  const details = new PrDetails(async (args) => {
    if (args[0] !== "pr") return "{}";
    reads++;
    return JSON.stringify({ number: Number(args[2]), title: "", body: "", url: "", state, isDraft: false, mergeable: "UNKNOWN", additions: 0, deletions: 0, changedFiles: 0,
      headRefName: "h", headRefOid: "x", baseRefName: "main", mergedAt: state === "MERGED" ? "2026-10-10T04:04:19Z" : null, statusCheckRollup: [] });
  });
  const watcher = new PrStatesWatcher(details);
  const told: PrStates[] = [];
  watcher.subscribe((s) => told.push(s));
  watcher.observe("e", [thread([[1, "open"], [2, "merged"]])]);
  await watcher.tick(1_000);
  assert.equal(reads, 1, "only the one T3 calls open");
  assert.equal(watcher.all()[prKey("o/r", 1)].state, "merged");
  assert.equal(told.length, 1);
  await watcher.tick(2_000);
  assert.equal(reads, 1, "not again before it's due");
  await watcher.tick(1_000 + PR_RECHECK_MS);
  assert.equal(reads, 2);
  assert.equal(told.length, 1, "read again, nothing changed: nothing said");
  watcher.observe("e", [thread([[2, "merged"]])]);
  await watcher.tick(1_000 + 2 * PR_RECHECK_MS);
  assert.deepEqual(watcher.all(), {}, "no machine calls it open any more: dropped");
  assert.equal(told.length, 2);
});
