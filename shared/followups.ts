// Follow-ups: an order queued for a busy crew member, which the Command server sends when their
// current turn finishes cleanly. Visible on every device, cancellable, and globally pausable.

export interface FollowUp {
  id: string;
  envId: string;
  threadId: string;
  /** The turn it waits on: sent when this turn completes, dropped if another turn starts. */
  afterTurnId: string;
  text: string;
  createdAt: number;
  expiresAt: number;
}

export interface FollowUpsView {
  paused: boolean;
  queued: FollowUp[];
}

/** Queued follow-ups expire after this long, so a stale order never fires days later. */
export const FOLLOW_UP_TTL_MS = 12 * 3_600_000;
/** The longest order text accepted. */
export const FOLLOW_UP_MAX_CHARS = 8_000;
