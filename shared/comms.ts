// The fleet's comms log, recorded by the Command server so every device sees the same events,
// including those that happened with no browser open.

export type CommsTone = "info" | "good" | "alert" | "bad";

/**
 * What an entry is about, so views can count, filter and link it without reading its words.
 * Entries written before kinds existed have none; treat those as "info".
 */
export type CommsKind =
  | "approval" | "question" | "failed" | "done" | "started" | "monitoring" | "merged" | "quiet"
  | "offline" | "online" | "disk" | "long-turn" | "update" | "info";

/** Routine entries a log can fold away: work starting and background watching. */
export const ROUTINE_KINDS: ReadonlySet<CommsKind> = new Set(["started", "monitoring"]);

export interface CommsEntry {
  /** Increasing per server; browsers resume a stream after the last id they have. */
  id: number;
  at: number;
  tone: CommsTone;
  kind?: CommsKind;
  text: string;
  envId?: string;
  threadId?: string;
}

/** Days of comms kept on the server. */
export const COMMS_RETENTION_DAYS = 30;
/** Entries a browser receives when it first connects. */
export const COMMS_BACKLOG = 300;
