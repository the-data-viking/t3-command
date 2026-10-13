// "While you were away": a summary of the comms log since you last looked, after 30+ minutes.

import type { LogEntry } from "../store";

export const AWAY_MS = 30 * 60_000;

export interface Digest {
  since: number;
  done: number;
  failed: number;
  waiting: number;
  /** The entries worth reading in full (failures, machines, disks, long turns, T3 updates), newest last. */
  notable: LogEntry[];
}

const KINDS: Array<[keyof Pick<Digest, "done" | "failed" | "waiting">, RegExp]> = [
  ["done", /^Job's done/],
  ["failed", /was hurt/],
  ["waiting", /needs your approval|has a question/],
];

export function digest(entries: LogEntry[], since: number): Digest | undefined {
  const fresh = entries.filter((e) => e.at > since);
  if (!fresh.length) return undefined;
  const d: Digest = { since, done: 0, failed: 0, waiting: 0, notable: [] };
  for (const e of fresh) {
    const kind = KINDS.find(([, re]) => re.test(e.text))?.[0];
    if (kind) d[kind]++;
    else if (e.tone === "bad" || e.tone === "alert") d.notable.push(e);
  }
  d.notable = d.notable.slice(-5);
  return d.done || d.failed || d.waiting || d.notable.length ? d : undefined;
}
