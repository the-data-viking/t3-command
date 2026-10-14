// What a station has been through, worn on its hull: tally marks for merged PRs, patch plates for
// failed turns, and archive shelves that fill with finished work. Drawn from real history only.

import type { GameState } from "../store";
import type { ThreadPullRequest } from "../t3/types";
import type { StationLayout } from "./layout";

export interface StationMemory {
  /** PRs merged from this project's threads (archived ones too), each counted once. */
  merged: number;
  /** Turns finished cleanly, and failed, in the Command server's history (90 days). */
  completed: number;
  failed: number;
}

export function stationMemory(state: GameState, s: StationLayout): StationMemory {
  const prs = new Set<string>();
  let completed = 0, failed = 0;
  for (const { envId, projectId } of s.members) {
    for (const t of Object.values(state.envs[envId]?.threads ?? {})) {
      if (t.projectId !== projectId) continue;
      for (const pr of t.pullRequests ?? []) if (pr.snapshot?.state === "merged") prs.add(`${pr.repository}#${pr.number}`);
    }
    const m = state.memory[`${envId}:${projectId}`];
    if (m) { completed += m.completed; failed += m.failed; }
  }
  return { merged: prs.size, completed, failed };
}

/** Finished turns per archive shelf unit: a shelf fills as a station works. */
export const JOBS_PER_SHELF = 5;
/** At most this many patch plates; past it the hull is patched all over already. */
export const MAX_PATCHES = 8;

/** An open PR docked at its station as a cargo pod. */
export interface DockedPr {
  number: number;
  url: string;
  title: string;
  checks: "passing" | "failing" | "pending" | "draft";
}

/** The station's open PRs, newest first, each once (several threads can link the same PR). */
export function dockedPrs(state: GameState, s: StationLayout): DockedPr[] {
  const prs = new Map<string, ThreadPullRequest>();
  for (const { envId, projectId } of s.members) {
    for (const t of Object.values(state.envs[envId]?.threads ?? {})) {
      if (t.projectId !== projectId) continue;
      for (const pr of t.pullRequests ?? []) if (pr.snapshot?.state === "open") prs.set(`${pr.repository}#${pr.number}`, pr);
    }
  }
  return [...prs.values()].sort((a, b) => b.number - a.number).map((pr) => ({
    number: pr.number, url: pr.url, title: pr.snapshot?.title ?? "",
    checks: pr.snapshot?.isDraft ? "draft" : pr.snapshot?.checksState === "failing" ? "failing" : pr.snapshot?.checksState === "passing" ? "passing" : "pending",
  }));
}

/** Pods shown under a hull; more fold into a "+N". */
export const MAX_PODS = 4;

type Box = { x: number; y: number; w: number; h: number };

/** The hull's tally band under the interior, or undefined if the hull is too shallow for marks. */
export function tallyBand(i: Box, hullBottom: number): { top: number; y: number } | undefined {
  const bandTop = i.y + i.h + 4, bandH = hullBottom - 6 - bandTop;
  return bandH >= 10 ? { top: bandTop, y: bandTop + Math.floor((bandH - 8) / 4) * 2 } : undefined;
}

/** Where the `n`th tally mark (1-based) sits: groups of five from the left of the band. */
export function tallyMark(i: Box, hullBottom: number, n: number): { x: number; y: number } | undefined {
  const band = tallyBand(i, hullBottom);
  if (!band || n < 1) return undefined;
  const group = Math.floor((n - 1) / 5), k = (n - 1) % 5;
  if (group >= Math.floor((i.w * 0.5) / 24)) return undefined;
  const x0 = i.x + 10 + group * 24;
  // The fifth is the stroke across the group.
  return k === 4 ? { x: x0 + 6, y: band.y } : { x: x0 + k * 4, y: band.y };
}

/** Where open PR pod `k` (newest first) hangs: its capsule's top-left. */
export function podSpot(i: Box, hullBottom: number, k: number): { x: number; y: number } {
  return { x: i.x + i.w - 30 - Math.min(k, MAX_PODS - 1) * 28, y: hullBottom + 10 };
}
