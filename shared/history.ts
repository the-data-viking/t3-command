// Turn history recorded by the Command server, and the summary the History panel shows.

export type TurnOutcome = "completed" | "error" | "interrupted";

/** One finished turn, as observed on a thread's latestTurn. */
export interface TurnRecord {
  envId: string;
  envLabel: string;
  projectId: string;
  projectTitle: string;
  threadId: string;
  threadTitle: string;
  turnId: string;
  /** Provider instance (codex, claudeAgent, hermes…) and model slug. */
  provider: string;
  model: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  /** Part of the duration spent waiting on the operator (approvals, questions), when watched live. */
  waitMs?: number;
  outcome: TurnOutcome;
  /** The provider's error text for failed turns, shortened. */
  error?: string;
}

/** A period during which the recorder was following an environment. */
export interface CoverageSpan { envId: string; from: string; to: string }

export interface HistoryDay {
  day: string;
  completed: number;
  error: number;
  interrupted: number;
  /** Total working time of turns that finished that day. */
  durationMs: number;
}

export interface HistoryRanking { name: string; turns: number; durationMs: number }

export interface HistorySummary {
  days: number;
  timeZone: string;
  /** Earliest moment anything was recorded; nothing before it is known. */
  recordingSince?: string;
  totals: { turns: number; completed: number; error: number; interrupted: number; waitingMs: number; medianMs?: number; p90Ms?: number; longestMs?: number };
  daily: HistoryDay[];
  topErrors: Array<{ error: string; count: number }>;
  projects: HistoryRanking[];
  models: HistoryRanking[];
  /** Spans in the window when an environment the recorder knows was not being followed. */
  gaps: Array<{ envId: string; envLabel: string; from: string; to: string }>;
  recent: TurnRecord[];
}

export const HISTORY_RETENTION_DAYS = 90;
/** Shorter outages (a redeploy) aren't worth flagging; the snapshot afterwards recovers them. */
export const GAP_THRESHOLD_MS = 5 * 60_000;

/** Calendar day of an instant in a time zone, as YYYY-MM-DD. */
export function dayIn(iso: string | number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** The agent's own working time for a turn. */
export function agentMs(r: TurnRecord): number {
  return Math.max(0, r.durationMs - (r.waitMs ?? 0));
}

/**
 * Failure text with its variable parts (numbers, ids, paths, quoted values) blanked, so the same
 * failure counts as one kind however its details differ.
 */
export function errorKind(error: string): string {
  return error.toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "<id>")
    .replace(/(["'`]).*?\1/g, "<q>")
    .replace(/(?:\/[\w.-]+){2,}/g, "<path>")
    .replace(/\b[0-9a-f]{7,}\b/g, "<id>")
    .replace(/\d+(?:\.\d+)?/g, "#")
    .replace(/\s+/g, " ").trim();
}

function percentile(sorted: number[], p: number): number | undefined {
  if (!sorted.length) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

function rank(records: TurnRecord[], key: (r: TurnRecord) => string, limit = 6): HistoryRanking[] {
  const by = new Map<string, HistoryRanking>();
  for (const r of records) {
    const name = key(r);
    const row = by.get(name) ?? { name, turns: 0, durationMs: 0 };
    row.turns++;
    row.durationMs += r.durationMs;
    by.set(name, row);
  }
  return [...by.values()].sort((a, b) => b.turns - a.turns || b.durationMs - a.durationMs).slice(0, limit);
}

export function summarizeHistory(records: TurnRecord[], coverage: CoverageSpan[], labels: Record<string, string>,
  opts: { days: number; timeZone: string; now?: number }): HistorySummary {
  const now = opts.now ?? Date.now();
  const today = dayIn(now, opts.timeZone);
  const first = new Date(`${today}T12:00:00Z`);
  first.setUTCDate(first.getUTCDate() - (opts.days - 1));
  const days: string[] = [];
  for (let d = new Date(first); d.toISOString().slice(0, 10) <= today; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  const sinceDay = days[0];
  const inWindow = records.filter((r) => dayIn(r.completedAt, opts.timeZone) >= sinceDay);
  const daily = new Map(days.map((day) => [day, { day, completed: 0, error: 0, interrupted: 0, durationMs: 0 }]));
  for (const r of inWindow) {
    const row = daily.get(dayIn(r.completedAt, opts.timeZone));
    if (!row) continue;
    row[r.outcome]++;
    row.durationMs += r.durationMs;
  }
  // Turn times measure the agent's own work: time spent waiting on the operator is excluded.
  const durations = inWindow.filter((r) => r.outcome === "completed").map(agentMs).sort((a, b) => a - b);
  const errors = new Map<string, { error: string; count: number }>();
  for (const r of inWindow) {
    if (r.outcome !== "error" || !r.error) continue;
    const key = errorKind(r.error);
    const row = errors.get(key) ?? { error: r.error, count: 0 };
    row.count++;
    errors.set(key, row);
  }

  // Coverage gaps: between consecutive spans of an environment, and from its last span to now
  // if it is no longer followed. Only within the window, and only if long enough to matter.
  const windowStart = Date.parse(`${sinceDay}T00:00:00Z`) - 14 * 3_600_000; // generous: day boundaries are zone-local
  const gaps: HistorySummary["gaps"] = [];
  const byEnv = new Map<string, CoverageSpan[]>();
  for (const span of coverage) byEnv.set(span.envId, [...(byEnv.get(span.envId) ?? []), span]);
  for (const [envId, spans] of byEnv) {
    spans.sort((a, b) => a.from.localeCompare(b.from));
    for (let i = 0; i < spans.length; i++) {
      const end = Date.parse(spans[i].to);
      const next = i + 1 < spans.length ? Date.parse(spans[i + 1].from) : now;
      if (next - end >= GAP_THRESHOLD_MS && next > windowStart) {
        gaps.push({ envId, envLabel: labels[envId] ?? envId, from: new Date(Math.max(end, windowStart)).toISOString(), to: new Date(next).toISOString() });
      }
    }
  }
  const recordingSince = coverage.length ? coverage.map((s) => s.from).sort()[0] : undefined;

  return {
    days: opts.days,
    timeZone: opts.timeZone,
    recordingSince,
    totals: {
      turns: inWindow.length,
      completed: inWindow.filter((r) => r.outcome === "completed").length,
      error: inWindow.filter((r) => r.outcome === "error").length,
      interrupted: inWindow.filter((r) => r.outcome === "interrupted").length,
      waitingMs: inWindow.reduce((n, r) => n + (r.waitMs ?? 0), 0),
      medianMs: percentile(durations, 0.5),
      p90Ms: percentile(durations, 0.9),
      longestMs: durations.at(-1),
    },
    daily: [...daily.values()],
    topErrors: [...errors.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    projects: rank(inWindow, (r) => r.projectTitle),
    models: rank(inWindow, (r) => r.model),
    gaps: gaps.sort((a, b) => b.to.localeCompare(a.to)).slice(0, 10),
    recent: [...inWindow].sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, 25),
  };
}
