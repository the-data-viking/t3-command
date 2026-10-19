// Turn history: one record per finished turn, kept for 90 days in owner-only files.
//
// While following an environment, a turn is recorded when a thread's latestTurn changes into a
// finished state. The first snapshot after (re)connecting uses a watermark instead (the last
// moment the recorder was watching): turns that finished after it are recorded, so the first
// start records nothing old (no backfill) and a turn that finished during a short outage is
// still recovered. Only additional turns within an outage are lost; coverage spans show when.

import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectShell, ThreadShell } from "../src/t3/types.ts";
import { isSubagent } from "../src/t3/derive.ts";
import {
  GAP_THRESHOLD_MS, HISTORY_RETENTION_DAYS, summarizeHistory,
  type CoverageSpan, type HistorySummary, type TimelineView, type TurnOutcome, type TurnRecord,
} from "../shared/history.ts";
import { memoryOf, type FleetMemory } from "../shared/memory.ts";

const TERMINAL = new Set<string>(["completed", "error", "interrupted"]);
/** Wait spans kept per turn; past this, the total (waitMs) still counts them all. */
const MAX_WAITS = 20;
const DAY_MS = 86_400_000;

interface EnvState { watermark: string; spans: Array<{ from: string; to: string }>; subagentThreadIds?: string[] }
interface State { envs: Record<string, EnvState> }

/** The provider and model a turn ran on; Hermes reports its bot profile rather than "default". */
function turnModel(t: ThreadShell): { provider: string; model: string } {
  const provider = t.session?.providerInstanceId ?? t.modelSelection.instanceId;
  if (provider === "hermes") return { provider, model: `${t.hermesProfile ?? "default"} (Hermes)` };
  return { provider, model: t.modelSelection.model };
}

export class TurnHistory {
  private readonly file: string;
  private readonly stateFile: string;
  private records: TurnRecord[] = [];
  private keys = new Set<string>();
  private state: State = { envs: {} };
  private labels: Record<string, string> = {};
  /** Also classifies older records that predate persisted child metadata. */
  private subagentThreads = new Set<string>();
  /** Environments currently being followed: their open span is extended as they report. */
  private live = new Set<string>();
  /** Per environment, each thread's last seen "turnId:state", since the latest (re)connect. */
  private known = new Map<string, Map<string, string>>();
  /**
   * Running turns seen live, keyed env|thread: the model chosen when the turn started (a thread's
   * selection can change later) and time spent waiting on the operator (approvals, questions).
   */
  private running = new Map<string, { turnId: string; provider: string; model: string; waitMs: number; waitingSince?: number; waits: Array<[number, number]> }>();
  private writes: Promise<void> = Promise.resolve();
  private stateDirty = false;
  private readonly now: () => number;

  constructor(dataDir: string, now: () => number = Date.now) {
    this.file = path.join(dataDir, "turn-history.jsonl");
    this.stateFile = path.join(dataDir, "turn-history-state.json");
    this.now = now;
  }

