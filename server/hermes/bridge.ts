// Translate local Hermes ACP into the small orchestration surface used by the fleet UI.
// Processes belong to the server, not a browser connection. Browser reconnects get snapshots.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import type { Activity, OrchestrationThread, ProjectShell, Provider, ThreadShell } from "../../src/t3/types.ts";
import { AcpProcess, probeHermes, type AcpMessage, type JsonObject } from "./acp.ts";
import { acquireBot, botBusy, HermesManager } from "./manager.ts";
import { HERMES_EDIT_PERMISSIONS, type HermesSession } from "../../shared/hermes.ts";

interface SavedThread {
  thread: OrchestrationThread & Pick<ThreadShell, "hasPendingApprovals" | "hasPendingUserInput">;
  sessionId?: string;
  profile?: string;
  botChat?: boolean;
}
interface Runtime {
  acp: AcpProcess;
  ready: Promise<string>;
  loading: boolean;
  modeIds: Set<string>;
  cancelled: boolean;
  messages: Map<string, string>;
  permissions: Map<string, { id: string | number; toolCallId?: unknown; options: Map<string, string> }>;
  tools: Map<string, JsonObject>;
}
/** What a client stream has already been sent, so later flushes carry only what changed. */
interface SentShell { project: string; threads: Map<string, string> }
interface SentThread {
  base: string;
  messages: Map<string, { text: string; streaming: boolean; fixed: string }>;
  activities: Map<string, string>;
  checkpoints: string;
}
interface Stream {
  tag: string;
  threadId?: string;
  turnLimit?: number;
  waiting: boolean;
  dirty: boolean;
  /** Last sequence sent on this stream; snapshots and items only ever move it forward. */
  seq: number;
  shell?: SentShell;
  thread?: SentThread;
}
interface Client { ws: WebSocket; streams: Map<string, Stream> }
type Thread = SavedThread["thread"];
const now = () => new Date().toISOString();
// Mirror the browser's transcript cap; trim with slack so a full thread doesn't trim (and
// resnapshot open streams) on every new message.
const MESSAGE_CAP = 2000;
const ACTIVITY_CAP = 2000;
const TRIM_SLACK = 200;
/** Snapshots of untagged history (Bot Chat transcripts) keep this many recent messages. */
const UNTAGGED_SNAPSHOT = 200;

function shellOf(thread: Thread): Partial<Thread> {
  const shell: Partial<Thread> = { ...thread };
  delete shell.messages; delete shell.activities; delete shell.checkpoints;
  return shell;
}

/** Fields other than the transcript; any change here is rare (turn start/end) and resnapshots. */
function baseOf(thread: Thread): string {
  const base: Partial<Thread> = shellOf(thread);
  delete base.updatedAt;
  return JSON.stringify(base);
}

export function recordThread(thread: Thread): SentThread {
  return {
    base: baseOf(thread),
    messages: new Map(thread.messages.map((m) => [m.id, { text: m.text, streaming: m.streaming, fixed: JSON.stringify([m.role, m.turnId, m.createdAt, m.attachments]) }])),
    activities: new Map(thread.activities.map((a) => [a.id, JSON.stringify(a)])),
    checkpoints: JSON.stringify(thread.checkpoints),
  };
}

/** Like T3's turnLimit: snapshots carry the most recent turns, not the whole transcript. */
export function recentTurns(thread: Thread, limit: number | undefined): Thread {
  if (!limit) return thread;
  const turns: string[] = [];
  for (const m of thread.messages) if (m.turnId && !turns.includes(m.turnId)) turns.push(m.turnId);
  let start: number;
  if (turns.length > limit) {
    const kept = new Set(turns.slice(-limit));
    start = thread.messages.findIndex((m) => m.turnId !== null && kept.has(m.turnId));
  } else if (turns.length === 0) start = Math.max(0, thread.messages.length - UNTAGGED_SNAPSHOT);
  else return thread;
  const messages = thread.messages.slice(start);
  const since = messages[0]?.createdAt ?? "";
  return { ...thread, messages, activities: thread.activities.filter((a) => a.createdAt >= since) };
}

/**
 * Events that bring a client from `sent` to `thread`, or undefined when only a snapshot can
 * (session/turn changes, replaced or reordered transcripts, non-append text edits).
 */
