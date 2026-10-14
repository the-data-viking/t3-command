// Dispatches: one order given to a whole squad, kept on the Command server so every device can
// follow it — who it went to, who has it queued for after their turn, and who it never reached.
// What each recipient has done with it since is read from their live thread, not stored.
// A mission is a dispatch with a name and a goal, where each crew member may have their own part.

export type DispatchHow = "sent" | "queued" | "failed";

export interface DispatchMember {
  envId: string;
  threadId: string;
  /** The crew member's title when the order went out, in case the thread is gone later. */
  title: string;
  how: DispatchHow;
  /** Their latest turn when the order went out: a different turn since means it reached them. */
  baseTurnId: string | null;
  /** On a mission: this crew member's own part of it. */
  part?: string;
  /** Queued, then dropped by the Command server without being sent (cancelled, failed, replaced…). */
  dropped?: boolean;
  /** The turn this order started, once the Command server saw it: later turns aren't this order's. */
  turnId?: string;
  /** How that turn ended, as the server saw it ("superseded": another turn started before it saw it end). */
  result?: TurnResult;
  /** Exactly what this crew member was sent, so a resend sends the same. */
  brief?: string;
}

export type TurnResult = "completed" | "error" | "interrupted" | "superseded";
const RESULTS = new Set<TurnResult>(["completed", "error", "interrupted", "superseded"]);
/** The longest brief kept per member (the order limit). */
const BRIEF_MAX = 8_000;

export interface MissionInfo {
  name: string;
  goal: string;
}

export interface Dispatch {
  id: string;
  text: string;
  at: number;
  members: DispatchMember[];
  /** Set when the order was a mission: its name and goal (the order text is each member's brief). */
  mission?: MissionInfo;
  /** When the Command server saw every member's part of it end (and said so in the comms log). */
  finishedAt?: number;
  /** A later round of a mission: the first round's id, and this round's number (2, 3, …). */
  missionId?: string;
  round?: number;
}

/** The id that ties a mission's rounds together (a plain order is its own group). */
export const groupOf = (d: Pick<Dispatch, "id" | "missionId">): string => d.missionId ?? d.id;

/** An order sent now whose turn hasn't started after this long didn't start. */
export const DISPATCH_START_MS = 3 * 60_000;
/** Dispatches stop being tracked after this long, or when you close them. */
export const DISPATCH_TTL_MS = 3 * 24 * 3_600_000;
export const DISPATCH_MAX = 30;
export const DISPATCH_MAX_MEMBERS = 50;
const TEXT_MAX = 2_000;

const HOW = new Set<DispatchHow>(["sent", "queued", "failed"]);

/** Validate a client's members: unknown shapes dropped, one entry per crew member, at most 50. */
export function sanitizeMembers(input: unknown): DispatchMember[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: DispatchMember[] = [];
  for (const m of input) {
    if (!m || typeof m !== "object") continue;
    const { envId, threadId, title, how, baseTurnId, part, dropped, turnId, result, brief } = m as Partial<DispatchMember>;
    if (typeof envId !== "string" || !envId || typeof threadId !== "string" || !threadId || !HOW.has(how as DispatchHow)) continue;
    const key = `${envId}:${threadId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ownPart = typeof part === "string" ? part.trim().slice(0, 500) : "";
    out.push({ envId, threadId, title: String(title ?? "").slice(0, 120), how: how as DispatchHow, baseTurnId: typeof baseTurnId === "string" ? baseTurnId : null, ...(ownPart ? { part: ownPart } : {}), ...(dropped === true && how === "queued" ? { dropped: true } : {}),
      ...(typeof turnId === "string" && turnId ? { turnId } : {}), ...(RESULTS.has(result as TurnResult) ? { result: result as TurnResult } : {}),
      ...(typeof brief === "string" && brief.trim() ? { brief: brief.slice(0, BRIEF_MAX) } : {}) });
    if (out.length >= DISPATCH_MAX_MEMBERS) break;
  }
  return out;
}

export function clipText(text: string): string {
  const t = text.trim();
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1)}…` : t;
}

/** A mission's name and goal from a client: undefined (an ordinary squad order) unless both are set. */
export function sanitizeMission(input: unknown): MissionInfo | undefined {
  if (!input || typeof input !== "object") return undefined;
  const name = String((input as MissionInfo).name ?? "").trim().slice(0, 60);
  const goal = clipText(String((input as MissionInfo).goal ?? ""));
  return name && goal ? { name, goal } : undefined;
}
