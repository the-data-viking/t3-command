// Notices when a machine's T3 is updated (the desktop app auto-updates) and says so in the comms
// log, loudly if the new release speaks an orchestration protocol this Command doesn't.

import fs from "node:fs/promises";
import path from "node:path";
import { SUPPORTED_PROTOCOL_VERSIONS, type EnvSummary } from "../shared/api.ts";
import type { CommsLog } from "./comms.ts";
import type { Registry } from "./registry.ts";

const CHECK_MS = 5 * 60_000;

interface Seen { serverVersion: string; protocolVersion: number }

/** The comms line for a machine whose T3 changed, or undefined if nothing worth saying. */
export function versionChange(label: string, before: Seen | undefined, now: Seen): { tone: "info" | "bad"; text: string } | undefined {
  if (!before || (before.serverVersion === now.serverVersion && before.protocolVersion === now.protocolVersion)) return undefined;
  const supported = (SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(now.protocolVersion);
  if (!supported) {
    return { tone: "bad", text: `${label} updated to T3 ${now.serverVersion}, which speaks orchestration protocol v${now.protocolVersion}. Command can't follow it until Command is updated.` };
  }
  return { tone: "info", text: `${label} updated T3 ${before.serverVersion} → ${now.serverVersion}` };
}

export class T3Versions {
  private readonly file: string;
  private readonly registry: Registry;
  private readonly comms: CommsLog;
  private seen: Record<string, Seen> = {};
  private timer?: ReturnType<typeof setInterval>;

  constructor(dataDir: string, registry: Registry, comms: CommsLog) {
    this.file = path.join(dataDir, "t3-versions.json");
    this.registry = registry;
    this.comms = comms;
  }

  async load(): Promise<void> {
    try { this.seen = JSON.parse(await fs.readFile(this.file, "utf8")) as Record<string, Seen>; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }

  start(): void {
    setTimeout(() => void this.check(), 30_000).unref();
    this.timer = setInterval(() => void this.check(), CHECK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async check(): Promise<void> {
    let changed = false;
    for (const id of this.registry.ids()) {
      const env = this.registry.get(id);
      if (!env || env.hermes) continue;
      let summary: EnvSummary | undefined;
      try { summary = await this.registry.status(id); } catch { continue; }
      if (!summary?.serverVersion) continue; // Unreachable: nothing to compare.
      const now = { serverVersion: summary.serverVersion, protocolVersion: summary.protocolVersion ?? 1 };
      const line = versionChange(env.label, this.seen[id], now);
      if (line) this.comms.add({ ...line, kind: "update", envId: id });
      if (this.seen[id]?.serverVersion !== now.serverVersion || this.seen[id]?.protocolVersion !== now.protocolVersion) {
        this.seen[id] = now;
        changed = true;
      }
    }
    for (const id of Object.keys(this.seen)) if (!this.registry.get(id)) { delete this.seen[id]; changed = true; }
    if (!changed) return;
    await fs.writeFile(`${this.file}.tmp`, JSON.stringify(this.seen), { mode: 0o600 });
    await fs.rename(`${this.file}.tmp`, this.file);
  }
}
