// T3's usage scan covers native provider history, including work outside T3.
export interface UsageSource {
  fingerprint: { hostId: string; provider: string; resolvedHomePath: string; volumeId: string };
  status: "ok" | "missing" | "partial" | "failed";
  message: string | null;
}

export interface UsageBucket {
  day: string;
  provider: string;
  model: string;
  sourcePath?: string;
  costUsd: number;
  unpricedRecords: number;
  cacheSavingsUsd?: number;
  totals?: { uncachedInputTokens: number; cachedInputTokens: number; cacheCreationTokens: number; outputTokens: number; reasoningTokens: number };
}

export interface UsageSummary {
  contractVersion: number;
  readAt: string;
  timeZone: string;
  sinceDay: string;
  untilDay: string;
  buckets: UsageBucket[];
  sources: UsageSource[];
  pricing: { status: "fresh" | "cached" | "unavailable"; fetchedAt: string | null };
}

export interface UsageState {
  summary?: UsageSummary;
  error?: string;
}

export function todayWindow(now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  const day = `${part("year")}-${part("month")}-${part("day")}`;
  return { sinceDay: day, untilDay: day, timeZone };
}

export function historyWindow(now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, days = 7) {
  const today = todayWindow(now, timeZone);
  const first = new Date(`${today.sinceDay}T12:00:00Z`);
  first.setUTCDate(first.getUTCDate() - (days - 1));
  return { ...today, sinceDay: first.toISOString().slice(0, 10) };
}

export function supportedUsage(summary: UsageSummary): boolean {
  // These are the versions understood by the installed T3 usage UI as well.
  return summary.contractVersion >= 4 && summary.contractVersion <= 6;
}

interface StationUsage {
  id: string;
  label: string;
  connection: string;
  usage?: UsageState;
}

export interface CacheMetrics {
  cachedInputTokens: number;
  inputTokens: number;
  cacheSavingsUsd: number;
  cacheAvailable: boolean;
}

export interface SpendRow extends CacheMetrics {
  id: string;
  label: string;
  costUsd?: number;
  unpricedRecords: number;
  sharedSources: number;
  notes: string[];
  readAt?: string;
}

/** Merge physical sources once, preferring healthy scans, then the newest snapshot. */
export function fleetSpend(stations: StationUsage[], window = todayWindow()) {
  const owners = new Map<string, { id: string; source: UsageSource }>();
  const rows: SpendRow[] = [];
  const eligible = stations.filter((s) => {
    const summary = s.usage?.summary;
    return summary && supportedUsage(summary) && summary.sinceDay <= window.sinceDay &&
      summary.untilDay >= window.untilDay && summary.timeZone === window.timeZone;
  }).sort((a, b) => b.usage!.summary!.readAt.localeCompare(a.usage!.summary!.readAt) || a.id.localeCompare(b.id));
  const fingerprint = ({ fingerprint: f }: UsageSource) => JSON.stringify([f.hostId, f.provider, f.resolvedHomePath, f.volumeId]);
  for (const status of ["ok", "partial", "failed", "missing"]) {
    for (const station of eligible) {
      for (const source of station.usage!.summary!.sources) {
        const key = fingerprint(source);
        if (source.status === status && !owners.has(key)) owners.set(key, { id: station.id, source });
      }
    }
  }
  let costUsd = 0;
  let available = 0;
  const cache: CacheMetrics = { cachedInputTokens: 0, inputTokens: 0, cacheSavingsUsd: 0, cacheAvailable: false };
  const days = new Map<string, number>();
  for (const date = new Date(`${window.sinceDay}T12:00:00Z`); date.toISOString().slice(0, 10) <= window.untilDay; date.setUTCDate(date.getUTCDate() + 1)) days.set(date.toISOString().slice(0, 10), 0);
  for (const station of stations) {
    const row: SpendRow = { id: station.id, label: station.label, unpricedRecords: 0, sharedSources: 0, notes: [], cachedInputTokens: 0, inputTokens: 0, cacheSavingsUsd: 0, cacheAvailable: false };
    rows.push(row);
    if (!eligible.includes(station)) {
      row.notes.push(station.usage?.error ?? (station.connection === "live" ? "Loading usage…" : `Usage unavailable: ${station.connection}`));
      continue;
    }
    const summary = station.usage!.summary!;
    row.costUsd = 0;
    row.readAt = summary.readAt;
    available++;
    if (station.connection !== "live" || station.usage?.error) row.notes.push("Last known estimate; refresh unavailable.");
    if (summary.pricing.status === "cached") row.notes.push("Using cached model rates.");
    if (summary.pricing.status === "unavailable") row.notes.push("Model rates unavailable.");
    for (const source of summary.sources) {
      if (source.status === "partial" || source.status === "failed") row.notes.push(`${source.fingerprint.provider}: ${source.message ?? source.status}`);
      if (source.status !== "missing" && owners.get(fingerprint(source))?.id !== station.id) row.sharedSources++;
    }
    for (const bucket of summary.buckets) {
      if (bucket.day < window.sinceDay || bucket.day > window.untilDay) continue;
      const sources = summary.sources.filter((s) => s.fingerprint.provider === bucket.provider &&
        (bucket.sourcePath === undefined || s.fingerprint.resolvedHomePath === bucket.sourcePath));
      if (sources.length !== 1) {
        if (!row.notes.includes("Some usage could not be assigned to a source.")) row.notes.push("Some usage could not be assigned to a source.");
        continue;
      }
      if (owners.get(fingerprint(sources[0]))?.id !== station.id) continue;
      row.costUsd += bucket.costUsd;
      row.unpricedRecords += bucket.unpricedRecords;
      days.set(bucket.day, (days.get(bucket.day) ?? 0) + bucket.costUsd);
      if (bucket.totals) {
        row.cacheAvailable = true;
        row.cachedInputTokens += bucket.totals.cachedInputTokens;
        row.inputTokens += bucket.totals.cachedInputTokens + bucket.totals.uncachedInputTokens + bucket.totals.cacheCreationTokens;
        row.cacheSavingsUsd += bucket.cacheSavingsUsd ?? 0;
      }
    }
    costUsd += row.costUsd;
    cache.cachedInputTokens += row.cachedInputTokens;
    cache.inputTokens += row.inputTokens;
    cache.cacheSavingsUsd += row.cacheSavingsUsd;
    cache.cacheAvailable ||= row.cacheAvailable;
  }
  return { rows, ...cache, daily: [...days].map(([day, costUsd]) => ({ day, costUsd })), costUsd: available ? costUsd : undefined, available,
    partial: rows.some((r) => r.costUsd === undefined || r.notes.length > 0 || r.unpricedRecords > 0) };
}

export const formatSpend = (amount: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
