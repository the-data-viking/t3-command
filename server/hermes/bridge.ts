// Translate local Hermes ACP into the small orchestration surface used by the fleet UI.
// Processes belong to the server, not a browser connection. Browser reconnects get snapshots.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import type { Activity, OrchestrationThread, ProjectShell, Provider, ThreadShell } from "../../src/t3/types.ts";
import { AcpProcess, probeHermes, type AcpMessage, type JsonObject } from "./acp.ts";

interface SavedThread {
  thread: OrchestrationThread & Pick<ThreadShell, "hasPendingApprovals" | "hasPendingUserInput">;
  sessionId?: string;
}
interface Runtime {
  acp: AcpProcess;
  ready: Promise<string>;
  loading: boolean;
  cancelled: boolean;
  messages: Map<string, string>;
  permissions: Map<string, { id: string | number; toolCallId?: unknown; options: Map<string, string> }>;
  tools: Map<string, JsonObject>;
}
interface Stream { tag: string; threadId?: string; waiting: boolean; dirty: boolean }
interface Client { ws: WebSocket; streams: Map<string, Stream> }
const now = () => new Date().toISOString();
const object = (value: unknown): JsonObject => value && typeof value === "object" ? value as JsonObject : {};
const MODE_IDS: Record<string, string> = { "approval-required": "default", "auto-accept-edits": "accept_edits" };

export class HermesBridge {
  private project: ProjectShell;
  private threads = new Map<string, SavedThread>();
  private runtimes = new Map<string, Runtime>();
  private clients = new Set<Client>();
  private sequence = 0;
  private file: string;
  private writes: Promise<void> = Promise.resolve();
  private commands = new Map<string, Promise<{ sequence: number }>>();
  private launch: { command: string; args: string[] };
  private closed = false;
  private provider: Provider = {
    instanceId: "hermes", driver: "hermes", displayName: "Hermes", enabled: true, installed: true, status: "ready",
    models: [{ slug: "default", name: "Hermes configured model", isDefault: true }],
    runtimeModes: [{ id: "approval-required", label: "Ask before edits (Hermes)" }, { id: "auto-accept-edits", label: "Accept workspace edits (Hermes)" }],
  };

  constructor(dataDir: string, envId: string, workspaceRoot: string, launch: { command: string; args: string[] }) {
    this.file = path.join(dataDir, `${envId}.json`);
    this.launch = launch;
    this.project = { id: envId, title: path.basename(workspaceRoot), workspaceRoot, defaultModelSelection: { instanceId: "hermes", model: "default" }, createdAt: now(), updatedAt: now() };
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8")) as { threads: SavedThread[]; sequence: number };
      this.sequence = saved.sequence;
      for (const entry of saved.threads) {
        const t = entry.thread;
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

  private save(): Promise<void> {
    const body = JSON.stringify({ sequence: this.sequence, threads: [...this.threads.values()] });
    const write = this.writes.then(async () => {
      await fs.writeFile(`${this.file}.tmp`, body, { mode: 0o600 });
      await fs.rename(`${this.file}.tmp`, this.file);
    });
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

  private flush(client: Client, id: string, stream: Stream): void {
    if (stream.waiting || !stream.dirty) return;
    stream.dirty = false;
    stream.waiting = true;
    const snapshot = stream.tag === "orchestration.subscribeShell"
      ? { snapshotSequence: this.sequence, projects: [this.project], threads: [...this.threads.values()].map(({ thread }) => {
        const shell: Partial<SavedThread["thread"]> = { ...thread };
        delete shell.messages; delete shell.activities; delete shell.checkpoints;
        return shell;
      }) }
      : { snapshotSequence: this.sequence, thread: this.threads.get(stream.threadId!)!.thread };
    this.send(client, { _tag: "Chunk", requestId: id, values: [{ kind: "snapshot", snapshot }, { kind: "synchronized" }] });
  }

  private send(client: Client, message: JsonObject): void {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(message));
  }

  attach(ws: WebSocket): void {
    if (this.closed) { ws.close(4404, "Hermes base removed"); return; }
    const client: Client = { ws, streams: new Map() };
    this.clients.add(client);
    ws.on("close", () => this.clients.delete(client));
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
        const stream: Stream = { tag, threadId, waiting: false, dirty: true };
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
      if (!entry) {
        const create = object(object(command.bootstrap).createThread);
        if (create.projectId !== this.project.id) throw new Error("Unknown Hermes workspace");
        const at = now();
        entry = { thread: {
          id, projectId: this.project.id, title: String(create.title ?? "Hermes"), modelSelection: { instanceId: "hermes", model: "default" },
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
    const runtime: Runtime = {
      acp: new AcpProcess(this.launch.command, this.launch.args, this.project.workspaceRoot,
        (message) => this.acpMessage(t, runtime, message),
        (error) => {
          this.runtimes.delete(t.id);
          this.clearApprovals(t);
          if (!this.closed && t.latestTurn?.state === "running") this.finish(t, "error", error.message);
        }),
      ready: Promise.resolve(""), loading: true, cancelled: false, messages: new Map(), permissions: new Map(), tools: new Map(),
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
      const modeId = MODE_IDS[t.runtimeMode];
      if (!Array.isArray(modes) || !modes.some((mode) => object(mode).id === modeId)) throw new Error(`Hermes does not support mode ${modeId}; update Hermes`);
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

  async close(remove = false): Promise<void> {
    this.closed = true;
    for (const client of this.clients) client.ws.close(remove ? 4404 : 1001, remove ? "Hermes base removed" : "Command host stopping");
    for (const [id, runtime] of this.runtimes) {
      this.cancelPermissions(this.threads.get(id)!.thread, runtime);
      runtime.acp.close();
    }
    if (!remove) await this.save();
    await this.writes;
    if (remove) await fs.rm(this.file, { force: true });
  }
}
