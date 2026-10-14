// Disk usage per machine, measured by the Command server every few minutes. The browser polls the
// latest readings and speaks up when a machine's disk crosses into low or critical.

import { diskEta, diskLevel, ETA_SHOW_MS, etaLabel, tightestVolume, type DiskVolume, type StorageView } from "../../shared/storage";
import { useGame } from "../store";
import { GAUGE } from "../game/theme";
import { fetchJson } from "./environment";
import { DEMO } from "../demo";

export const STORAGE_REFRESH_MS = 60_000;
/** Readings are taken every 5 minutes; three missed samples means the numbers can't be trusted. */
const STALE_MS = 16 * 60_000;

export interface StorageSummary {
  volume?: DiskVolume;
  level: "ok" | "high" | "critical" | "unknown";
  usedFraction?: number;
  color: number;
  stale: boolean;
  error?: string;
  /** At the recent rate, how long until the disk is full: set only when that's under two days. */
  eta?: number;
}

/** A disk-full estimate under six hours is critical whatever space is left; under two days, high. */
const ETA_CRITICAL_MS = 6 * 3_600_000;

export function storageSummary(view: StorageView | undefined, now = Date.now()): StorageSummary {
  const latest = view?.latest;
  const volume = latest ? tightestVolume(latest.volumes) : undefined;
  const stale = !!latest && now - latest.sampledAt > STALE_MS;
  if (!volume || volume.totalBytes <= 0) return { level: "unknown", color: GAUGE.unknown, stale, error: latest?.error };
  const estimate = stale ? undefined : diskEta(view?.trend ?? [], now);
  const eta = estimate !== undefined && estimate < ETA_SHOW_MS ? estimate : undefined;
  const byEta = eta === undefined ? "ok" : eta < ETA_CRITICAL_MS ? "critical" : "high";
  const rank = { ok: 0, high: 1, critical: 2 } as const;
  const space = diskLevel(volume);
  const level = rank[byEta] > rank[space] ? byEta : space;
  return { volume, level, usedFraction: 1 - volume.availableBytes / volume.totalBytes, color: stale ? GAUGE.unknown : GAUGE[level], stale, error: latest?.error, eta };
}

/** Short free-space label for the deck plate: "2.2G", "31G", "1.4T". */
export function freeLabel(bytes: number): string {
  const g = bytes / 1024 ** 3;
  return g >= 1000 ? `${(g / 1024).toFixed(1)}T` : g < 10 ? `${g.toFixed(1)}G` : `${Math.round(g)}G`;
}

const RANK = { unknown: 0, ok: 0, high: 1, critical: 2 } as const;
/** A fill-rate estimate is noisy near its thresholds: announce it at most this often per machine. */
const ETA_NOTICE_MS = 12 * 3_600_000;
const etaNoticed = new Map<string, number>();

/**
 * A desktop notification (if enabled) when a machine's disk gets worse; quiet on the first load.
 * The comms line comes from the Command server. Returns the texts announced.
 */
export function announceStorage(prev: Record<string, StorageView>, next: StorageView[], first: boolean): string[] {
  const announced: string[] = [];
  if (first) return announced;
  for (const view of next) {
    const before = storageSummary(prev[view.envId]);
    const after = storageSummary(view);
    if (after.stale || RANK[after.level] <= RANK[before.level] || !after.volume) continue;
    // Raised only by the estimate (space alone is fine): throttle, so it can't flap.
    if (after.eta !== undefined && RANK[diskLevel(after.volume)] < RANK[after.level]) {
      if (Date.now() - (etaNoticed.get(view.envId) ?? 0) < ETA_NOTICE_MS) continue;
      etaNoticed.set(view.envId, Date.now());
    }
    const machine = useGame.getState().envs[view.envId]?.summary.label ?? "A machine";
    const free = `${freeLabel(after.volume.availableBytes)}B free on ${after.volume.mount}`;
    const text = after.eta !== undefined
      ? `${machine} disk filling up: full in about ${etaLabel(after.eta)} at this rate, ${free}`
      : `${machine} disk ${after.level === "critical" ? "nearly full" : "running low"}: ${free}`;
    announced.push(text);
    if (useGame.getState().notify && typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(after.eta !== undefined ? "Disk filling up" : after.level === "critical" ? "Disk nearly full" : "Disk running low", { body: text, tag: `disk:${view.envId}` });
    }
  }
  return announced;
}

let loaded = false;

export async function refreshStorage(): Promise<void> {
  if (DEMO) return; // The demo fleet's storage is fixed.
  const views = await fetchJson<StorageView[]>("/api/storage");
  announceStorage(useGame.getState().storage, views, !loaded);
  loaded = true;
  useGame.setState({ storage: Object.fromEntries(views.map((v) => [v.envId, v])) });
}