export function threadEvents(sent: SentThread, thread: Thread, sequence: () => number): Array<{ kind: "event"; event: JsonObject }> | undefined {
  if (baseOf(thread) !== sent.base || JSON.stringify(thread.checkpoints) !== sent.checkpoints) return undefined;
  const events: Array<{ kind: "event"; event: JsonObject }> = [];
  const event = (type: string, payload: JsonObject) => events.push({ kind: "event", event: {
    sequence: sequence(), aggregateKind: "thread", aggregateId: thread.id, occurredAt: now(), type, payload,
  } });
  const known = (ids: Map<string, unknown>, items: Array<{ id: string }>): boolean => {
    let present = 0, added = false;
    for (const item of items) {
      if (ids.has(item.id)) { if (added) return false; present++; } else added = true;
    }
    return present === ids.size; // Nothing removed, and new items only ever follow known ones.
  };
  if (!known(sent.messages, thread.messages) || !known(sent.activities, thread.activities)) return undefined;
  for (const m of thread.messages) {
    const prev = sent.messages.get(m.id);
    const fixed = JSON.stringify([m.role, m.turnId, m.createdAt, m.attachments]);
    const payload: JsonObject = { messageId: m.id, role: m.role, turnId: m.turnId, createdAt: m.createdAt, updatedAt: m.updatedAt,
      ...(m.attachments !== undefined ? { attachments: m.attachments } : {}) };
    if (!prev) event("thread.message-sent", { ...payload, text: m.text, streaming: m.streaming });
    else if (prev.fixed !== fixed) return undefined;
    else if (m.streaming) {
      // The browser appends streaming text, so only an append can travel as a delta.
      if (!m.text.startsWith(prev.text)) return undefined;
      if (m.text.length > prev.text.length || !prev.streaming) event("thread.message-sent", { ...payload, text: m.text.slice(prev.text.length), streaming: true });
    } else if (prev.streaming || prev.text !== m.text) {
      if (!m.text && prev.text) return undefined; // An empty final text would keep the old one.
      event("thread.message-sent", { ...payload, text: m.text, streaming: false });
    }
  }
  for (const a of thread.activities) {
    if (sent.activities.get(a.id) !== JSON.stringify(a)) event("thread.activity-appended", { activity: a as unknown as JsonObject });
  }
  return events;
}

function trim<T>(items: T[], cap: number): void {
  if (items.length > cap + TRIM_SLACK) items.splice(0, items.length - cap);
}
const object = (value: unknown): JsonObject => value && typeof value === "object" ? value as JsonObject : {};
const MODE_IDS: Record<string, string> = Object.fromEntries(HERMES_EDIT_PERMISSIONS.map(mode => [mode.id, mode.modeId]));

export class HermesBridge {
  private project: ProjectShell;
  private threads = new Map<string, SavedThread>();
  private runtimes = new Map<string, Runtime>();
  private clients = new Set<Client>();
  private sequence = 0;
  private file: string;
  private writes: Promise<void> = Promise.resolve();
  private pendingSave?: Promise<void>;
  private commands = new Map<string, Promise<{ sequence: number }>>();
  private launch: { command: string; args: string[] };
  private closed = false;
  private manager?: HermesManager;
  private syncTimer?: ReturnType<typeof setInterval>;
  private syncing = false;
  private releases = new Map<string, () => void>();
  private provider: Provider = {
    instanceId: "hermes", driver: "hermes", displayName: "Hermes", enabled: true, installed: true, status: "ready",
    models: [{ slug: "default", name: "Hermes configured model", isDefault: true }],
    runtimeModes: HERMES_EDIT_PERMISSIONS.map(mode => ({ id: mode.id, label: `${mode.label} (Hermes)` })),
  };

  constructor(dataDir: string, envId: string, workspaceRoot: string, launch: { command: string; args: string[] }, manager?: HermesManager) {
    this.file = path.join(dataDir, `${envId}.json`);
    this.launch = launch;
    this.manager = manager;
    this.project = { id: envId, title: path.basename(workspaceRoot), workspaceRoot, defaultModelSelection: { instanceId: "hermes", model: "default" }, createdAt: now(), updatedAt: now() };
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8")) as { threads: SavedThread[]; sequence: number };
      this.sequence = saved.sequence;
      for (const entry of saved.threads) {
        const t = entry.thread;
        entry.profile ??= 'default';
        t.hermesProfile ??= entry.profile;
        // A host restart cannot prove the old turn is still running.
        if (t.latestTurn?.state === "running") {
          t.latestTurn = { ...t.latestTurn, state: "interrupted", completedAt: now() };
          if (t.session) t.session = { ...t.session, status: "interrupted", activeTurnId: null, updatedAt: now() };
        }
        for (const message of t.messages) message.streaming = false;
        this.clearApprovals(t);
        this.threads.set(t.id, entry);
      }
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }

