// Which crew reports you've read, kept on the Command server so the phone and the desktop agree.
// A mark is the turn id that was read: a later turn's report shows up again. Owner-only JSON file.

import fs from "node:fs/promises";
import path from "node:path";

/** Marks kept at most (oldest dropped): plenty for any fleet's recent reports. */
export const MAX_MARKS = 5000;

export type ReadMarks = Record<string, string>;

export class ReadState {
  private readonly file: string;
  private marks: ReadMarks = {};
  private writes: Promise<void> = Promise.resolve();
  private listeners = new Set<(changed: ReadMarks) => void>();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "read-reports.json");
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8")) as unknown;
      if (saved && typeof saved === "object") this.marks = Object.fromEntries(Object.entries(saved).filter(([, v]) => typeof v === "string")) as ReadMarks;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[read] load failed", (err as Error).message);
    }
  }

  all(): ReadMarks {
    return { ...this.marks };
  }

  /** Record marks ("envId:threadId" → turn id); returns those that changed, and tells listeners. */
  mark(changes: ReadMarks): ReadMarks {
    const changed: ReadMarks = {};
    for (const [key, turnId] of Object.entries(changes)) {
      if (typeof key !== "string" || typeof turnId !== "string" || key.length > 300 || turnId.length > 200) continue;
      if (this.marks[key] === turnId) continue;
      // Re-insert so the newest marks are last and the oldest are the ones trimmed.
      delete this.marks[key];
      this.marks[key] = turnId;
      changed[key] = turnId;
    }
    if (!Object.keys(changed).length) return changed;
    const keys = Object.keys(this.marks);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_MARKS))) delete this.marks[key];
    const snapshot = JSON.stringify(this.marks);
    this.writes = this.writes.then(async () => {
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, snapshot, { mode: 0o600 });
      await fs.rename(tmp, this.file);
    }).catch((err) => console.warn("[read] write failed", (err as Error).message));
    for (const listener of this.listeners) listener(changed);
    return changed;
  }

  subscribe(listener: (changed: ReadMarks) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}
