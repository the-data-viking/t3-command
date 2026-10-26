/** T3 v2 progressive HTTP transport. Cursors are opaque and never synthesized by Command. */
export type Projection = Record<string, unknown>;
export interface ThreadHistory {
  cursor: string | null;
  hasMore: boolean;
  loading?: boolean;
  error?: string;
}
export interface BoundedThreadSnapshot {
  snapshotSequence: number;
  projection: Projection;
  historyCursor?: string | null;
  hasMoreHistory?: boolean;
  turnItemsOmitLocalVisible?: true;
}
export interface ThreadHistoryPage {
  snapshotSequence: number;
  items: Projection[];
  nextCursor: string | null;
  hasMoreHistory: boolean;
}

/** Keep only lifecycle fields; provider subagent records can also contain large prompts/results. */
export function subagentRecord(value: Projection): Projection {
  return Object.fromEntries(["id", "threadId", "childThreadId", "origin", "runId", "status", "startedAt", "completedAt", "updatedAt"]
    .filter((key) => key in value).map((key) => [key, value[key]]));
}
export function subagentSnapshot(snapshot: BoundedThreadSnapshot): BoundedThreadSnapshot {
  return { snapshotSequence: snapshot.snapshotSequence, projection: {
    thread: { id: (snapshot.projection.thread as Projection)?.id },
    subagents: (snapshot.projection.subagents as Projection[] ?? []).map(subagentRecord),
  } };
}
