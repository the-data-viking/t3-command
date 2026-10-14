// Follow-ups, sent by the Command server: an order queued for a crew member that's busy goes out
// when their current turn completes cleanly. Never silently: each send or drop is logged in the
// comms log ("sent by follow-up"), every device sees the queue, and a global pause holds them all.
// One per crew member; it expires after 12 hours; a failed, interrupted or replaced turn drops it.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { FOLLOW_UP_MAX_CHARS, FOLLOW_UP_TTL_MS, SEND_ATTEMPTS, SEND_BACKOFF_MS, STANDING_MAX, STANDING_START_MS, type FollowUp, type FollowUpsView } from "../shared/followups.ts";
import type { ThreadShell } from "../src/t3/types.ts";
import type { CommsLog } from "./comms.ts";

/** What to do with a follow-up given its thread now. */
export function decide(f: FollowUp, thread: ThreadShell | undefined, now: number):
  { action: "wait" } | { action: "send" } | { action: "attach"; turnId: string } | { action: "landed"; turnId: string } | { action: "drop"; reason: string } {
  if (now >= f.expiresAt) return { action: "drop", reason: "it expired after 12 hours" };
  if (!thread) return { action: "drop", reason: "the thread is gone" };
  if (thread.archivedAt) return { action: "drop", reason: "the thread was archived" };
  const turn = thread.latestTurn;
  // A send that errored: if a new turn shows up, it landed after all; otherwise try again later.
  if (f.uncertain && f.afterTurnId !== null) {
    if (turn && turn.turnId !== f.afterTurnId) return { action: "landed", turnId: turn.turnId };
    if (f.uncertain.attempts >= SEND_ATTEMPTS) return { action: "drop", reason: `sending failed ${f.uncertain.attempts} times` };
    if (now < f.uncertain.retryAt) return { action: "wait" };
    return { action: "send" };
  }
  // Waiting for the turn its own order started: any turn but the one before it.
  if (f.afterTurnId === null) {
    if (turn && turn.turnId !== f.startedAfter) return { action: "attach", turnId: turn.turnId };
    if (now - (f.waitingSince ?? f.createdAt) > STANDING_START_MS) return { action: "drop", reason: "its last order didn't start a turn" };
    return { action: "wait" };
  }
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
  /** Told when a queued follow-up goes without being sent (dropped, cancelled, replaced, forgotten). */
  private dropListeners = new Set<(f: FollowUp) => void>();

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

  onDrop(listener: (f: FollowUp) => void): void {
    this.dropListeners.add(listener);
  }

  private dropped(f: FollowUp): void {
    for (const listener of this.dropListeners) listener(f);
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

  /**
   * Queue an order for a busy crew member (replacing any already queued for them). `times` makes
   * it a standing order. With `startedAfter`, the order was just sent from the browser: the
   * repeats wait on the turn it starts (any turn but `startedAfter`), so the crew needn't be busy.
   */
  add(envId: string, threadId: string, text: string, now = Date.now(), opts: { times?: number; startedAfter?: string | null } = {}): FollowUp {
    const order = text.trim();
    if (!order) throw new Error("The order is empty");
    if (order.length > FOLLOW_UP_MAX_CHARS) throw new Error("The order is too long");
    const times = opts.times ?? 1;
    if (!Number.isInteger(times) || times < 1 || times > STANDING_MAX) throw new Error(`A standing order runs 1–${STANDING_MAX} times`);
    const thread = this.threads.get(envId)?.get(threadId);
    if (!thread) throw new Error("That crew member isn't known to the Command server yet");
    const turn = thread.latestTurn;
    const busy = turn?.state === "running" || thread.hasPendingApprovals || thread.hasPendingUserInput;
    const afterOwn = opts.startedAfter !== undefined;
    if (!afterOwn && (!turn || !busy)) throw new Error("That crew member isn't busy: send the order now instead");
    const followUp: FollowUp = {
      id: randomUUID(), envId, threadId, text: order, createdAt: now, expiresAt: now + FOLLOW_UP_TTL_MS,
      ...(afterOwn ? { afterTurnId: null, startedAfter: opts.startedAfter, waitingSince: now } : { afterTurnId: turn!.turnId }),
      ...(times > 1 || afterOwn ? { left: times, total: times + (afterOwn ? 1 : 0) } : {}),
    };
    // One per crew member: one already queued is replaced, and that's said, not silent.
    const replaced = this.queued.find((f) => f.envId === envId && f.threadId === threadId);
    if (replaced) {
      this.comms.add({ tone: "alert", kind: "info", text: `${replaced.total ? "Standing order" : "Follow-up"} for "${thread.title || "Untitled"}" replaced by a newer one: ${preview(replaced.text)}`, envId, threadId });
      this.dropped(replaced);
    }
    this.queued = [...this.queued.filter((f) => !(f.envId === envId && f.threadId === threadId)), followUp];
    this.comms.add({ tone: "info", kind: "info", text: times > 1 || afterOwn
      ? `Standing order for "${thread.title || "Untitled"}", ${times} more time${times === 1 ? "" : "s"} after ${afterOwn ? "this one" : "this turn"}: ${preview(order)}`
      : `Follow-up queued for "${thread.title || "Untitled"}": ${preview(order)}`, envId, threadId });
    this.changed();
    return followUp;
  }

  cancel(id: string): boolean {
    const gone = this.queued.find((f) => f.id === id);
    if (!gone) return false;
    this.queued = this.queued.filter((f) => f.id !== id);
    this.dropped(gone);
    this.changed();
    return true;
  }

  /** A machine removed from the fleet: its queued follow-ups go, and the log says so. */
  forget(envId: string): void {
    const gone = this.queued.filter((f) => f.envId === envId);
    this.threads.delete(envId);
    if (!gone.length) return;
    this.queued = this.queued.filter((f) => f.envId !== envId);
    for (const f of gone) this.dropped(f);
    this.comms.add({ tone: "alert", kind: "info", text: `${gone.length} follow-up${gone.length === 1 ? "" : "s"} dropped: the machine was removed`, envId });
    this.changed();
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.comms.add({ tone: "info", kind: "info", text: paused ? "Follow-ups paused: none will be sent until resumed" : "Follow-ups resumed" });
    this.changed();
    if (!paused) for (const envId of this.threads.keys()) this.evaluate(envId);
  }

  /**
   * Re-judge what's queued on a clock too: a retry's backoff, an expiry or a standing order's start
   * timeout comes due with time, whether or not any thread updates.
   */
  tick(now = Date.now()): void {
    for (const envId of this.threads.keys()) this.evaluate(envId, now);
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
      let verdict = decide(f, thread, now);
      if (verdict.action === "attach") {
        // Its own order's turn has shown up: wait on that one from here (it may already be over).
        const attached: FollowUp = { ...f, afterTurnId: verdict.turnId, startedAfter: undefined, waitingSince: undefined };
        this.queued = this.queued.map((q) => (q.id === f.id ? attached : q));
        this.changed();
        verdict = decide(attached, thread, now);
        if (verdict.action === "send") { this.dispatch(envId, attached, thread!); continue; }
      }
      if (verdict.action === "landed") { this.delivered(envId, f, thread!, verdict.turnId); continue; }
      if (verdict.action === "wait" || verdict.action === "attach") continue;
      if (verdict.action === "drop") {
        this.queued = this.queued.filter((q) => q.id !== f.id);
        this.comms.add({ tone: "alert", kind: "info", text: `Follow-up for "${thread?.title || "Untitled"}" not sent: ${verdict.reason}`, envId, threadId: f.threadId });
        this.dropped(f);
        this.changed();
        continue;
      }
      this.dispatch(envId, f, thread!);
    }
  }

  /**
   * A send went out. A standing order with sends to go then waits on the turn it started: known
   * (`turnId`, when an errored send turned out to have landed) or the next one to show up.
   */
  private delivered(envId: string, f: FollowUp, thread: ThreadShell, turnId?: string): void {
    if (!this.queued.some((q) => q.id === f.id)) return; // Cancelled meanwhile.
    const left = (f.left ?? 1) - 1;
    const where = `"${thread.title || "Untitled"}" on ${this.label(envId) ?? envId}`;
    this.comms.add({ tone: "info", kind: "info", envId, threadId: f.threadId, text: f.total
      ? `Standing order ${f.total - left} of ${f.total} sent to ${where}: ${preview(f.text)}`
      : `Sent by follow-up to ${where}: ${preview(f.text)}` });
    const now = Date.now();
    this.queued = left > 0
      ? this.queued.map((q) => (q.id === f.id ? { ...f, uncertain: undefined, left, expiresAt: now + FOLLOW_UP_TTL_MS,
        ...(turnId ? { afterTurnId: turnId, startedAfter: undefined, waitingSince: undefined } : { afterTurnId: null, startedAfter: thread.latestTurn?.turnId ?? null, waitingSince: now }) } : q))
      : this.queued.filter((q) => q.id !== f.id);
    this.changed();
  }

  private dispatch(envId: string, f: FollowUp, thread: ThreadShell): void {
    if (this.paused) return;
    this.sending.add(f.id);
    void this.send(envId, thread, f.text).then(() => this.delivered(envId, f, thread)).catch((err) => {
      // It may have landed anyway (a timeout, a dropped link): wait to see whether its turn shows
      // up before trying again, backing off, and give up (saying so) after a few tries.
      const current = this.queued.find((q) => q.id === f.id);
      if (!current) return;
      const attempts = (current.uncertain?.attempts ?? 0) + 1;
      const retryAt = Date.now() + SEND_BACKOFF_MS * 2 ** (attempts - 1);
      this.queued = this.queued.map((q) => (q.id === f.id ? { ...q, uncertain: { attempts, retryAt } } : q));
      if (attempts === 1) this.comms.add({ tone: "alert", kind: "info", envId, threadId: f.threadId,
        text: `Follow-up for "${thread.title || "Untitled"}" didn't go through (${(err as Error).message}); trying again shortly` });
      this.changed();
    }).finally(() => this.sending.delete(f.id));
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}

function preview(text: string): string {
  const line = text.split("\n")[0];
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