  async load(): Promise<void> {
    try {
      const lines = (await fs.readFile(this.file, "utf8")).split("\n").filter(Boolean);
      for (const line of lines) {
        try { this.remember(JSON.parse(line) as TurnRecord); } catch { /* A torn final line from a crash. */ }
      }
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    try {
      this.state = JSON.parse(await fs.readFile(this.stateFile, "utf8")) as State;
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    for (const [envId, env] of Object.entries(this.state.envs)) {
      for (const id of env.subagentThreadIds ?? []) this.subagentThreads.add(`${envId}|${id}`);
    }
    await this.prune();
  }

  /** Start following an environment. The first time ever, nothing earlier is recorded. */
  connected(envId: string, label: string): void {
    const at = new Date(this.now()).toISOString();
    this.labels[envId] = label;
    const env = this.state.envs[envId] ??= { watermark: at, spans: [] };
    const last = env.spans.at(-1);
    // Reconnecting quickly (a blip) continues the span rather than starting a new one.
    if (last && Date.parse(at) - Date.parse(last.to) < GAP_THRESHOLD_MS) last.to = at;
    else env.spans.push({ from: at, to: at });
    this.live.add(envId);
    this.known.delete(envId);
    this.stateDirty = true;
  }

  disconnected(envId: string): void {
    if (!this.live.delete(envId)) return;
    this.touch(envId);
  }

  /** Record every newly finished turn in an environment's current threads. */
  observe(envId: string, projects: Record<string, ProjectShell>, threads: ThreadShell[]): void {
    const env = this.state.envs[envId];
    if (!env) return;
    const watermark = Date.parse(env.watermark);
    let known = this.known.get(envId);
    const snapshot = !known;
    if (!known) this.known.set(envId, (known = new Map()));
    const now = this.now();
    const present = new Set<string>();
    for (const t of threads) {
      if (isSubagent(t) && !this.subagentThreads.has(`${envId}|${t.id}`)) {
        this.subagentThreads.add(`${envId}|${t.id}`);
        (env.subagentThreadIds ??= []).push(t.id);
        this.stateDirty = true;
      }
      const turn = t.latestTurn;
      present.add(t.id);
      const signature = turn ? `${turn.turnId}:${turn.state}` : "";
      const previous = known.get(t.id);
      known.set(t.id, signature);
      const runKey = `${envId}|${t.id}`;
      if (turn?.state === "running") {
        let run = this.running.get(runKey);
        if (run?.turnId !== turn.turnId) this.running.set(runKey, (run = { turnId: turn.turnId, ...turnModel(t), waitMs: 0, waits: [] }));
        const waiting = !!(t.hasPendingApprovals || t.hasPendingUserInput);
        if (waiting && run.waitingSince === undefined) run.waitingSince = now;
        if (!waiting && run.waitingSince !== undefined) {
          run.waitMs += now - run.waitingSince;
          if (run.waits.length < MAX_WAITS) run.waits.push([run.waitingSince, now]);
          run.waitingSince = undefined;
        }
        continue;
      }
      if (!turn || !TERMINAL.has(turn.state) || !turn.completedAt) continue;
      const key = `${envId}|${t.id}|${turn.turnId}`;
      if (this.keys.has(key)) continue;
      if (snapshot || previous === undefined) {
        // Not watched as it happened: only if it finished after we last were watching.
        if (Date.parse(turn.completedAt) <= watermark) continue;
      } else if (previous === signature) continue;
      const started = turn.startedAt ?? turn.requestedAt ?? turn.completedAt;
      const completed = Date.parse(turn.completedAt);
      const durationMs = Math.max(0, completed - Date.parse(started));
      const run = this.running.get(runKey)?.turnId === turn.turnId ? this.running.get(runKey) : undefined;
      this.running.delete(runKey);
      const waitMs = run ? Math.min(durationMs, run.waitMs + (run.waitingSince !== undefined ? Math.max(0, completed - run.waitingSince) : 0)) : undefined;
      const waits = run ? [...run.waits, ...(run.waitingSince !== undefined && completed > run.waitingSince ? [[run.waitingSince, completed] as [number, number]] : [])].slice(0, MAX_WAITS) : [];
      const { provider, model } = run ?? turnModel(t);
      const record: TurnRecord = {
        envId, envLabel: this.labels[envId] ?? envId,
        projectId: t.projectId, projectTitle: projects[t.projectId]?.title ?? t.projectId,
        threadId: t.id, threadTitle: (t.title || "Untitled").slice(0, 160), turnId: turn.turnId,
        ...(isSubagent(t) ? { isSubagent: true } : {}),
        provider, model,
        startedAt: started, completedAt: turn.completedAt,
        durationMs,
        ...(waitMs !== undefined ? { waitMs } : {}),
        ...(waits.length ? { waits } : {}),
        outcome: turn.state as TurnOutcome,
        ...(turn.state === "error" && t.session?.lastError ? { error: t.session.lastError.slice(0, 300) } : {}),
      };
      this.remember(record);
      this.append(record);
    }
    // Threads that disappeared (removed, archived out of the shell) no longer need tracking.
    for (const id of known.keys()) if (!present.has(id)) { known.delete(id); this.running.delete(`${envId}|${id}`); }
    this.touch(envId);
  }

  summary(days: number, timeZone: string): HistorySummary {
    const coverage: CoverageSpan[] = Object.entries(this.state.envs).flatMap(([envId, env]) =>
      env.spans.map((s) => ({ envId, from: s.from, to: this.live.has(envId) && s === env.spans.at(-1) ? new Date(this.now()).toISOString() : s.to })));
    return summarizeHistory(this.records, coverage, this.labels, { days, timeZone, now: this.now() });
  }

  /** Every turn that finished in the last `hours`, oldest first, for the fleet timeline. */
  timeline(hours: number): TimelineView {
    const to = this.now(), from = to - hours * 3_600_000;
    return { from, to, turns: this.records.filter((r) => !r.isSubagent && !this.subagentThreads.has(`${r.envId}|${r.threadId}`) && Date.parse(r.completedAt) >= from).sort((a, b) => a.startedAt.localeCompare(b.startedAt)) };
  }

  /** Each project copy's finished and failed turns over the retention window, for station memory. */
  memory(): FleetMemory {
    return memoryOf(this.records, this.now() - HISTORY_RETENTION_DAYS * DAY_MS);
  }

  /** Write the coverage state if it changed; called on a timer and at shutdown. */
  async flush(): Promise<void> {
    if (!this.stateDirty) return this.writes;
    this.stateDirty = false;
    const body = JSON.stringify(this.state);
    this.writes = this.writes.then(async () => {
      await fs.writeFile(`${this.stateFile}.tmp`, body, { mode: 0o600 });
      await fs.rename(`${this.stateFile}.tmp`, this.stateFile);
    }).catch((err) => console.error("Could not save turn history state", err));
    return this.writes;
  }

  /** Drop records and coverage older than the retention window, rewriting the log. */
  async prune(): Promise<void> {
    const cutoff = this.now() - HISTORY_RETENTION_DAYS * DAY_MS;
    const kept = this.records.filter((r) => Date.parse(r.completedAt) >= cutoff);
    for (const env of Object.values(this.state.envs)) env.spans = env.spans.filter((s) => Date.parse(s.to) >= cutoff);
    this.stateDirty = true;
    if (kept.length !== this.records.length) {
      this.records = kept;
      this.keys = new Set(kept.map((r) => `${r.envId}|${r.threadId}|${r.turnId}`));
      const body = kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : "");
      this.writes = this.writes.then(async () => {
        await fs.writeFile(`${this.file}.tmp`, body, { mode: 0o600 });
        await fs.rename(`${this.file}.tmp`, this.file);
      });
    }
    await this.flush();
  }

  private remember(record: TurnRecord): void {
    this.records.push(record);
    this.keys.add(`${record.envId}|${record.threadId}|${record.turnId}`);
  }

  private append(record: TurnRecord): void {
    const line = JSON.stringify(record) + "\n";
    this.writes = this.writes.then(() => fs.appendFile(this.file, line, { mode: 0o600 }))
      .catch((err) => console.error("Could not append turn history", err));
  }

  /** The environment was observed just now: advance its watermark and open span. */
  private touch(envId: string): void {
    const env = this.state.envs[envId];
    if (!env) return;
    const at = new Date(this.now()).toISOString();
    env.watermark = at;
    const last = env.spans.at(-1);
    if (last) last.to = at;
    this.stateDirty = true;
  }
}