  /**
   * Saves coalesce: callers share the next write, which serializes the state as of when it
   * starts (after any write in progress), so it always includes the caller's changes.
   */
  private save(): Promise<void> {
    if (this.pendingSave) return this.pendingSave;
    const write = this.writes.then(async () => {
      this.pendingSave = undefined;
      for (const { thread } of this.threads.values()) {
        trim(thread.messages, MESSAGE_CAP);
        trim(thread.activities, ACTIVITY_CAP);
      }
      const body = JSON.stringify({ sequence: this.sequence, threads: [...this.threads.values()] });
      await fs.writeFile(`${this.file}.tmp`, body, { mode: 0o600 });
      await fs.rename(`${this.file}.tmp`, this.file);
    });
    this.pendingSave = write;
    this.writes = write.catch(() => {});
    return write;
  }

  private changed(): void {
    this.sequence++;
    for (const client of this.clients) for (const [id, stream] of client.streams) {
      stream.dirty = true;
      this.flush(client, id, stream);
    }
  }

  /** Send what changed since this stream's last chunk; one chunk in flight until the client acks. */
  private flush(client: Client, id: string, stream: Stream): void {
    if (stream.waiting || !stream.dirty) return;
    stream.dirty = false;
    stream.seq = Math.max(stream.seq, this.sequence);
    const next = () => ++stream.seq;
    let values: JsonObject[];
    if (stream.tag === "orchestration.subscribeShell") values = this.shellItems(stream, next);
    else {
      const thread = this.threads.get(stream.threadId!)?.thread;
      if (!thread) return;
      const events = stream.thread && threadEvents(stream.thread, thread, next);
      if (events) values = events;
      else {
        values = [{ kind: "snapshot", snapshot: { snapshotSequence: stream.seq, thread: recentTurns(thread, stream.turnLimit) } }, { kind: "synchronized" }];
      }
      stream.thread = recordThread(thread);
    }
    if (!values.length) return;
    stream.waiting = true;
    this.send(client, { _tag: "Chunk", requestId: id, values });
  }

  private shellItems(stream: Stream, next: () => number): JsonObject[] {
    const project = JSON.stringify(this.project);
    const threads = new Map([...this.threads.values()].map(({ thread }) => [thread.id, JSON.stringify(shellOf(thread))]));
    const sent = stream.shell;
    stream.shell = { project, threads };
    if (!sent) {
      return [{ kind: "snapshot", snapshot: { snapshotSequence: stream.seq, projects: [this.project],
        threads: [...this.threads.values()].map(({ thread }) => shellOf(thread)) } }, { kind: "synchronized" }];
    }
    const items: JsonObject[] = [];
    if (sent.project !== project) items.push({ kind: "project-upserted", sequence: next(), project: this.project as unknown as JsonObject });
    for (const [threadId, shell] of threads) {
      if (sent.threads.get(threadId) !== shell) items.push({ kind: "thread-upserted", sequence: next(), thread: JSON.parse(shell) as JsonObject });
    }
    for (const threadId of sent.threads.keys()) {
      if (!threads.has(threadId)) items.push({ kind: "thread-removed", sequence: next(), threadId });
    }
    return items;
  }

