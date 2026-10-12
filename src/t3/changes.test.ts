import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadPullRequest } from "./types";
import { changeTotals, orderPullRequests } from "./changes";

const pr = (number: number, state: string | null, isDraft = false) =>
  ({ host: "github.com", repository: "o/r", number, url: `u/${number}`, snapshot: state ? { state, isDraft, title: "t", headBranch: "h", baseBranch: "main" } : null }) as ThreadPullRequest;

test("open PRs lead, the rest fold into +N more", () => {
  const prs = [pr(601, "merged"), pr(629, "open"), pr(540, null), pr(610, "merged"), pr(612, "closed"), pr(630, "open", true), pr(620, "merged"), pr(629, "open")];
  const { shown, hidden } = orderPullRequests(prs);
  assert.deepEqual(shown.map((p) => p.number), [629, 630, 620, 610]);
  assert.deepEqual(hidden.map((p) => p.number), [601, 612, 540]);
});

test("generated and data files are flagged out of the totals", () => {
  const f = (path: string, additions: number, deletions = 0) => ({ path, kind: "modified", additions, deletions });
  const totals = changeTotals([
    f("src/a.ts", 40, 2),
    f("project/environment/materials/rock.gdshader", 120, 10),
    f("tsconfig.json", 3, 1),
    f("dist/bundle.js", 9_900_000, 600_000),
    f("src/huge.ts", 6_000),
    f("assets/previews/frontier/validation.json", 4_000),
    f("assets/previews/nine/contact.py", 2_000),
    f("runs/nine-before.log", 300),
    f("package-lock.json", 900, 300),
    f("data/report.json", 800),
  ]);
  assert.deepEqual(totals, { additions: 163, deletions: 13, generated: 7 });
});
