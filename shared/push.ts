// Push notifications to your devices (Web Push): which fleet events reach you, and quiet hours.

import type { CommsKind } from "./comms.ts";

/** The comms kinds that can be pushed, in the order the settings list them. */
export const PUSH_KINDS = ["approval", "question", "failed", "spinning", "quiet", "long-turn", "merged", "done", "mission", "offline", "disk"] as const satisfies readonly CommsKind[];
export type PushKind = (typeof PUSH_KINDS)[number];

export const PUSH_LABELS: Record<PushKind, string> = {
  approval: "Needs your approval",
  question: "Has a question",
  failed: "A turn failed",
  spinning: "A turn may be spinning (the same command failing, or no file changes for an hour)",
  quiet: "A turn went quiet",
  "long-turn": "A turn is running long",
  merged: "A PR merged",
  done: "A job finished",
  mission: "A squad order or mission finished",
  offline: "A machine went offline",
  disk: "A disk is running low",
};

export interface PushRules {
  kinds: Record<PushKind, boolean>;
  /** Quiet hours: only the allowed kinds come through between start and end (local "HH:MM"). */
  quiet: { enabled: boolean; start: string; end: string; timeZone: string; allow: PushKind[] };
}

export const DEFAULT_PUSH_RULES: PushRules = {
  kinds: { approval: true, question: true, failed: true, spinning: true, quiet: true, "long-turn": true, merged: true, done: false, mission: true, offline: true, disk: true },
  quiet: { enabled: false, start: "22:00", end: "07:00", timeZone: "UTC", allow: ["approval"] },
};

/** Minutes since midnight of "HH:MM", or undefined if malformed. */
function minutes(hhmm: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return undefined;
  const h = Number(m[1]), min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : undefined;
}

/** Is `at` inside quiet hours (which may wrap past midnight)? */
export function inQuietHours(rules: PushRules, at: Date): boolean {
  if (!rules.quiet.enabled) return false;
  const start = minutes(rules.quiet.start), end = minutes(rules.quiet.end);
  if (start === undefined || end === undefined || start === end) return false;
  let now: number;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: rules.quiet.timeZone }).formatToParts(at);
    now = Number(parts.find((p) => p.type === "hour")?.value) * 60 + Number(parts.find((p) => p.type === "minute")?.value);
  } catch {
    return false;
  }
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** Should an entry of this kind be pushed now? */
export function shouldPush(rules: PushRules, kind: CommsKind | undefined, at: Date): boolean {
  if (!kind || !(PUSH_KINDS as readonly string[]).includes(kind)) return false;
  const k = kind as PushKind;
  if (!rules.kinds[k]) return false;
  return !inQuietHours(rules, at) || rules.quiet.allow.includes(k);
}

/** One device's own filter on top of the fleet's rules: only these kinds (none mutes it), or all. */
export type DeviceKinds = PushKind[] | null;

export function sanitizeDeviceKinds(input: unknown): DeviceKinds | undefined {
  if (input === null) return null;
  if (!Array.isArray(input)) return undefined;
  return PUSH_KINDS.filter((k) => input.includes(k));
}

/** Does a device's own filter let this kind through? (The fleet's rules are checked first.) */
export function deviceWants(kinds: DeviceKinds | undefined, kind: CommsKind | undefined): boolean {
  return !kinds || (!!kind && (kinds as string[]).includes(kind));
}

/** Validate rules from a client: unknown fields dropped, defaults filled in. */
export function sanitizeRules(input: unknown): PushRules | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Partial<PushRules>;
  const kinds = { ...DEFAULT_PUSH_RULES.kinds };
  for (const k of PUSH_KINDS) if (typeof raw.kinds?.[k] === "boolean") kinds[k] = raw.kinds[k];
  const q = raw.quiet ?? DEFAULT_PUSH_RULES.quiet;
  const quiet = {
    enabled: q.enabled === true,
    start: typeof q.start === "string" && minutes(q.start) !== undefined ? q.start : DEFAULT_PUSH_RULES.quiet.start,
    end: typeof q.end === "string" && minutes(q.end) !== undefined ? q.end : DEFAULT_PUSH_RULES.quiet.end,
    timeZone: typeof q.timeZone === "string" && q.timeZone.length < 64 ? q.timeZone : "UTC",
    allow: Array.isArray(q.allow) ? q.allow.filter((k): k is PushKind => (PUSH_KINDS as readonly string[]).includes(k)) : DEFAULT_PUSH_RULES.quiet.allow,
  };
  return { kinds, quiet };
}
