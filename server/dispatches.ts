// Squad orders being followed, on the Command server (owner-only dispatches.json): every device
// sees the same receipts. The newest 30 are kept; each is dropped after three days or when closed.
// The server also watches each order's crew, and says once in the comms log (and so by push) when
// everyone's part of it is over. On a mission it first reads each report's own STATUS or BLOCKED
// line, so the notice says what came back: "Mission "Ship it": 2 done, 1 blocked".

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { clipText, DISPATCH_MAX, DISPATCH_START_MS, DISPATCH_TTL_MS, parseReport, sanitizeMembers, sanitizeMission, type Dispatch, type DispatchMember, type MissionReport } from "../shared/dispatches.ts";
import type { ThreadShell } from "../src/t3/types.ts";
import type { CommsLog } from "./comms.ts";

/** How a member's part ended, or undefined while it's still going (or hasn't started yet). */
export function outcome(m: DispatchMember, thread: ThreadShell | undefined, queued: boolean, sentAt = Date.now(), now = Date.now()): "reported" | "failed" | "stopped" | "superseded" | "gone" | "unsent" | "unstarted" | undefined {
  if (m.how === "failed" || m.dropped) return "unsent";
  // The order's own turn, once seen to end: later turns (your own orders, a standing order) don't count.
  if (m.result) return m.result === "completed" ? "reported" : m.result === "error" ? "failed" : m.result === "interrupted" ? "stopped" : "superseded";
  if (!thread || thread.archivedAt) return "gone";
  if (m.turnId && thread.latestTurn && thread.latestTurn.turnId !== m.turnId) return "superseded";
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
  /** Reads a finished turn's reply (the server's own T3 link), for a mission member's report. */
  private readReply?: (envId: string, threadId: string, turnId: string) => Promise<string | undefined>;
  private reading = new Set<string>();

  /** How to read a mission member's reply once their turn is over. */
  readReportsWith(read: (envId: string, threadId: string, turnId: string) => Promise<string | undefined>): void {
    this.readReply = read;
  }

  /** Read and record what a mission member's finished report says of itself, then re-judge the mission. */
  private readReport(d: Dispatch, m: DispatchMember): void {
    const key = `${d.id}:${m.envId}:${m.threadId}`;
    if (!this.readReply || !m.turnId || m.report || this.reading.has(key)) return;
    this.reading.add(key);
    void this.readReply(m.envId, m.threadId, m.turnId)
      .then((text): MissionReport => (text?.trim() ? parseReport(text) : { status: "none" }), (): MissionReport => ({ status: "unread" }))
      .then((report) => {
        this.reading.delete(key);
        const live = this.list.find((x) => x.id === d.id)?.members.find((x) => x.envId === m.envId && x.threadId === m.threadId);
        if (!live || live.report) return;
        live.report = report;
        this.changed();
        const threads = this.threads.get(m.envId);
        if (threads) this.observe(m.envId, [...threads.values()]);
      });
  }

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
            return { id: d.id, text: d.text, at: d.at, members: sanitizeMembers(d.members), ...(mission ? { mission } : {}), ...(typeof d.finishedAt === "number" ? { finishedAt: d.finishedAt } : {}),
              ...(typeof d.missionId === "string" && Number.isInteger(d.round) ? { missionId: d.missionId, round: d.round } : {}) };
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

  /** `round`: a later round of an existing mission (its first round's id); numbered from it. */
  add(text: unknown, members: unknown, now = Date.now(), mission?: unknown, round?: unknown): Dispatch {
    const order = clipText(String(text ?? ""));
    if (!order) throw new Error("The order is empty");
    const clean = sanitizeMembers(members);
    if (!clean.length) throw new Error("A dispatch needs at least one crew member");
    const info = sanitizeMission(mission);
    const of = typeof (round as { missionId?: unknown } | undefined)?.missionId === "string" ? (round as { missionId: string }).missionId : undefined;
    const rounds = of ? this.list.filter((d) => d.id === of || d.missionId === of) : [];
    const next = rounds.length ? { missionId: of!, round: Math.max(...rounds.map((d) => d.round ?? 1)) + 1 } : {};
    const dispatch: Dispatch = { id: randomUUID(), text: order, at: now, members: clean, ...(info ? { mission: info } : {}), ...next };
    this.list = [dispatch, ...this.all(now)].slice(0, DISPATCH_MAX);
    this.changed();
    return dispatch;
  }

  /** Record a retry's outcome: the members given replace the ones with the same crew member. */
  update(id: string, members: unknown): Dispatch | undefined {
    const dispatch = this.list.find((d) => d.id === id);
    if (!dispatch) return undefined;
    const changes = new Map(sanitizeMembers(members).map((m) => [`${m.envId}:${m.threadId}`, m]));
    // Retried or resent to someone (not just another failure): their part is still to come.
    const retried = [...changes.values()].some((m) => m.how !== "failed");
    dispatch.members = dispatch.members.map((m) => changes.get(`${m.envId}:${m.threadId}`) ?? m);
    // A retry that reached someone reopens it: their part is still to come, and will be announced.
    if (retried) delete dispatch.finishedAt;
    this.changed();
    return dispatch;
  }

  /** Stop following an order, or a mission with all its rounds. */
  close(id: string): boolean {
    const before = this.list.length;
    const target = this.list.find((d) => d.id === id);
    const group = target ? target.missionId ?? target.id : id;
    this.list = this.list.filter((d) => d.id !== id && d.id !== group && d.missionId !== group);
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

  /**
   * Pin each member to the turn their order started, and record how it ended, as this machine's
   * threads go by: from then on, later turns on that thread aren't this order's.
   */
  private pin(d: Dispatch, envId: string, threads: Map<string, ThreadShell>): boolean {
    let changed = false;
    for (const m of d.members) {
      if (m.envId !== envId || m.how === "failed" || m.dropped || m.result) continue;
      const thread = threads.get(m.threadId);
      const turn = thread?.latestTurn;
      if (!thread || !turn) continue;
      if (!m.turnId && turn.turnId !== m.baseTurnId && !(m.how === "queued" && this.queued(m.envId, m.threadId))) { m.turnId = turn.turnId; changed = true; }
      if (!m.turnId) continue;
      if (turn.turnId !== m.turnId) { m.result = "superseded"; changed = true; continue; }
      if (turn.state !== "running" && !thread.hasPendingApprovals && !thread.hasPendingUserInput) {
        m.result = turn.state === "completed" ? "completed" : turn.state === "error" ? "error" : "interrupted";
        changed = true;
      }
    }
    return changed;
  }

  /** A machine's latest threads: announce any order whose crew have all finished with it. */
  observe(envId: string, threads: ThreadShell[], now = Date.now()): void {
    const byId = new Map(threads.map((t) => [t.id, t]));
    this.threads.set(envId, byId);
    let changed = false;
    for (const d of this.all(now)) {
      if (d.finishedAt || !d.members.some((m) => m.envId === envId)) continue;
      if (this.pin(d, envId, byId)) changed = true;
      // A mission's finished reports are read for their STATUS line before it's announced.
      const unread = d.mission && this.readReply ? d.members.filter((m) => m.result === "completed" && !m.report) : [];
      for (const m of unread) this.readReport(d, m);
      if (unread.length) continue;
      // A machine not seen yet can't be judged: wait for it.
      if (d.members.some((m) => !this.threads.has(m.envId))) continue;
      const ends = d.members.map((m) => outcome(m, this.threads.get(m.envId)!.get(m.threadId), this.queued(m.envId, m.threadId), d.at, now));
      if (ends.some((e) => e === undefined)) continue;
      // Every send failed just now: give a retry a couple of minutes before calling it.
      if (ends.every((e) => e === "unsent") && now - d.at < 120_000) continue;
      d.finishedAt = now;
      changed = true;
      const reported = ends.filter((e) => e === "reported").length;
      const rest = (["failed", "stopped", "superseded", "unsent", "unstarted", "gone"] as const).map((k) => [k, ends.filter((e) => e === k).length] as const).filter(([, n]) => n);
      const words = { failed: "failed", stopped: "interrupted", superseded: "taken over by a later turn", unsent: "never sent", unstarted: "didn't start", gone: "gone" };
      const what = d.mission ? `Mission "${d.mission.name}"${d.round ? `, round ${d.round}` : ""}` : `Squad order "${preview(d.text)}"`;
      // On a mission, "reported" splits by what each report said of itself.
      const reports = d.members.filter((_, i) => ends[i] === "reported").map((m) => m.report);
      const said = d.mission && this.readReply ? reportWords(reports) : [];
      const allDone = said.length ? reports.every((r) => r?.status === "done") : true;
      this.comms?.add({ tone: rest.length || !allDone ? "alert" : "good", kind: "mission", dispatchId: d.id,
        text: `${what}: ${said.length ? said.join(", ") : `${reported} of ${d.members.length} reported`}${rest.map(([k, n]) => `, ${n} ${words[k]}`).join("")}. Replies are ready to read.` });
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

/** What a mission's reports said of themselves, most hopeful first: "2 done, 1 blocked (needs creds)". */
export function reportWords(reports: Array<MissionReport | undefined>): string[] {
  const count = (s: MissionReport["status"]) => reports.filter((r) => (r?.status ?? "none") === s).length;
  const blocked = reports.filter((r) => r?.status === "blocked");
  return [
    count("done") && `${count("done")} done`,
    count("partial") && `${count("partial")} partly done`,
    blocked.length && `${blocked.length} blocked${blocked.length === 1 && blocked[0]!.note ? ` (${blocked[0]!.note})` : ""}`,
    count("none") && `${count("none")} reported without a status line`,
    count("unread") && `${count("unread")} reported (couldn't read ${count("unread") === 1 ? "it" : "them"})`,
  ].filter((w): w is string => !!w);
}

function preview(text: string): string {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}
