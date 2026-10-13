// Station memory: what each project's crews have done, from the Command server's turn history,
// so the map can wear it (shelves of finished work, patch plates for failures).

import type { TurnRecord } from "./history.ts";

export interface ProjectMemory {
  /** Turns that finished cleanly, and turns that failed, over the history window. */
  completed: number;
  failed: number;
}

/** Per project copy, keyed "envId:projectId". */
export type FleetMemory = Record<string, ProjectMemory>;

export function memoryOf(records: TurnRecord[], since: number): FleetMemory {
  const out: FleetMemory = {};
  for (const r of records) {
    if (Date.parse(r.completedAt) < since || r.outcome === "interrupted") continue;
    const m = out[`${r.envId}:${r.projectId}`] ??= { completed: 0, failed: 0 };
    if (r.outcome === "completed") m.completed++;
    else m.failed++;
  }
  return out;
}
