// Command-wide preferences (default models, routing levels) on the Command server, so every device
// starts new crew the same way. Owner-only prefs.json. Changes are patches, so two devices editing
// different settings at once don't undo each other.

import fs from "node:fs/promises";
import path from "node:path";
import { sanitizePrefs, type CommandPrefs } from "../shared/prefs.ts";

/** A change: `null` clears a provider, a model default, or (at Normal) a machine's routing level. */
export interface PrefsPatch {
  provider?: string | null;
  models?: Record<string, unknown>;
  routing?: Record<string, unknown>;
}

export class Prefs {
  private readonly file: string;
  private prefs: CommandPrefs = { models: {}, routing: {} };
  private writes: Promise<void> = Promise.resolve();
  private listeners = new Set<(prefs: CommandPrefs) => void>();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "prefs.json");
  }

  async load(): Promise<void> {
    try {
      this.prefs = sanitizePrefs(JSON.parse(await fs.readFile(this.file, "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[prefs] load failed", (err as Error).message);
    }
  }

  all(): CommandPrefs {
    return structuredClone(this.prefs);
  }

  update(input: unknown): CommandPrefs {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a prefs patch");
    const patch = input as PrefsPatch;
    // Only the patch's valid parts apply; a malformed entry leaves the saved one alone.
    const valid = sanitizePrefs({ provider: patch.provider, models: patch.models, routing: patch.routing });
    const next: CommandPrefs = structuredClone(this.prefs);
    if (patch.provider === null) delete next.provider;
    else if (valid.provider) next.provider = valid.provider;
    for (const key of ["models", "routing"] as const) {
      const field = patch[key];
      if (!field || typeof field !== "object") continue;
      for (const [id, value] of Object.entries(field)) {
        // Normal is the absence of a routing level.
        if (value === null || (key === "routing" && value === "normal")) delete next[key][id];
        else if (id in valid[key]) (next[key] as Record<string, unknown>)[id] = valid[key][id];
      }
    }
    this.save(next);
    return this.all();
  }

  /** A machine was removed: its routing level goes with it. */
  forget(envId: string): void {
    if (!(envId in this.prefs.routing)) return;
    const routing = { ...this.prefs.routing };
    delete routing[envId];
    this.save({ ...this.prefs, routing });
  }

  subscribe(listener: (prefs: CommandPrefs) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async flush(): Promise<void> {
    await this.writes;
  }

  private save(prefs: CommandPrefs): void {
    this.prefs = prefs;
    const snapshot = JSON.stringify(prefs, null, 2);
    this.writes = this.writes.then(async () => {
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, snapshot, { mode: 0o600 });
      await fs.rename(tmp, this.file);
    }).catch((err) => console.warn("[prefs] write failed", (err as Error).message));
    for (const listener of this.listeners) listener(this.all());
  }
}
