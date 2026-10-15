// Agent widgets pinned to the map or the screen, kept on the Command server so every device shows
// the same pins. A pin goes when the thread it was pinned from is archived, removed, or its
// machine is. Owner-only JSON file.

import fs from "node:fs/promises";
import path from "node:path";
import { MAX_PINS, sanitizePin, type WidgetPin } from "../shared/widgets.ts";

export class WidgetPins {
  private readonly file: string;
  private pins: WidgetPin[] = [];
  private writes: Promise<void> = Promise.resolve();
  private listeners = new Set<(pins: WidgetPin[]) => void>();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "widget-pins.json");
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8")) as unknown;
      if (Array.isArray(saved)) this.pins = saved.map(sanitizePin).filter((p): p is WidgetPin => !!p).slice(-MAX_PINS);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[widget-pins] load failed", (err as Error).message);
    }
  }

  all(): WidgetPin[] {
    return [...this.pins];
  }

  /** Add or move a pin (same id replaces); returns the whole list. */
  put(input: unknown): WidgetPin[] {
    const pin = sanitizePin(input);
    if (!pin) throw new Error("Not a widget pin");
    this.save([...this.pins.filter((p) => p.id !== pin.id), pin].slice(-MAX_PINS));
    return this.all();
  }

  remove(id: unknown): WidgetPin[] {
    if (typeof id === "string" && this.pins.some((p) => p.id === id)) this.save(this.pins.filter((p) => p.id !== id));
    return this.all();
  }

  /** A machine's threads as T3 has them now: pins of archived or vanished threads go. */
  observe(envId: string, threads: ReadonlyArray<{ id: string; archivedAt?: string | null }>): void {
    const live = new Set(threads.filter((t) => !t.archivedAt).map((t) => t.id));
    const kept = this.pins.filter((p) => p.envId !== envId || live.has(p.threadId));
    if (kept.length !== this.pins.length) this.save(kept);
  }

  forget(envId: string): void {
    if (this.pins.some((p) => p.envId === envId)) this.save(this.pins.filter((p) => p.envId !== envId));
  }

  subscribe(listener: (pins: WidgetPin[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async flush(): Promise<void> {
    await this.writes;
  }

  private save(pins: WidgetPin[]): void {
    this.pins = pins;
    const snapshot = JSON.stringify(pins);
    this.writes = this.writes.then(async () => {
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, snapshot, { mode: 0o600 });
      await fs.rename(tmp, this.file);
    }).catch((err) => console.warn("[widget-pins] write failed", (err as Error).message));
    for (const listener of this.listeners) listener(this.all());
  }
}
