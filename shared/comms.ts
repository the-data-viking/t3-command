// The fleet's comms log, recorded by the Command server so every device sees the same events,
// including those that happened with no browser open.

export type CommsTone = "info" | "good" | "alert" | "bad";

export interface CommsEntry {
  /** Increasing per server; browsers resume a stream after the last id they have. */
  id: number;
  at: number;
  tone: CommsTone;
  text: string;
  envId?: string;
  threadId?: string;
}

/** Days of comms kept on the server. */
export const COMMS_RETENTION_DAYS = 30;
/** Entries a browser receives when it first connects. */
export const COMMS_BACKLOG = 300;
