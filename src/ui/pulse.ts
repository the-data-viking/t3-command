// A long turn's pulse: is it moving? When files last changed, how the tests it ran went, and two
// signs worth a look: the same command failing again and again, and a long stretch with no file
// changes while it keeps working. Read from the turn's own activity; these are prompts to look,
// never a ruling that it's stuck.

import type { OrchestrationThread } from "../t3/types.ts";
import { elapsed } from "../t3/timing.ts";
import { testsRun, type TestRun } from "../t3/tests-run.ts";

export interface Pulse {
  /** When a file last changed this turn. */
  lastChangeAt?: number;
  /** Test and check commands this turn, last run of each. */
  tests: TestRun[];
  /** A command that failed this many times this turn (3 or more). */
  repeatFail?: { command: string; count: number };
  /** Working this long with no file change (only reported past an hour). */
  noChangeMs?: number;
}

export const REPEAT_FAILS = 3;
export const NO_CHANGE_MS = 60 * 60_000;

export function pulseOf(thread: OrchestrationThread, now: number): Pulse | undefined {
  const turn = thread.latestTurn;
  if (!turn) return undefined;
  const mine = thread.activities.filter((a) => a.turnId === turn.turnId && a.kind.startsWith("tool."));
  let lastChangeAt: number | undefined;
  const failures = new Map<string, number>();
  const seen = new Set<string>();
  for (const a of mine) {
    const p = a.payload ?? {};
    if (p.itemType === "file_change" && (a.kind === "tool.completed" || p.status === "completed")) {
      const at = Date.parse(a.createdAt);
      if (Number.isFinite(at)) lastChangeAt = Math.max(lastChangeAt ?? 0, at);
    }
    const id = String(p.toolCallId ?? a.id);
    const failed = p.status === "failed" || (typeof p.exitCode === "number" && p.exitCode !== 0);
    if (!failed || seen.has(id)) continue;
    seen.add(id);
    const command = (typeof p.detail === "string" && p.detail.trim() ? p.detail : a.summary ?? "").split("\n")[0].trim();
    if (command) failures.set(command, (failures.get(command) ?? 0) + 1);
  }
  const worst = [...failures].sort((a, b) => b[1] - a[1])[0];
  const started = Date.parse(turn.startedAt ?? turn.requestedAt);
  const running = turn.state === "running";
  const since = lastChangeAt ?? (Number.isFinite(started) ? started : undefined);
  const noChangeMs = running && since !== undefined && now - since > NO_CHANGE_MS ? now - since : undefined;
  return {
    ...(lastChangeAt ? { lastChangeAt } : {}),
    tests: testsRun(thread),
    ...(worst && worst[1] >= REPEAT_FAILS ? { repeatFail: { command: worst[0].length > 60 ? `${worst[0].slice(0, 59)}…` : worst[0], count: worst[1] } } : {}),
    ...(noChangeMs ? { noChangeMs } : {}),
  };
}

/** A turn's pulse on one line: last file change, the tests it ran, and anything worth a look. */
export function pulseText(p: Pulse, now: number): string {
  return [
    p.repeatFail && `⚠ ${p.repeatFail.command} failed ${p.repeatFail.count}× this turn`,
    p.noChangeMs && `no file changes in ${elapsed(p.noChangeMs)}`,
    !p.noChangeMs && p.lastChangeAt && `files changed ${elapsed(now - p.lastChangeAt)} ago`,
    p.tests.length > 0 && `tests ${p.tests.map((t) => (t.outcome === "passed" ? "✓" : t.outcome === "failed" ? "✕" : t.outcome === "ran" ? "·" : "…")).join("")}`,
  ].filter(Boolean).join(" · ");
}
