// Follow-ups, sent by the Command server: an order queued for a crew member that's busy goes out
// when their current turn completes cleanly. Never silently: each send or drop is logged in the
// comms log ("sent by follow-up"), every device sees the queue, and a global pause holds them all.
// One per crew member; it expires after 12 hours; a failed, interrupted or replaced turn drops it.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { FOLLOW_UP_MAX_CHARS, FOLLOW_UP_TTL_MS, type FollowUp, type FollowUpsView } from "../shared/followups.ts";
import type { ThreadShell } from "../src/t3/types.ts";
import type { CommsLog } from "./comms.ts";

/** What to do with a follow-up given its thread now. */
export function decide(f: FollowUp, thread: ThreadShell | undefined, now: number): { action: "wait" } | { action: "send" } | { action: "drop"; reason: string } {
  if (now >= f.expiresAt) return { action: "drop", reason: "it expired after 12 hours" };
  if (!thread) return { action: "drop", reason: "the thread is gone" };
  if (thread.archivedAt) return { action: "drop", reason: "the thread was archived" };
  const turn = thread.latestTurn;
  if (!turn) return { action: "wait" };
  if (turn.turnId !== f.afterTurnId) return { action: "drop", reason: "another order started a new turn first" };
  if (turn.state === "running" || thread.hasPendingApprovals || thread.hasPendingUserInput) return { action: "wait" };
  if (turn.state === "completed") return { action: "send" };
  return { action: "drop", reason: `the turn ${turn.state === "error" ? "failed" : "was interrupted"}` };
}

/** Sends an order (thread.turn.start) to a thread on a machine; provided by the server's T3 link. */
export type SendOrder = (envId: string, thread: ThreadShell, text: string) => Promise<void>;

export class FollowUps {
  private readonly file: string;
  private queued: FollowUp[] = [];
  private paused = false;
  private sending = new Set<string>();
  private listeners = new Set<(view: FollowUpsView) => void>();
  private writes: Promise<void> = Promise.resolve();
  /** The latest shells per machine, to place a new follow-up and to judge queued ones. */
  private threads = new Map<string, Map<string, ThreadShell>>();

  private readonly comms: CommsLog;
  private readonly send: SendOrder;
  private readonly label: (envId: string) => string | undefined;

  constructor(dataDir: string, comms: CommsLog, send: SendOrder, label: (envId: string) => string | undefined) {
    this.file = path.join(dataDir, "followups.json");
    this.comms = comms;
    this.send = send;
    this.label = label;
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8")) as FollowUpsView;
      this.queued = Array.isArray(saved.queued) ? saved.queued : [];
      this.paused = saved.paused === true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[followups] load failed", (err as Error).message);
    }
  }

  view(): FollowUpsView {
    return { paused: this.paused, queued: [...this.queued] };
  }

  subscribe(listener: (view: FollowUpsView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    const view = this.view();
    this.writes = this.writes.then(async () => {
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(view), { mode: 0o600 });
      await fs.rename(tmp, this.file);
    }).catch((err) => console.warn("[followups] write failed", (err as Error).message));
    for (const listener of this.listeners) listener(view);
  }

  /** Queue an order for a busy crew member (replacing any already queued for them). */
  add(envId: string, threadId: string, text: string, now = Date.now()): FollowUp {
    const order = text.trim();
    if (!order) throw new Error("The order is empty");
    if (order.length > FOLLOW_UP_MAX_CHARS) throw new Error("The order is too long");
    const thread = this.threads.get(envId)?.get(threadId);
    if (!thread) throw new Error("That crew member isn't known to the Command server yet");
    const turn = thread.latestTurn;
    const busy = turn?.state === "running" || thread.hasPendingApprovals || thread.hasPendingUserInput;
    if (!turn || !busy) throw new Error("That crew member isn't busy: send the order now instead");
    const followUp: FollowUp = { id: randomUUID(), envId, threadId, afterTurnId: turn.turnId, text: order, createdAt: now, expiresAt: now + FOLLOW_UP_TTL_MS };
    this.queued = [...this.queued.filter((f) => !(f.envId === envId && f.threadId === threadId)), followUp];
    this.comms.add({ tone: "info", kind: "info", text: `Follow-up queued for "${thread.title || "Untitled"}": ${preview(order)}`, envId, threadId });
    this.changed();
    return followUp;
  }

  cancel(id: string): boolean {
    const before = this.queued.length;
    this.queued = this.queued.filter((f) => f.id !== id);
    if (this.queued.length === before) return false;
    this.changed();
    return true;
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.comms.add({ tone: "info", kind: "info", text: paused ? "Follow-ups paused: none will be sent until resumed" : "Follow-ups resumed" });
    this.changed();
    if (!paused) for (const envId of this.threads.keys()) this.evaluate(envId);
  }

  /** A machine's latest threads (from the server's own T3 link): send or drop what's due. */
  observe(envId: string, threads: ThreadShell[]): void {
    this.threads.set(envId, new Map(threads.map((t) => [t.id, t])));
    this.evaluate(envId);
  }

  private evaluate(envId: string, now = Date.now()): void {
    const threads = this.threads.get(envId);
    if (!threads) return;
    for (const f of this.queued.filter((q) => q.envId === envId)) {
      if (this.sending.has(f.id)) continue;
      const thread = threads.get(f.threadId);
      const verdict = decide(f, thread, now);
      if (verdict.action === "wait") continue;
      if (verdict.action === "drop") {
        this.queued = this.queued.filter((q) => q.id !== f.id);
        this.comms.add({ tone: "alert", kind: "info", text: `Follow-up for "${thread?.title || "Untitled"}" not sent: ${verdict.reason}`, envId, threadId: f.threadId });
        this.changed();
        continue;
      }
      if (this.paused) continue;
      this.sending.add(f.id);
      void this.send(envId, thread!, f.text).then(() => {
        this.comms.add({ tone: "info", kind: "info", text: `Sent by follow-up to "${thread!.title || "Untitled"}" on ${this.label(envId) ?? envId}: ${preview(f.text)}`, envId, threadId: f.threadId });
        this.queued = this.queued.filter((q) => q.id !== f.id);
        this.changed();
      }).catch((err) => {
        // Keep it queued: the next observation retries (until it expires).
        console.warn("[followups] send failed", (err as Error).message);
      }).finally(() => this.sending.delete(f.id));
    }
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}

function preview(text: string): string {
  const line = text.split("\n")[0];
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
