// Disk usage per machine, collected around the clock: free space on the disks holding each
// machine's checkouts every 5 minutes, and T3 worktree sizes every 15. The Command host is read
// directly; other T3 machines through a short-lived T3 terminal session (see t3-terminal.ts).

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parseStorageOutput, storageCommand, storageDone, tightestVolume, type StorageReading, type StorageView } from "../shared/storage.ts";
import type { HistoryRecorder } from "./history-recorder.ts";
import type { Registry, StoredEnv } from "./registry.ts";
import { runInT3Terminal } from "./t3-terminal.ts";

const SAMPLE_MS = 5 * 60_000;
/** Measuring worktree folders walks every file, so it runs every third sample. */
const WORKTREE_EVERY = 3;
const TREND_MS = 7 * 86_400_000;
const DISK_TIMEOUT_MS = 30_000;
const WORKTREE_TIMEOUT_MS = 180_000;

interface State { envs: Record<string, { latest?: StorageReading; trend: Array<{ at: number; usedFraction: number }> }> }

const isLocal = (env: StoredEnv) => !!env.hermes || (!!env.url && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(env.url).hostname));
const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p);

export class StorageMonitor {
  private readonly registry: Registry;
  private readonly recorder: HistoryRecorder;
  private readonly file: string;
  private state: State = { envs: {} };
  private timer?: ReturnType<typeof setTimeout>;
  private cycle = 0;
  private stopped = false;

  constructor(dataDir: string, registry: Registry, recorder: HistoryRecorder) {
    this.file = path.join(dataDir, "storage-state.json");
    this.registry = registry;
    this.recorder = recorder;
  }

  async load(): Promise<void> {
    try { this.state = JSON.parse(await fs.readFile(this.file, "utf8")) as State; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }

  /** First sample shortly after start (once machines have reported their projects), then on a timer. */
  start(): void {
    this.schedule(20_000);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  views(): StorageView[] {
    return this.registry.ids().map((envId) => ({ envId, latest: this.state.envs[envId]?.latest, trend: this.state.envs[envId]?.trend ?? [] }));
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.sampleAll(), ms);
    this.timer.unref();
  }

  private async sampleAll(): Promise<void> {
    const withWorktrees = this.cycle++ % WORKTREE_EVERY === 0;
    for (const envId of this.registry.ids()) {
      if (this.stopped) return;
      const env = this.registry.get(envId);
      if (!env) continue;
      const reading = await this.sample(env, withWorktrees).catch((err: unknown) => ({ sampledAt: Date.now(), volumes: [], error: (err as Error).message.slice(0, 200) }));
      if (reading) this.record(envId, reading);
    }
    await this.save();
    this.schedule(SAMPLE_MS);
  }

  /** The folders whose disks matter on a machine: project checkouts and its worktrees. */
  private paths(env: StoredEnv): string[] {
    const snapshot = this.recorder.snapshot(env.id);
    const roots = new Set<string>(Object.values(snapshot?.projects ?? {}).map((p) => p.workspaceRoot).filter(Boolean));
    for (const t of snapshot?.threads ?? []) if (t.worktreePath) roots.add(t.worktreePath);
    if (env.hermes) roots.add(env.hermes.workspaceRoot);
    return [...roots];
  }

  private async sample(env: StoredEnv, measure: boolean): Promise<StorageReading | undefined> {
    const paths = this.paths(env);
    // Hermes shares the Command host's disk and keeps no T3 worktrees.
    const withWorktrees = measure && !env.hermes;
    if (!paths.length) return undefined; // Not reported yet; try next cycle.
    const timeout = withWorktrees ? WORKTREE_TIMEOUT_MS : DISK_TIMEOUT_MS;
    if (isLocal(env)) {
      const output = await new Promise<string>((resolve, reject) => {
        execFile("/bin/sh", ["-c", storageCommand(paths, withWorktrees, false)], { timeout, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout)));
      });
      return parseStorageOutput(output, Date.now(), withWorktrees) ?? { sampledAt: Date.now(), volumes: [], error: "Could not read disk usage" };
    }
    const windows = isWindowsPath(paths[0]);
    const command = storageCommand(paths, withWorktrees, windows);
    let output = "";
    // One retry: a remote shell occasionally garbles its first output.
    for (let attempt = 0; attempt < 2; attempt++) {
      output = await runInT3Terminal(this.registry, env, paths[0], command, storageDone, timeout);
      const reading = parseStorageOutput(output, Date.now(), withWorktrees);
      if (reading) return reading;
    }
    console.warn(`storage: unreadable output from ${env.label}: ${JSON.stringify(output.slice(-400))}`);
    return { sampledAt: Date.now(), volumes: [], error: "Could not read disk usage" };
  }

  private record(envId: string, reading: StorageReading): void {
    const entry = this.state.envs[envId] ??= { trend: [] };
    // A failed read keeps the last good numbers (aging into stale) with the error attached.
    if (reading.error && entry.latest?.volumes.length) {
      entry.latest = { ...entry.latest, error: reading.error };
      return;
    }
    // Worktree sizes are slower to measure; carry the last ones forward between measurements.
    entry.latest = reading.worktrees || !entry.latest?.worktrees ? reading : { ...reading, worktrees: entry.latest.worktrees };
    const tightest = tightestVolume(reading.volumes);
    if (tightest && tightest.totalBytes > 0) entry.trend.push({ at: reading.sampledAt, usedFraction: 1 - tightest.availableBytes / tightest.totalBytes });
    const cutoff = Date.now() - TREND_MS;
    entry.trend = entry.trend.filter((p) => p.at >= cutoff);
  }

  private async save(): Promise<void> {
    for (const envId of Object.keys(this.state.envs)) if (!this.registry.get(envId)) delete this.state.envs[envId];
    await fs.writeFile(`${this.file}.tmp`, JSON.stringify(this.state), { mode: 0o600 });
    await fs.rename(`${this.file}.tmp`, this.file);
  }
}
