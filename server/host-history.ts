// Whole-host CPU and RAM per T3 machine, sampled every minute by the Command server over the
// history recorder's connection and kept for 7 days, so the host panel can chart a day or a
// week instead of only what one browser saw.

import fs from "node:fs/promises";
import path from "node:path";
import type { HostHistory, HostPoint } from "../shared/host.ts";
import type { HistoryRecorder } from "./history-recorder.ts";
import type { Registry } from "./registry.ts";

const SAMPLE_MS = 60_000;
const SAVE_EVERY = 10;
const KEEP_MS = 7 * 86_400_000;
/** Points per response; longer ranges are averaged into buckets (with the bucket's peak CPU). */
const MAX_POINTS = 240;

interface HostResources { sampledAt: number; cpuUtilization: number | null; availableMemoryBytes: number; totalMemoryBytes: number }
/** [time, cpu 0–1 or null, RAM used 0–1 or null] */
type Sample = [number, number | null, number | null];

const fraction = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1 ? n : null);

export function toSample(r: HostResources): Sample {
  const mem = r.totalMemoryBytes > 0 && r.availableMemoryBytes >= 0 && r.availableMemoryBytes <= r.totalMemoryBytes
    ? (r.totalMemoryBytes - r.availableMemoryBytes) / r.totalMemoryBytes : null;
  return [r.sampledAt, fraction(r.cpuUtilization), mem];
}

/** Average samples into at most `max` equal time buckets over [from, to]; empty buckets are skipped. */
export function bucket(samples: Sample[], from: number, to: number, max = MAX_POINTS): HostPoint[] {
  const inRange = samples.filter(([t]) => t >= from && t <= to);
  if (inRange.length <= max) return inRange.map(([at, cpu, mem]) => ({ at, cpu, cpuPeak: cpu, mem }));
  const width = (to - from) / max;
  const groups = new Map<number, Sample[]>();
  for (const s of inRange) {
    const k = Math.min(max - 1, Math.floor((s[0] - from) / width));
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const avg = (xs: Array<number | null>) => { const v = xs.filter((x): x is number => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([k, g]) => {
    const cpus = g.map((s) => s[1]).filter((x): x is number => x !== null);
    return { at: Math.round(from + (k + 0.5) * width), cpu: avg(g.map((s) => s[1])), cpuPeak: cpus.length ? Math.max(...cpus) : null, mem: avg(g.map((s) => s[2])) };
  });
}

export class HostHistoryRecorder {
  private readonly file: string;
  private readonly registry: Registry;
  private readonly recorder: HistoryRecorder;
  private samples: Record<string, Sample[]> = {};
  private timer?: ReturnType<typeof setInterval>;
  private ticks = 0;

  constructor(dataDir: string, registry: Registry, recorder: HistoryRecorder) {
    this.file = path.join(dataDir, "host-history.json");
    this.registry = registry;
    this.recorder = recorder;
  }

  async load(): Promise<void> {
    try { this.samples = JSON.parse(await fs.readFile(this.file, "utf8")) as Record<string, Sample[]>; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }

  start(): void {
    this.timer = setInterval(() => void this.sampleAll(), SAMPLE_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.save();
  }

  history(envId: string, hours: number, now = Date.now()): HostHistory {
    const from = now - hours * 3_600_000;
    return { envId, from, to: now, points: bucket(this.samples[envId] ?? [], from, now) };
  }

  private async sampleAll(): Promise<void> {
    const ids = this.registry.ids();
    await Promise.all(ids.map(async (envId) => {
      if (this.registry.get(envId)?.hermes) return; // Hermes reports no host resources.
      try {
        const r = await this.recorder.request<HostResources>(envId, "server.getHostResources", {}, 15_000);
        (this.samples[envId] ??= []).push(toSample(r));
      } catch { /* Offline or busy: a gap in the chart. */ }
    }));
    const cutoff = Date.now() - KEEP_MS;
    for (const envId of Object.keys(this.samples)) {
      if (!ids.includes(envId)) { delete this.samples[envId]; continue; }
      const list = this.samples[envId];
      let drop = 0;
      while (drop < list.length && list[drop][0] < cutoff) drop++;
      if (drop) list.splice(0, drop);
    }
    if (++this.ticks % SAVE_EVERY === 0) await this.save().catch((err) => console.warn("[hosts] save failed", (err as Error).message));
  }

  private async save(): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.samples), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }
}
