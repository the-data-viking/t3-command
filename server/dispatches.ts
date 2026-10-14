// Squad orders being followed, on the Command server (owner-only dispatches.json): every device
// sees the same receipts. The newest 30 are kept; each is dropped after three days or when closed.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { clipText, DISPATCH_MAX, DISPATCH_TTL_MS, sanitizeMembers, type Dispatch } from "../shared/dispatches.ts";

export class Dispatches {
  private readonly file: string;
  private list: Dispatch[] = [];
  private listeners = new Set<(list: Dispatch[]) => void>();
  /** Saves run one at a time, so two at once can't interleave on the temp file. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "dispatches.json");
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8")) as unknown;
      if (Array.isArray(saved)) {
        this.list = saved.filter((d): d is Dispatch => !!d && typeof d.id === "string" && typeof d.text === "string" && typeof d.at === "number")
          .map((d) => ({ id: d.id, text: d.text, at: d.at, members: sanitizeMembers(d.members) }));
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[dispatches] load failed", (err as Error).message);
    }
  }

  all(now = Date.now()): Dispatch[] {
    return this.list.filter((d) => now - d.at < DISPATCH_TTL_MS);
  }

  subscribe(listener: (list: Dispatch[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  add(text: unknown, members: unknown, now = Date.now()): Dispatch {
    const order = clipText(String(text ?? ""));
    if (!order) throw new Error("The order is empty");
    const clean = sanitizeMembers(members);
    if (!clean.length) throw new Error("A dispatch needs at least one crew member");
    const dispatch: Dispatch = { id: randomUUID(), text: order, at: now, members: clean };
    this.list = [dispatch, ...this.all(now)].slice(0, DISPATCH_MAX);
    this.changed();
    return dispatch;
  }

  /** Record a retry's outcome: the members given replace the ones with the same crew member. */
  update(id: string, members: unknown): Dispatch | undefined {
    const dispatch = this.list.find((d) => d.id === id);
    if (!dispatch) return undefined;
    const changes = new Map(sanitizeMembers(members).map((m) => [`${m.envId}:${m.threadId}`, m]));
    dispatch.members = dispatch.members.map((m) => changes.get(`${m.envId}:${m.threadId}`) ?? m);
    this.changed();
    return dispatch;
  }

  close(id: string): boolean {
    const before = this.list.length;
    this.list = this.list.filter((d) => d.id !== id);
    if (this.list.length === before) return false;
    this.changed();
    return true;
  }

  async flush(): Promise<void> {
    await this.writes;
  }

  private changed(): void {
    const list = this.all();
    const write = this.writes.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(list), { mode: 0o600 });
      await fs.rename(tmp, this.file);
    });
    this.writes = write.catch((err) => console.warn("[dispatches] write failed", (err as Error).message));
    for (const listener of this.listeners) listener(list);
  }
}
