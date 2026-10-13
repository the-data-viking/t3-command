// The fleet's comms log, written by the Command server: crew state changes on every machine,
// machines dropping off and coming back, and low-disk warnings. Kept in an owner-only JSONL file
// for 30 days and streamed to browsers (server-sent events) so every device sees the same log.

import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { COMMS_BACKLOG, COMMS_RETENTION_DAYS, type CommsEntry } from "../shared/comms.ts";
import { isHistory, unitState, type UnitState } from "../src/t3/derive.ts";
import type { ThreadShell } from "../src/t3/types.ts";

const DAY_MS = 86_400_000;
/** Reconnects shorter than this aren't worth announcing. */
const OFFLINE_GRACE_MS = 90_000;
const KEEPALIVE_MS = 25_000;

type NewEntry = Omit<CommsEntry, "id" | "at"> & { at?: number };

/**
 * The comms line for a crew state change, matching what the map shows; undefined if quiet. Plain
 * words (the map carries the flavour): these lines are scanned in logs and notifications.
 */
export function transitionEntry(thread: ThreadShell, from: UnitState, to: UnitState): Pick<CommsEntry, "tone" | "kind" | "text"> | undefined {
  const name = `"${thread.title || "Untitled"}"`;
  if (to === "alert") return { tone: "alert", kind: "approval", text: `${name} needs your approval` };
  if (to === "question") return { tone: "alert", kind: "question", text: `${name} has a question` };
  if (to === "error") {
    const reason = thread.session?.lastError?.split("\n")[0].trim();
    return { tone: "bad", kind: "failed", text: `${name} failed${reason ? `: ${reason.length > 120 ? `${reason.slice(0, 119)}…` : reason}` : ""}` };
  }
  if (to === "monitoring" && from === "working") return { tone: "info", kind: "monitoring", text: `${name} is watching background tasks` };
  if (to === "done" && (from === "working" || from === "monitoring")) return { tone: "good", kind: "done", text: `${name} finished` };
  if (to === "working" && from !== "alert" && from !== "question") return { tone: "info", kind: "started", text: `${name} started work` };
  return undefined;
}

/** PR numbers T3 reports merged for a thread. */
function mergedPrs(thread: ThreadShell): Map<number, string> {
  return new Map((thread.pullRequests ?? []).filter((pr) => pr.snapshot?.state === "merged").map((pr) => [pr.number, pr.snapshot?.title ?? ""]));
}

