// Long turns, noticed by the Command server: a comms note when a running turn passes 2, 6, 12 and
// 24 hours, so a runaway agent stands out even if nobody is watching the map.

import type { CommsLog } from "./comms.ts";
import type { HistoryRecorder } from "./history-recorder.ts";
import type { Registry } from "./registry.ts";
import type { ThreadShell } from "../src/t3/types.ts";

export const LONG_TURN_HOURS = [2, 6, 12, 24];
/** A running turn with no update for this long (and not waiting on you) has gone quiet. */
export const QUIET_MS = 20 * 60_000;

/** Has a running turn gone quiet: no update for QUIET_MS, and not just waiting on your answer? */
export function quietSince(thread: ThreadShell, now: number): number | undefined {
  if (thread.latestTurn?.state !== "running" || thread.hasPendingApprovals || thread.hasPendingUserInput) return undefined;
  const updated = Date.parse(thread.updatedAt);
  return Number.isFinite(updated) && now - updated >= QUIET_MS ? updated : undefined;
}
const CHECK_MS = 5 * 60_000;

/** Thresholds a running turn has passed (hours), newest last. */
export function passed(thread: ThreadShell, now: number): number[] {
  const turn = thread.latestTurn;
  if (turn?.state !== "running") return [];
  const started = Date.parse(turn.startedAt ?? turn.requestedAt);
  if (!Number.isFinite(started)) return [];
  return LONG_TURN_HOURS.filter((h) => now - started >= h * 3_600_000);
}

export class LongTurns {
  private readonly registry: Registry;
  private readonly recorder: HistoryRecorder;
  private readonly comms: CommsLog;
  /** "env:thread:turn:hours" already noted. Seeded silently on the first pass after a restart. */
  private noted = new Set<string>();
  private seeded = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(registry: Registry, recorder: HistoryRecorder, comms: CommsLog) {
    this.registry = registry;
    this.recorder = recorder;
    this.comms = comms;
  }

  start(): void {
    setTimeout(() => this.check(), 60_000).unref();
    this.timer = setInterval(() => this.check(), CHECK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  check(now = Date.now()): void {
    for (const envId of this.registry.ids()) {
      const snapshot = this.recorder.snapshot(envId);
      for (const thread of snapshot?.threads ?? []) {
        for (const hours of passed(thread, now)) {
          const key = `${envId}:${thread.id}:${thread.latestTurn!.turnId}:${hours}`;
          if (this.noted.has(key)) continue;
          this.noted.add(key);
          // After a restart, turns already past a threshold were (or would have been) noted before.
          if (this.seeded) this.comms.add({ tone: hours >= 12 ? "bad" : "alert", kind: "long-turn", text: `"${thread.title || "Untitled"}" has been running for ${hours} hours`, envId, threadId: thread.id });
        }
        // Gone quiet: noted once per stretch of silence (a new update starts a new stretch).
        const quiet = quietSince(thread, now);
        if (quiet !== undefined) {
          const key = `${envId}:${thread.id}:quiet:${quiet}`;
          if (!this.noted.has(key)) {
            this.noted.add(key);
            if (this.seeded) this.comms.add({ tone: "alert", kind: "quiet", text: `"${thread.title || "Untitled"}" has gone quiet: no update for ${Math.floor((now - quiet) / 60_000)} minutes`, envId, threadId: thread.id });
          }
        }
      }
    }
    this.seeded = true;
  }
}
