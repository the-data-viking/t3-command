// Read recent repeated command failures for signs of spinning. Elapsed time and inactivity
// are telemetry only: normal long-running work must not interrupt the operator.

import type { CommsLog } from "./comms.ts";
import type { HistoryRecorder } from "./history-recorder.ts";
import type { Registry } from "./registry.ts";
import type { OrchestrationThread, ThreadShell } from "../src/t3/types.ts";
import { isSubagent } from "../src/t3/derive.ts";
import { pulseOf } from "../src/ui/pulse.ts";

const CHECK_MS = 5 * 60_000;
/** A running turn is read for signs of spinning once it's been going this long. */
export const SPIN_AFTER_MS = 15 * 60_000;

/** What a turn's activity says, if it may be spinning: one line per sign, keyed so each is said once a turn. */
export function spinSigns(thread: OrchestrationThread, now: number): Array<{ key: "fail"; text: string }> {
  const p = pulseOf(thread, now);
  const name = `"${thread.title || "Untitled"}"`;
  return [
    ...(p?.repeatFail ? [{ key: "fail" as const, text: `${name} may be spinning: ${p.repeatFail.command} failed ${p.repeatFail.count}× without progress` }] : []),
  ];
}

export class LongTurns {
  private readonly registry: Registry;
  private readonly recorder: HistoryRecorder;
  private readonly comms: CommsLog;
  /** "env:thread:turn:sign" already noted. Seeded silently on the first pass after a restart. */
  private noted = new Set<string>();
  private seeded = false;
  private timer?: ReturnType<typeof setInterval>;

  private readonly read?: (envId: string, threadId: string) => Promise<OrchestrationThread>;
  private reading = new Set<string>();

  constructor(registry: Registry, recorder: HistoryRecorder, comms: CommsLog, read?: (envId: string, threadId: string) => Promise<OrchestrationThread>) {
    this.registry = registry;
    this.recorder = recorder;
    this.comms = comms;
    this.read = read;
  }

  /** Read a long-running turn's activity and say once (per turn, per sign) if it may be spinning. */
  private checkSpin(envId: string, thread: ThreadShell, now: number, announce: boolean): void {
    const turn = thread.latestTurn;
    if (!this.read || !turn || turn.state !== "running" || thread.hasPendingApprovals || thread.hasPendingUserInput) return;
    const started = Date.parse(turn.startedAt ?? turn.requestedAt);
    if (!Number.isFinite(started) || now - started < SPIN_AFTER_MS) return;
    const base = `${envId}:${thread.id}:${turn.turnId}:spin`;
    if (this.reading.has(base) || this.noted.has(`${base}:fail`)) return;
    this.reading.add(base);
    void this.read(envId, thread.id).then((full) => {
      const current = this.recorder.snapshot(envId)?.threads.find((t) => t.id === thread.id);
      if (!current || isSubagent(current) || current.latestTurn?.turnId !== turn.turnId || current.latestTurn.state !== "running" || current.hasPendingApprovals || current.hasPendingUserInput || full.latestTurn?.turnId !== turn.turnId) return;
      for (const sign of spinSigns(full, now)) {
        const key = `${base}:${sign.key}`;
        if (this.noted.has(key)) continue;
        this.noted.add(key);
        if (announce) this.comms.add({ tone: "alert", kind: "spinning", text: sign.text, envId, threadId: thread.id });
      }
    }).catch(() => { /* Unreadable now: the next check tries again. */ }).finally(() => this.reading.delete(base));
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
        if (isSubagent(thread)) continue;
        this.checkSpin(envId, thread, now, this.seeded);
      }
    }
    this.seeded = true;
  }
}
