// Saved orders on the Command server (owner-only playbooks.json), so every device has the same.

import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PLAYBOOKS, sanitizePlaybooks, type Playbook } from "../shared/playbooks.ts";

export class Playbooks {
  private readonly file: string;
  private books: Playbook[] = DEFAULT_PLAYBOOKS;

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
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(books, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
    return this.all();
  }
}
