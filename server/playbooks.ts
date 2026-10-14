// Saved orders on the Command server (owner-only playbooks.json), so every device has the same.

import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PLAYBOOKS, sanitizePlaybooks, type Playbook } from "../shared/playbooks.ts";

export class Playbooks {
  private readonly file: string;
  private books: Playbook[] = DEFAULT_PLAYBOOKS;
  /** Saves run one at a time, so two at once can't interleave on the temp file. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "playbooks.json");
  }

  async load(): Promise<void> {
    try {
      this.books = sanitizePlaybooks(JSON.parse(await fs.readFile(this.file, "utf8"))) ?? DEFAULT_PLAYBOOKS;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[playbooks] load failed", (err as Error).message);
    }
  }

  all(): Playbook[] {
    return [...this.books];
  }

  async set(input: unknown): Promise<Playbook[]> {
    const books = sanitizePlaybooks(input);
    if (!books) throw new Error("Playbooks must be a list of { name, text }");
    this.books = books;
    const write = this.writes.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.books, null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.file);
    });
    this.writes = write.catch(() => {});
    await write;
    return this.all();
  }
}
