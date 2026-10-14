// Dispatches: one order given to a whole squad, kept on the Command server so every device can
// follow it — who it went to, who has it queued for after their turn, and who it never reached.
// What each recipient has done with it since is read from their live thread, not stored.

export type DispatchHow = "sent" | "queued" | "failed";

export interface DispatchMember {
  envId: string;
  threadId: string;
  /** The crew member's title when the order went out, in case the thread is gone later. */
  title: string;
  how: DispatchHow;
  /** Their latest turn when the order went out: a different turn since means it reached them. */
  baseTurnId: string | null;
}

export interface Dispatch {
  id: string;
  text: string;
  at: number;
  members: DispatchMember[];
}

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
    const { envId, threadId, title, how, baseTurnId } = m as Partial<DispatchMember>;
    if (typeof envId !== "string" || !envId || typeof threadId !== "string" || !threadId || !HOW.has(how as DispatchHow)) continue;
    const key = `${envId}:${threadId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ envId, threadId, title: String(title ?? "").slice(0, 120), how: how as DispatchHow, baseTurnId: typeof baseTurnId === "string" ? baseTurnId : null });
    if (out.length >= DISPATCH_MAX_MEMBERS) break;
  }
  return out;
}

export function clipText(text: string): string {
  const t = text.trim();
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1)}…` : t;
}