  private send(client: Client, message: JsonObject): void {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(message));
  }

  attach(ws: WebSocket): void {
    if (this.closed) { ws.close(4404, "Hermes base removed"); return; }
    const client: Client = { ws, streams: new Map() };
    this.clients.add(client);
    if (!this.syncTimer && this.manager) {
      this.syncTimer = setInterval(() => void this.syncBotChats(), 30_000);
      this.syncTimer.unref();
      void this.syncBotChats();
    }
    ws.on("close", () => {
      this.clients.delete(client);
      if (!this.clients.size) { clearInterval(this.syncTimer); this.syncTimer = undefined; }
    });
    ws.on("error", () => this.clients.delete(client));
    ws.on("message", (data) => {
      void this.receive(client, data.toString()).catch(() => ws.close(1008, "Invalid Hermes RPC message"));
    });
  }

  private async receive(client: Client, data: string): Promise<void> {
    const message = JSON.parse(data) as JsonObject;
    if (message._tag === "Ping") { this.send(client, { _tag: "Pong" }); return; }
    const id = String(message.id ?? message.requestId ?? "");
    if (message._tag === "Ack") {
      const stream = client.streams.get(id);
      if (stream) { stream.waiting = false; this.flush(client, id, stream); }
      return;
    }
    if (message._tag === "Interrupt") { client.streams.delete(id); return; }
    if (message._tag !== "Request") return;
    try {
      const tag = String(message.tag);
      const payload = object(message.payload);
      if (tag === "orchestration.subscribeShell" || tag === "orchestration.subscribeThread") {
        const threadId = tag.endsWith("Thread") ? String(payload.threadId) : undefined;
        if (threadId && !this.threads.has(threadId)) throw new Error("Unknown Hermes thread");
        const turnLimit = Number(payload.turnLimit);
        const stream: Stream = { tag, threadId, waiting: false, dirty: true, seq: 0,
          ...(Number.isInteger(turnLimit) && turnLimit > 0 ? { turnLimit } : {}) };
        client.streams.set(id, stream);
        this.flush(client, id, stream);
        return;
      }
      let value: unknown;
      if (tag === "server.getConfig") {
        // The local bridge can be reachable after Hermes itself has been uninstalled.
        // Do not advertise a usable provider until its ACP launcher has answered.
        await probeHermes(this.launch.command, this.launch.args, this.project.workspaceRoot);
        value = { providers: [this.provider] };
      }
      else if (tag === "orchestration.dispatchCommand") value = await this.dispatch(payload);
      else throw new Error(tag === "server.getUsageSummary" ? "Hermes usage estimates are unavailable" : `Unknown request tag: ${tag}`);
      this.send(client, { _tag: "Exit", requestId: id, exit: { _tag: "Success", value } });
    } catch (err) {
      this.send(client, { _tag: "Exit", requestId: id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "HermesError", message: (err as Error).message } }] } });
    }
  }

  private dispatch(command: JsonObject): Promise<{ sequence: number }> {
    if (typeof command.commandId !== "string" || !command.commandId) return Promise.reject(new Error("commandId is required"));
    const existing = this.commands.get(command.commandId);
    if (existing) return existing;
    const operation = this.execute(command);
    this.commands.set(command.commandId, operation);
    if (this.commands.size > 500) this.commands.delete(this.commands.keys().next().value!);
    return operation;
  }

  private async execute(command: JsonObject): Promise<{ sequence: number }> {
    if (this.closed) throw new Error("Hermes base removed");
    const id = String(command.threadId ?? "");
    let entry = this.threads.get(id);
    if (command.type === "thread.turn.start") {
      const message = object(command.message);
      const model = object(command.modelSelection);
      if (!id || !String(message.text ?? "").trim()) throw new Error("A thread and message are required");
      if (model.instanceId !== "hermes" || model.model !== "default") throw new Error("Hermes uses its locally configured model; run hermes model to change it");
      if (!MODE_IDS[String(command.runtimeMode)] || command.interactionMode !== "default") throw new Error("Unsupported Hermes permission or interaction mode");
      if (entry?.thread.latestTurn?.state === "running") throw new Error("Hermes is still working; halt before sending another order");
      const create = object(object(command.bootstrap).createThread);
      const profile = entry?.profile ?? String(create.hermesProfile ?? 'default');
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)) throw new Error('Invalid Hermes profile');
      if (!entry && create.projectId !== this.project.id) throw new Error('Unknown Hermes workspace');
      const release = acquireBot(profile, id);
      this.releases.set(id, release);
      if (!entry) {
        const create = object(object(command.bootstrap).createThread);
        if (create.projectId !== this.project.id) throw new Error("Unknown Hermes workspace");
        const at = now();
        entry = { profile, thread: {
          id, hermesProfile: profile, projectId: this.project.id, title: String(create.title ?? "Hermes"), modelSelection: { instanceId: "hermes", model: "default" },
          runtimeMode: command.runtimeMode as ThreadShell["runtimeMode"], interactionMode: "default", branch: null, worktreePath: null,
          latestTurn: null, session: null, latestUserMessageAt: null, hasPendingApprovals: false, hasPendingUserInput: false,
          createdAt: at, updatedAt: at, archivedAt: null, settledAt: null, unsettledAt: at, snoozedUntil: null, pinnedAt: null,
          messages: [], activities: [], checkpoints: [],
        } };
        this.threads.set(id, entry);
      }
      const t = entry.thread;
      const at = now();
      const turnId = randomUUID();
      t.runtimeMode = command.runtimeMode as ThreadShell["runtimeMode"];
      t.latestTurn = { turnId, state: "running", requestedAt: at, startedAt: null, completedAt: null, assistantMessageId: null };
      t.session = { threadId: id, status: "starting", providerName: "hermes", providerInstanceId: "hermes", runtimeMode: t.runtimeMode, activeTurnId: turnId, lastError: null, updatedAt: at };
      t.latestUserMessageAt = at;
      t.updatedAt = at;
      t.unsettledAt = at;
      t.messages.push({ id: String(message.messageId ?? randomUUID()), role: "user", text: String(message.text), turnId, streaming: false, createdAt: at, updatedAt: at });
      this.changed();
      try { await this.save(); }
      catch (err) { this.finish(t, "error", `Could not save Hermes thread: ${(err as Error).message}`); throw err; }
      // A dispatch acknowledges the durable turn, rather than waiting for its full reply.
      void this.run(entry, String(message.text), turnId);
    } else {
      if (!entry) throw new Error("Unknown Hermes thread");
      const t = entry.thread;
      const runtime = this.runtimes.get(id);
      if (command.type === "thread.turn.interrupt") {
        if (t.latestTurn?.state !== "running") return { sequence: this.sequence };
        if (command.turnId && command.turnId !== t.latestTurn.turnId) throw new Error("Hermes turn has already changed");
        if (runtime) {
          runtime.cancelled = true;
          const sessionId = await runtime.ready;
          this.cancelPermissions(t, runtime);
          runtime.acp.send({ method: "session/cancel", params: { sessionId } });
          // Wait for ACP prompt to settle before declaring the agent halted.
        } else this.finish(t, "interrupted");
      } else if (command.type === "thread.approval.respond") {
        const requestId = String(command.requestId);
        const permission = runtime?.permissions.get(requestId);
        if (!permission || !runtime) throw new Error("Hermes permission request is no longer pending");
        const decision = String(command.decision);
        const optionId = permission.options.get(decision);
        if (!optionId && decision !== "cancel") throw new Error("Hermes did not offer that permission choice");
        runtime.acp.send({ id: permission.id, result: { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } } });
        runtime.permissions.delete(requestId);
        this.activity(t, "approval.resolved", "Permission answered", { requestId, decision });
        t.hasPendingApprovals = runtime.permissions.size > 0;
      } else if (command.type === "thread.runtime-mode.set") {
        const mode = HERMES_EDIT_PERMISSIONS.find(mode => mode.id === command.runtimeMode);
        if (!mode) throw new Error("Unsupported Hermes permission mode");
        if (t.latestTurn?.state === "running") {
          if (!runtime || runtime.loading || !t.latestTurn.startedAt) throw new Error("Hermes is starting. Wait for the turn to start before changing edit permissions.");
          if (!runtime.modeIds.has(mode.modeId)) throw new Error(`Hermes does not support mode ${mode.modeId}; update Hermes`);
          const turnId = t.latestTurn.turnId;
          const sessionId = await runtime.ready;
          await runtime.acp.request("session/set_mode", { sessionId, modeId: mode.modeId });
          if (t.latestTurn?.turnId !== turnId) throw new Error("Hermes has started another turn. Retry the permission change.");
          // A mode change never answers or cancels a pending approval.
        }
        t.runtimeMode = mode.id;
        t.updatedAt = now();
        if (t.session) t.session = { ...t.session, runtimeMode: mode.id, updatedAt: t.updatedAt };
        this.activity(t, "hermes.permissions", `Edit permissions: ${mode.label}`, { runtimeMode: mode.id }, "info");
      } else if (command.type === "thread.settle") t.settledAt = now();
      else if (command.type === "thread.unsettle") t.unsettledAt = now();
      else throw new Error(`Unsupported Hermes command: ${command.type}`);
      this.changed();
      await this.save();
    }
    return { sequence: this.sequence };
  }

  private async runtime(entry: SavedThread): Promise<Runtime> {
    const t = entry.thread;
    const existing = this.runtimes.get(t.id);
    if (existing) { await existing.ready; return existing; }
    const launch = entry.botChat && this.manager ? await this.manager.botLaunch(entry.profile ?? 'default')
      : { command: this.launch.command, args: entry.profile && entry.profile !== 'default' ? ['-p', entry.profile, ...this.launch.args] : this.launch.args, env: undefined };
    const runtime: Runtime = {
      acp: new AcpProcess(launch.command, launch.args, this.project.workspaceRoot,
        (message) => this.acpMessage(t, runtime, message),
        (error) => {
          if (this.runtimes.get(t.id) !== runtime) return;
          this.runtimes.delete(t.id);
          this.clearApprovals(t);
          if (!this.closed && t.latestTurn?.state === "running") this.finish(t, "error", error.message);
        }, launch.env),
      ready: Promise.resolve(""), loading: true, modeIds: new Set(), cancelled: false, messages: new Map(), permissions: new Map(), tools: new Map(),
    };
    this.runtimes.set(t.id, runtime);
    runtime.ready = (async () => {
      const initialized = await runtime.acp.initialize();
      if (initialized.protocolVersion !== 1) throw new Error("Unsupported Hermes ACP protocol");
      const capabilities = object(initialized.agentCapabilities);
      if (entry.sessionId && capabilities.loadSession !== true) throw new Error("This Hermes version cannot reload sessions");
      const result = await runtime.acp.request(entry.sessionId ? "session/load" : "session/new", {
        cwd: this.project.workspaceRoot, mcpServers: [], ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      }, 60_000);
      const sessionId = entry.sessionId ?? result.sessionId;
      if (typeof sessionId !== "string" || !sessionId) throw new Error("Hermes did not return a session ID");
      entry.sessionId = sessionId;
      const modes = object(result.modes).availableModes;
      if (Array.isArray(modes)) for (const mode of modes) {
        const id = object(mode).id;
        if (typeof id === 'string') runtime.modeIds.add(id);
      }
      const modeId = MODE_IDS[t.runtimeMode];
      if (!runtime.modeIds.has(modeId)) throw new Error(`Hermes does not support mode ${modeId}; update Hermes`);
      await runtime.acp.request("session/set_mode", { sessionId, modeId });
      runtime.loading = false;
      await this.save();
      return sessionId;
    })();
    try { await runtime.ready; return runtime; }
    catch (err) { this.runtimes.delete(t.id); runtime.acp.close(); throw err; }
  }

  private async run(entry: SavedThread, text: string, turnId: string): Promise<void> {
    const t = entry.thread;
    if (this.closed || t.latestTurn?.turnId !== turnId || t.latestTurn.state !== "running") return;
    try {
      if (this.manager && entry.profile && entry.profile !== 'default') await this.manager.request('profiles.get', entry.profile);
      if (this.closed || t.latestTurn?.turnId !== turnId || t.latestTurn.state !== 'running') return;
      const runtime = await this.runtime(entry);
      if (runtime.cancelled) { runtime.cancelled = false; this.finish(t, "interrupted"); return; }
      if (this.closed || t.latestTurn?.turnId !== turnId) return;
      runtime.messages.clear();
      await runtime.acp.request("session/set_mode", { sessionId: entry.sessionId, modeId: MODE_IDS[t.runtimeMode] });
      if (runtime.cancelled) { runtime.cancelled = false; this.finish(t, "interrupted"); return; }
      t.session!.status = "running";
      t.latestTurn!.startedAt = now();
      this.changed();
      const result = await runtime.acp.request("session/prompt", { sessionId: entry.sessionId, prompt: [{ type: "text", text }] }, 0);
      const interrupted = runtime.cancelled || result.stopReason === "cancelled";
      runtime.cancelled = false;
      this.cancelPermissions(t, runtime);
      this.finish(t, interrupted ? "interrupted" : "completed");
    } catch (err) {
      if (this.closed) return;
      const runtime = this.runtimes.get(t.id);
      if (runtime) this.cancelPermissions(t, runtime);
      this.finish(t, "error", (err as Error).message);
    }
  }

  private finish(t: SavedThread["thread"], state: "completed" | "interrupted" | "error", error?: string): void {
    // Fresh process per turn reloads profile memory/model/capabilities after other tasks.
    const runtime = this.runtimes.get(t.id);
    this.runtimes.delete(t.id);
    runtime?.acp.close();
    this.releases.get(t.id)?.();
    this.releases.delete(t.id);
    const at = now();
    if (t.latestTurn) t.latestTurn = { ...t.latestTurn, state, completedAt: at };
    if (t.session) t.session = { ...t.session, status: state === "completed" ? "ready" : state, activeTurnId: null, lastError: error ?? null, updatedAt: at };
    for (const message of t.messages) message.streaming = false;
    t.updatedAt = at;
    this.clearApprovals(t);
    if (error) this.activity(t, "hermes.error", error, null, "error");
    this.changed();
    void this.save().catch((err) => console.error("Could not save Hermes state", err));
  }

  private activity(t: SavedThread["thread"], kind: string, summary: string, payload: JsonObject | null, tone: Activity["tone"] = "tool"): void {
    t.activities.push({ id: randomUUID(), kind, summary, payload, tone, turnId: t.latestTurn?.turnId ?? null, createdAt: now() });
  }

  private clearApprovals(t: SavedThread["thread"]): void {
    const open = new Set<string>();
    for (const activity of t.activities) {
      const id = activity.payload?.requestId;
      if (typeof id !== "string") continue;
      if (activity.kind === "approval.requested") open.add(id);
      if (activity.kind === "approval.resolved") open.delete(id);
    }
    for (const requestId of open) this.activity(t, "approval.resolved", "Permission request ended", { requestId }, "info");
    t.hasPendingApprovals = false;
  }

  private cancelPermissions(t: SavedThread["thread"], runtime: Runtime): void {
    for (const permission of runtime.permissions.values()) runtime.acp.send({ id: permission.id, result: { outcome: { outcome: "cancelled" } } });
    runtime.permissions.clear();
    this.clearApprovals(t);
  }

  private acpMessage(t: SavedThread["thread"], runtime: Runtime, message: AcpMessage): void {
    const params = message.params ?? {};
    if (message.method === "session/request_permission" && message.id !== undefined) {
      if (runtime.cancelled || runtime.loading || t.latestTurn?.state !== "running") {
        runtime.acp.send({ id: message.id, result: { outcome: { outcome: "cancelled" } } });
        return;
      }
      const requestId = randomUUID();
      const options = new Map<string, string>();
      const choices: Array<{ decision: string; label: string }> = [];
      for (const value of Array.isArray(params.options) ? params.options : []) {
        const option = object(value);
        const optionId = String(option.optionId);
        const decision = optionId === "allow_session" ? "acceptForSession"
          : option.kind === "allow_once" ? "accept" : option.kind === "allow_always" ? "acceptAlways"
          : option.kind === "reject_once" ? "decline" : option.kind === "reject_always" ? "cancel" : undefined;
        if (!decision || options.has(decision)) continue;
        options.set(decision, optionId);
        choices.push({ decision, label: String(option.name) });
      }
      const tool = object(params.toolCall);
      runtime.permissions.set(requestId, { id: message.id, toolCallId: tool.toolCallId, options });
      this.activity(t, "approval.requested", String(tool.title ?? "Hermes permission request"), { requestId, requestKind: "permission", detail: String(tool.title ?? ""), options: choices }, "approval");
      t.hasPendingApprovals = true;
      this.changed();
      return;
    }
    if (message.id !== undefined) {
      runtime.acp.send({ id: message.id, error: { code: -32601, message: "Client method not supported" } });
      return;
    }
    if (message.method !== "session/update" || runtime.loading || t.latestTurn?.state !== "running") return;
    const update = object(params.update);
    const type = update.sessionUpdate;
    if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
      const content = object(update.content);
      if (content.type !== "text" || typeof content.text !== "string") return;
      const role = type === "agent_thought_chunk" ? "reasoning" : "assistant";
      const key = `${role}:${update.messageId ?? "reply"}`;
      let id = runtime.messages.get(key);
      if (!id) { id = randomUUID(); runtime.messages.set(key, id); }
      let msg = t.messages.find((item) => item.id === id);
      if (!msg) {
        msg = { id, role, text: "", streaming: true, turnId: t.latestTurn!.turnId, createdAt: now(), updatedAt: now() };
        t.messages.push(msg);
      }
      msg.text += content.text;
      msg.updatedAt = now();
      if (role === "assistant") t.latestTurn!.assistantMessageId = id;
    } else if (type === "tool_call" || type === "tool_call_update") {
      const toolId = String(update.toolCallId);
      const tool = { ...runtime.tools.get(toolId), ...update };
      runtime.tools.set(toolId, tool);
      const status = String(tool.status ?? "pending");
      const itemTypes: Record<string, string> = { execute: "command_execution", read: "file_read", edit: "file_change", search: "file_read", fetch: "web_fetch" };
      this.activity(t, status === "completed" || status === "failed" ? "tool.completed" : "tool.started", String(tool.title ?? "Hermes tool"), {
        toolCallId: tool.toolCallId, status, itemType: itemTypes[String(tool.kind)] ?? "dynamic_tool_call", detail: tool.title, rawInput: tool.rawInput, content: tool.content,
      });
      if (status === "completed" || status === "failed") {
        for (const [requestId, permission] of runtime.permissions) {
          if (permission.toolCallId !== tool.toolCallId) continue;
          runtime.permissions.delete(requestId);
          this.activity(t, "approval.resolved", "Hermes permission request ended", { requestId }, "info");
        }
        t.hasPendingApprovals = runtime.permissions.size > 0;
      }
      // Older ACP versions omit message IDs: tool boundaries separate assistant replies.
      runtime.messages.delete("assistant:reply");
      runtime.messages.delete("reasoning:reply");
    } else if (type === "usage_update") {
      if (typeof update.used === "number" && typeof update.size === "number") this.activity(t, "context-window.updated", "Hermes context usage", { usedTokens: update.used, maxTokens: update.size }, "info");
    } else return;
    t.updatedAt = now();
    this.changed();
  }

  private async syncBotChats(): Promise<void> {
    if (this.syncing || this.closed || !this.manager) return;
    this.syncing = true;
    try {
      let changed = false;
      for (const entry of this.threads.values()) {
        if (!entry.botChat || !entry.profile || botBusy(entry.profile)) continue;
        try {
          const session = await this.manager.request<HermesSession | null>('session.read', entry.profile, {}, this.project.workspaceRoot);
          if (!session || botBusy(entry.profile)) continue;
          const current = entry.thread.messages.filter(m => m.role === 'user' || m.role === 'assistant');
          if (entry.sessionId === session.sessionId && JSON.stringify(current.map(m => [m.role, m.text])) === JSON.stringify(session.messages.map(m => [m.role, m.text]))) continue;
          entry.sessionId = session.sessionId;
          entry.thread.messages = session.messages.map(m => ({ ...m, streaming: false, turnId: null, updatedAt: m.createdAt }));
          entry.thread.updatedAt = now();
          changed = true;
        } catch { /* Deleted/unavailable profiles keep their last readable transcript. */ }
      }
      if (changed) { await this.save(); this.changed(); }
    } finally { this.syncing = false; }
  }

  hasRunningTurns(): boolean {
    return [...this.threads.values()].some(({ thread }) => thread.latestTurn?.state === "running");
  }

  async openBotChat(profile: string): Promise<string> {
    if (!this.manager) throw new Error('Hermes management is unavailable');
    const release = acquireBot(profile, 'open-chat');
    try {
      const session = await this.manager.request<HermesSession>('session.open', profile, {}, this.project.workspaceRoot);
      const existing = [...this.threads.values()].find(e => e.botChat && e.profile === profile);
      const at = now();
      const id = existing?.thread.id ?? randomUUID();
      const entry: SavedThread = existing ?? { profile, botChat: true, thread: {
        id, hermesProfile: profile, hermesBotChat: true, projectId: this.project.id, title: `${profile} · Bot Chat`,
        modelSelection: { instanceId: 'hermes', model: 'default' }, runtimeMode: 'approval-required', interactionMode: 'default',
        branch: null, worktreePath: null, latestTurn: null, session: null, latestUserMessageAt: null,
        hasPendingApprovals: false, hasPendingUserInput: false, createdAt: at, updatedAt: at,
        archivedAt: null, settledAt: null, unsettledAt: at, snoozedUntil: null, pinnedAt: at,
        messages: [], activities: [], checkpoints: [],
      } };
      entry.sessionId = session.sessionId;
      // Native transcript includes desktop/routine messages; replace instead of duplicating.
      entry.thread.messages = session.messages.map(m => ({ ...m, streaming: false, turnId: null, updatedAt: m.createdAt }));
      entry.thread.updatedAt = at;
      entry.thread.settledAt = null;
      entry.thread.unsettledAt = at;
      this.threads.set(id, entry);
      await this.save();
      this.changed();
      return id;
    } finally { release(); }
  }

  async close(remove = false): Promise<void> {
    this.closed = true;
    clearInterval(this.syncTimer);
    for (const client of this.clients) client.ws.close(remove ? 4404 : 1001, remove ? "Hermes base removed" : "Command host stopping");
    for (const [id, runtime] of this.runtimes) {
      this.cancelPermissions(this.threads.get(id)!.thread, runtime);
      runtime.acp.close();
    }
    for (const release of this.releases.values()) release();
    this.releases.clear();
    if (!remove) await this.save();
    await this.writes;
    if (remove) await fs.rm(this.file, { force: true });
  }
}
