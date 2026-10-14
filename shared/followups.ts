// Follow-ups: an order queued for a busy crew member, which the Command server sends when their
// current turn finishes cleanly. Visible on every device, cancellable, and globally pausable.
// A standing order is one given several times: after each send it waits on the turn that send
// started, and goes again when that ends cleanly, until its count runs out or a turn doesn't.

export interface FollowUp {
  id: string;
  envId: string;
  threadId: string;
  /** The turn it waits on: sent when this turn completes, dropped if another turn starts. Null
   * while waiting for the turn its own order started to show up. */
  afterTurnId: string | null;
  /** While `afterTurnId` is null: the latest turn when the order went out; any other is its turn. */
  startedAfter?: string | null;
  /** When it began waiting for that turn to show up. */
  waitingSince?: number;
  /** Standing orders: sends still to go, the next one included. Absent for a plain follow-up. */
  left?: number;
  /** How many sends a standing order was given. */
  total?: number;
  /** A send that errored: it may still have landed, so it's retried only if its turn never shows. */
  uncertain?: { attempts: number; retryAt: number };
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
/** The most times a standing order can be given. */
export const STANDING_MAX = 10;
/** A send that hasn't started a turn after this long is taken as not having landed. */
export const STANDING_START_MS = 3 * 60_000;
/** A send that keeps failing is given up (and said so) after this many tries. */
export const SEND_ATTEMPTS = 5;
/** First wait before resending a failed send; it doubles each time. */
export const SEND_BACKOFF_MS = 15_000;
/** The longest order text accepted. */
export const FOLLOW_UP_MAX_CHARS = 8_000;