export class CommsLog {
  private readonly file: string;
  private entries: CommsEntry[] = [];
  private nextId = 1;
  private listeners = new Set<(entry: CommsEntry) => void>();
  /** Last seen crew states per environment; absent until its first snapshot after connecting. */
  private states = new Map<string, Map<string, UnitState>>();
  /** PRs already known merged, per environment and thread: a newly merged one is announced. */
  private merged = new Map<string, Map<string, Set<number>>>();
  private offline = new Map<string, { timer?: ReturnType<typeof setTimeout>; announced: boolean }>();
  private writes: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "comms-log.jsonl");
  }

  async load(): Promise<void> {
    let raw = "";
    try { raw = await fs.readFile(this.file, "utf8"); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    const cutoff = Date.now() - COMMS_RETENTION_DAYS * DAY_MS;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as CommsEntry;
        if (entry.at >= cutoff) this.entries.push(entry);
        this.nextId = Math.max(this.nextId, entry.id + 1);
      } catch { /* A torn last line from a crash. */ }
    }
  }

  add(entry: NewEntry): CommsEntry {
    const full: CommsEntry = { ...entry, id: this.nextId++, at: entry.at ?? Date.now() };
    this.entries.push(full);
    this.writes = this.writes.then(() => fs.appendFile(this.file, `${JSON.stringify(full)}\n`, { mode: 0o600 })).catch((err) => console.warn("[comms] write failed", (err as Error).message));
    for (const listener of this.listeners) listener(full);
    return full;
  }

  /** Entries after `afterId`, or the most recent backlog. */
  since(afterId?: number): CommsEntry[] {
    if (afterId === undefined || !Number.isFinite(afterId)) return this.entries.slice(-COMMS_BACKLOG);
    return this.entries.filter((e) => e.id > afterId).slice(-COMMS_BACKLOG);
  }

  /** Crew state changes on a machine. Its first snapshot after connecting only sets the baseline. */
  observe(envId: string, threads: ThreadShell[]): void {
    const previous = this.states.get(envId);
    const previousMerged = this.merged.get(envId);
    const next = new Map<string, UnitState>();
    const nextMerged = new Map<string, Set<number>>();
    for (const thread of threads) {
      if (isHistory(thread) || thread.archivedAt) continue;
      const to = unitState(thread);
      next.set(thread.id, to);
      // What landed: a PR this thread links that T3 now reports merged.
      const merged = mergedPrs(thread);
      nextMerged.set(thread.id, new Set(merged.keys()));
      if (previousMerged) {
        const known = previousMerged.get(thread.id);
        for (const [number, title] of merged) {
          if (!known?.has(number)) this.add({ tone: "good", kind: "merged", text: `"${thread.title || "Untitled"}": PR #${number} merged${title ? ` (${title})` : ""}`, envId, threadId: thread.id });
        }
      }
      const from = previous?.get(thread.id);
      if (!previous || from === to) continue;
      const line = transitionEntry(thread, from ?? "idle", to);
      if (line) this.add({ ...line, envId, threadId: thread.id });
    }
    this.states.set(envId, next);
    this.merged.set(envId, nextMerged);
  }

  connected(envId: string, label: string): void {
    const state = this.offline.get(envId);
    this.offline.delete(envId);
    if (!state) return;
    clearTimeout(state.timer);
    if (state.announced) this.add({ tone: "good", kind: "online", text: `${label} is back online`, envId });
  }

  /** Announced only if the machine stays away past a short grace period. */
  disconnected(envId: string, label: string): void {
    this.states.delete(envId);
    this.merged.delete(envId);
    if (this.offline.has(envId)) return;
    const state: { timer?: ReturnType<typeof setTimeout>; announced: boolean } = { announced: false };
    state.timer = setTimeout(() => {
      state.announced = true;
      this.add({ tone: "bad", kind: "offline", text: `Lost contact with ${label}`, envId });
    }, OFFLINE_GRACE_MS);
    state.timer.unref();
    this.offline.set(envId, state);
  }

  /** Forget a removed machine without announcing anything. */
  forget(envId: string): void {
    clearTimeout(this.offline.get(envId)?.timer);
    this.offline.delete(envId);
    this.states.delete(envId);
  }

  /** Server-sent events: the backlog (or what was missed after Last-Event-ID), then live entries. */
  /**
   * Stream entries (resuming after Last-Event-ID). `attach` may push other named events on the
   * same connection (read marks) and returns its cleanup.
   */
  stream(req: http.IncomingMessage, res: http.ServerResponse, attach?: (send: (event: string, data: unknown) => void) => () => void): void {
    const resume = Number(req.headers["last-event-id"] ?? new URL(req.url ?? "/", "http://localhost").searchParams.get("after") ?? NaN);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = (entry: CommsEntry) => res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`);
    res.write("retry: 5000\n\n");
    for (const entry of this.since(Number.isFinite(resume) ? resume : undefined)) send(entry);
    res.write("event: synced\ndata: {}\n\n");
    this.listeners.add(send);
    const detach = attach?.((event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
    req.on("close", () => { clearInterval(keepalive); this.listeners.delete(send); detach?.(); });
  }

  /** Drop entries past retention and rewrite the file. */
  async prune(): Promise<void> {
    const cutoff = Date.now() - COMMS_RETENTION_DAYS * DAY_MS;
    if (!this.entries.length || this.entries[0].at >= cutoff) return;
    this.entries = this.entries.filter((e) => e.at >= cutoff);
    await this.writes;
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, this.entries.map((e) => JSON.stringify(e)).join("\n") + (this.entries.length ? "\n" : ""), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}
