// "While you were away": a briefing from the comms log since you last looked, after 30+ minutes.

import type { CommsKind } from "../../shared/comms";
import type { LogEntry } from "../store";

export const AWAY_MS = 30 * 60_000;

export interface Digest {
  since: number;
  done: number;
  failed: number;
  waiting: number;
  merged: number;
  /** What landed: merged PRs, newest last. */
  landed: LogEntry[];
  /** The entries worth reading in full (failures, machines, disks, long turns, T3 updates), newest last. */
  notable: LogEntry[];
}

/** Entries written before kinds existed (or by an older server) are read by their words. */
const LEGACY: Array<[CommsKind, RegExp]> = [
  ["done", /^Job's done|" finished$/],
  ["failed", /was hurt|" failed/],
  ["approval", /needs your approval/],
  ["question", /has a question/],
  ["merged", /: PR #\d+ merged/],
];

export function entryKind(e: LogEntry): CommsKind {
  return e.kind ?? LEGACY.find(([, re]) => re.test(e.text))?.[0] ?? "info";
}

export function digest(entries: LogEntry[], since: number): Digest | undefined {
  const fresh = entries.filter((e) => e.at > since);
  if (!fresh.length) return undefined;
  const d: Digest = { since, done: 0, failed: 0, waiting: 0, merged: 0, landed: [], notable: [] };
  for (const e of fresh) {
    const kind = entryKind(e);
    if (kind === "done") d.done++;
    else if (kind === "approval" || kind === "question") d.waiting++;
    else if (kind === "merged") { d.merged++; d.landed.push(e); }
    else if (kind === "failed") { d.failed++; d.notable.push(e); }
    else if (e.tone === "bad" || e.tone === "alert") d.notable.push(e);
  }
  d.notable = d.notable.slice(-5);
  d.landed = d.landed.slice(-5);
  return d.done || d.failed || d.waiting || d.merged || d.notable.length ? d : undefined;
}
