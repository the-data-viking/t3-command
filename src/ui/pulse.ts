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

/** A command as you'd type it: without the shell wrapper agents run it in (`/bin/bash -lc "…"`). */
export function bareCommand(line: string): string {
  const m = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(["']?)([\s\S]*?)\1?\s*$/.exec(line.trim());
  return (m ? m[2] : line).trim();
}
export const NO_CHANGE_MS = 60 * 60_000;

/**
 * A shell command that writes files (sed -i, a heredoc into python or a file, redirection, tee, a
 * patch, a commit…): agents edit through the shell as much as through edit tools, and those edits
 * are progress too. A heuristic, so it only ever makes "no file changes" less likely to fire.
 */
const WRITES = /\bsed\s+-i|\bperl\s+-[a-z]*i|<<\s*['"]?\w|(^|[^<>&0-9])>>?\s*[^\s&>]|\btee\b|\bapply_patch\b|\bpatch\s|\bgit\s+(commit|apply|am|cherry-pick|merge|rebase|mv|rm)\b|\b(mv|cp|rm|mkdir|touch)\s/;
export function writesFiles(command: string): boolean {
  return WRITES.test(bareCommand(command));
}

export function pulseOf(thread: OrchestrationThread, now: number): Pulse | undefined {
  const turn = thread.latestTurn;
  if (!turn) return undefined;
  const mine = thread.activities.filter((a) => a.turnId === turn.turnId && a.kind.startsWith("tool."));
  let lastChangeAt: number | undefined;
  // Failing commands by their whole text (a heredoc's body tells two `python3 - <<EOF` scripts
  // apart), each shown by its first line.
  const failures = new Map<string, { count: number; shown: string }>();
  const seen = new Set<string>();
  for (const a of mine) {
    const p = a.payload ?? {};
    const done = a.kind === "tool.completed" || p.status === "completed";
    const ok = p.status !== "failed" && !(typeof p.exitCode === "number" && p.exitCode !== 0);
    const shellEdit = p.itemType === "command_execution" && ok && writesFiles(typeof p.detail === "string" ? p.detail : a.summary ?? "");
    if ((p.itemType === "file_change" || shellEdit) && done) {
      const at = Date.parse(a.createdAt);
      if (Number.isFinite(at)) lastChangeAt = Math.max(lastChangeAt ?? 0, at);
    }
    const id = String(p.toolCallId ?? a.id);
    const failed = p.status === "failed" || (typeof p.exitCode === "number" && p.exitCode !== 0);
    if (!failed || seen.has(id)) continue;
    seen.add(id);
    const text = (typeof p.detail === "string" && p.detail.trim() ? p.detail : a.summary ?? "").trim();
    const shown = bareCommand(text.split("\n")[0]);
    if (!shown) continue;
    const key = bareCommand(text);
    const f = failures.get(key);
    failures.set(key, { count: (f?.count ?? 0) + 1, shown });
  }
  const worst = [...failures.values()].sort((a, b) => b.count - a.count)[0];
  const started = Date.parse(turn.startedAt ?? turn.requestedAt);
  const running = turn.state === "running";
  const since = lastChangeAt ?? (Number.isFinite(started) ? started : undefined);
  const noChangeMs = running && since !== undefined && now - since > NO_CHANGE_MS ? now - since : undefined;
  return {
    ...(lastChangeAt ? { lastChangeAt } : {}),
    tests: testsRun(thread),
    ...(worst && worst.count >= REPEAT_FAILS ? { repeatFail: { command: worst.shown.length > 60 ? `${worst.shown.slice(0, 59)}…` : worst.shown, count: worst.count } } : {}),
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
