// Squad orders being followed, on the Command server (owner-only dispatches.json): every device
// sees the same receipts. The newest 30 are kept; each is dropped after three days or when closed.
// The server also watches each order's crew, and says once in the comms log (and so by push) when
// everyone's part of it is over: "Mission "Ship it": 3 of 3 reported".

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { clipText, DISPATCH_MAX, DISPATCH_START_MS, DISPATCH_TTL_MS, sanitizeMembers, sanitizeMission, type Dispatch, type DispatchMember } from "../shared/dispatches.ts";
import type { ThreadShell } from "../src/t3/types.ts";
import type { CommsLog } from "./comms.ts";

/** How a member's part ended, or undefined while it's still going (or hasn't started yet). */
export function outcome(m: DispatchMember, thread: ThreadShell | undefined, queued: boolean, sentAt = Date.now(), now = Date.now()): "reported" | "failed" | "stopped" | "gone" | "unsent" | "unstarted" | undefined {
  if (m.how === "failed" || m.dropped) return "unsent";
  if (!thread || thread.archivedAt) return "gone";
  const turn = thread.latestTurn;
  // Sent, but no turn of its own after a few minutes: it didn't start (and never will by itself).
  if (!turn || turn.turnId === m.baseTurnId) return m.how === "sent" && now - sentAt > DISPATCH_START_MS ? "unstarted" : undefined;
  if (queued || turn.state === "running" || thread.hasPendingApprovals || thread.hasPendingUserInput) return undefined;
  return turn.state === "completed" ? "reported" : turn.state === "error" ? "failed" : "stopped";
}

export class Dispatches {
  private readonly file: string;
  private list: Dispatch[] = [];
  private listeners = new Set<(list: Dispatch[]) => void>();
  /** The latest shells per machine, to tell when an order's crew are all done with it. */
  private threads = new Map<string, Map<string, ThreadShell>>();
  private comms?: CommsLog;
  private queued: (envId: string, threadId: string) => boolean = () => false;
  /** Saves run one at a time, so two at once can't interleave on the temp file. */
  private writes: Promise<unknown> = Promise.resolve();

  /** Where to announce finished orders, and which crew still have a follow-up queued. */
  announceTo(comms: CommsLog, queued: (envId: string, threadId: string) => boolean): void {
    this.comms = comms;
    this.queued = queued;
  }

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "dispatches.json");
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8")) as unknown;
      if (Array.isArray(saved)) {
        this.list = saved.filter((d): d is Dispatch => !!d && typeof d.id === "string" && typeof d.text === "string" && typeof d.at === "number")
          .map((d) => {
            const mission = sanitizeMission(d.mission);
            return { id: d.id, text: d.text, at: d.at, members: sanitizeMembers(d.members), ...(mission ? { mission } : {}), ...(typeof d.finishedAt === "number" ? { finishedAt: d.finishedAt } : {}) };
          });
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

  add(text: unknown, members: unknown, now = Date.now(), mission?: unknown): Dispatch {
    const order = clipText(String(text ?? ""));
    if (!order) throw new Error("The order is empty");
    const clean = sanitizeMembers(members);
    if (!clean.length) throw new Error("A dispatch needs at least one crew member");
    const info = sanitizeMission(mission);
    const dispatch: Dispatch = { id: randomUUID(), text: order, at: now, members: clean, ...(info ? { mission: info } : {}) };
    this.list = [dispatch, ...this.all(now)].slice(0, DISPATCH_MAX);
    this.changed();
    return dispatch;
  }

  /** Record a retry's outcome: the members given replace the ones with the same crew member. */
  update(id: string, members: unknown): Dispatch | undefined {
    const dispatch = this.list.find((d) => d.id === id);
    if (!dispatch) return undefined;
    const changes = new Map(sanitizeMembers(members).map((m) => [`${m.envId}:${m.threadId}`, m]));
    const retried = dispatch.members.some((m) => m.how === "failed" && changes.has(`${m.envId}:${m.threadId}`) && changes.get(`${m.envId}:${m.threadId}`)!.how !== "failed");
    dispatch.members = dispatch.members.map((m) => changes.get(`${m.envId}:${m.threadId}`) ?? m);
    // A retry that reached someone reopens it: their part is still to come, and will be announced.
    if (retried) delete dispatch.finishedAt;
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

  /** A follow-up that went unsent: the member it was queued for will never get this order. */
  followUpDropped(envId: string, threadId: string, afterTurnId: string | null): void {
    let changed = false;
    for (const d of this.list) {
      if (d.finishedAt) continue;
      for (const m of d.members) {
        if (m.envId !== envId || m.threadId !== threadId || m.how !== "queued" || m.dropped || m.baseTurnId !== afterTurnId) continue;
        m.dropped = true;
        changed = true;
      }
    }
    if (!changed) return;
    this.changed();
    const threads = this.threads.get(envId);
    if (threads) this.observe(envId, [...threads.values()]);
  }

  /** Re-judge every order on a clock too: "didn't start" needs time to pass, not a thread update. */
  tick(now = Date.now()): void {
    for (const [envId, threads] of this.threads) this.observe(envId, [...threads.values()], now);
  }

  /** A machine removed from the fleet: its crew are gone from every order still playing out. */
  forget(envId: string): void {
    this.observe(envId, []);
  }

  /** A machine's latest threads: announce any order whose crew have all finished with it. */
  observe(envId: string, threads: ThreadShell[], now = Date.now()): void {
    this.threads.set(envId, new Map(threads.map((t) => [t.id, t])));
    let changed = false;
    for (const d of this.all(now)) {
      if (d.finishedAt || !d.members.some((m) => m.envId === envId)) continue;
      // A machine not seen yet can't be judged: wait for it.
      if (d.members.some((m) => !this.threads.has(m.envId))) continue;
      const ends = d.members.map((m) => outcome(m, this.threads.get(m.envId)!.get(m.threadId), this.queued(m.envId, m.threadId), d.at, now));
      if (ends.some((e) => e === undefined)) continue;
      // Every send failed just now: give a retry a couple of minutes before calling it.
      if (ends.every((e) => e === "unsent") && now - d.at < 120_000) continue;
      d.finishedAt = now;
      changed = true;
      const reported = ends.filter((e) => e === "reported").length;
      const rest = (["failed", "stopped", "unsent", "unstarted", "gone"] as const).map((k) => [k, ends.filter((e) => e === k).length] as const).filter(([, n]) => n);
      const words = { failed: "failed", stopped: "interrupted", unsent: "never sent", unstarted: "didn't start", gone: "gone" };
      const what = d.mission ? `Mission "${d.mission.name}"` : `Squad order "${preview(d.text)}"`;
      this.comms?.add({ tone: rest.length ? "alert" : "good", kind: "mission", dispatchId: d.id,
        text: `${what}: ${reported} of ${d.members.length} reported${rest.map(([k, n]) => `, ${n} ${words[k]}`).join("")}. Replies are ready to read.` });
    }
    if (changed) this.changed();
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

function preview(text: string): string {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}
