import type { CommsKind } from "../../shared/comms";
import type { LogEntry } from "../store";

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

