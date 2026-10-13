// What a station has been through, worn on its hull: tally marks for merged PRs, patch plates for
// failed turns, and archive shelves that fill with finished work. Drawn from real history only.

import type { GameState } from "../store";
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
