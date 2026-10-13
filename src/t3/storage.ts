// Disk usage per machine, measured by the Command server every few minutes. The browser polls the
// latest readings and speaks up when a machine's disk crosses into low or critical.

import { diskLevel, tightestVolume, type DiskVolume, type StorageView } from "../../shared/storage";
import { useGame } from "../store";
import { GAUGE } from "../game/theme";
import { fetchJson } from "./environment";

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
}

export function storageSummary(view: StorageView | undefined, now = Date.now()): StorageSummary {
  const latest = view?.latest;
  const volume = latest ? tightestVolume(latest.volumes) : undefined;
  const stale = !!latest && now - latest.sampledAt > STALE_MS;
  if (!volume || volume.totalBytes <= 0) return { level: "unknown", color: GAUGE.unknown, stale, error: latest?.error };
  const level = diskLevel(volume);
  return { volume, level, usedFraction: 1 - volume.availableBytes / volume.totalBytes, color: stale ? GAUGE.unknown : GAUGE[level], stale, error: latest?.error };
}

/** Short free-space label for the deck plate: "2.2G", "31G", "1.4T". */
export function freeLabel(bytes: number): string {
  const g = bytes / 1024 ** 3;
  return g >= 1000 ? `${(g / 1024).toFixed(1)}T` : g < 10 ? `${g.toFixed(1)}G` : `${Math.round(g)}G`;
}

const RANK = { unknown: 0, ok: 0, high: 1, critical: 2 } as const;

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
    const machine = useGame.getState().envs[view.envId]?.summary.label ?? "A machine";
    const text = `${machine} disk ${after.level === "critical" ? "nearly full" : "running low"}: ${freeLabel(after.volume.availableBytes)}B free on ${after.volume.mount}`;
    announced.push(text);
    if (useGame.getState().notify && typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(after.level === "critical" ? "Disk nearly full" : "Disk running low", { body: text, tag: `disk:${view.envId}` });
    }
  }
  return announced;
}

let loaded = false;

export async function refreshStorage(): Promise<void> {
  const views = await fetchJson<StorageView[]>("/api/storage");
  announceStorage(useGame.getState().storage, views, !loaded);
  loaded = true;
  useGame.setState({ storage: Object.fromEntries(views.map((v) => [v.envId, v])) });
}
