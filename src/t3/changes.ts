// Presentation rules for a thread's pull requests and per-turn file changes.

import type { Checkpoint, ThreadPullRequest } from "./types";

/**
 * Lines changed per turn should describe the work, not build output. A file is "generated or
 * data" (listed, flagged, but left out of the totals) when it changes by more than 5,000 lines in
 * one turn, is a log/lockfile/map/minified bundle/snapshot/data or asset format, is a JSON file
 * changing by more than 500 lines, or lives under a conventional output folder.
 */
export const LARGE_FILE_LINES = 5_000;
const LARGE_JSON_LINES = 500;
const DATA_FILE = /(\.(log|lock|map|snap|csv|tsv|svg|obj|gltf|glb|ply|stl|fbx|import)|\.min\.(js|css)|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum))$/i;
const OUTPUT_DIR = /(^|\/)(dist|build|out|vendor|node_modules|generated|__generated__|coverage|snapshots|__snapshots__|fixtures|previews|evidence)\//i;

export function isGeneratedChange(file: { path?: string; additions: number; deletions: number }): boolean {
  const lines = file.additions + file.deletions;
  const path = file.path ?? "";
  return lines > LARGE_FILE_LINES || DATA_FILE.test(path) || OUTPUT_DIR.test(path) || (/\.json$/i.test(path) && lines > LARGE_JSON_LINES);
}

export function changeTotals(files: Checkpoint["files"]): { additions: number; deletions: number; generated: number } {
  let additions = 0, deletions = 0, generated = 0;
  for (const f of files) {
    if (isGeneratedChange(f)) generated++;
    else { additions += f.additions; deletions += f.deletions; }
  }
  return { additions, deletions, generated };
}

export function prState(pr: ThreadPullRequest): string {
  const s = pr.snapshot;
  return s?.isDraft && s.state === "open" ? "draft" : s?.state ?? "linked";
}

const RANK: Record<string, number> = { open: 0, draft: 1, merged: 2, closed: 3, linked: 4 };

/**
 * Open and draft PRs first, then the two most recent of the rest; everything else folds into
 * "+N more" so a long-running thread's history doesn't bury the PR that needs attention.
 */
export function orderPullRequests(prs: ThreadPullRequest[], settledShown = 2): { shown: ThreadPullRequest[]; hidden: ThreadPullRequest[] } {
  const unique = [...new Map(prs.map((pr) => [`${pr.repository}#${pr.number}`, pr])).values()];
  const sorted = unique.sort((a, b) => (RANK[prState(a)] ?? 5) - (RANK[prState(b)] ?? 5) || b.number - a.number);
  const active = sorted.filter((pr) => RANK[prState(pr)] <= 1);
  const rest = sorted.filter((pr) => RANK[prState(pr)] > 1);
  return { shown: [...active, ...rest.slice(0, settledShown)], hidden: rest.slice(settledShown) };
}
