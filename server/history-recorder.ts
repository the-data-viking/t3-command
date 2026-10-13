// Follows every environment's threads from the Command server, which runs around the clock,
// and feeds them to the turn history. T3 servers get their own shell subscription (same token
// and URL as the browser relay); local Hermes bridges are observed in-process.

import { WebSocket } from "ws";
import type { ProjectShell, ShellStreamItem, ThreadShell } from "../src/t3/types.ts";
import type { HermesBridge } from "./hermes/bridge.ts";
import type { TurnHistory } from "./history.ts";
import type { Registry } from "./registry.ts";
import { ProtocolUnsupported, t3SocketUrl } from "./t3-socket.ts";

const SYNC_MS = 60_000;
const PRUNE_MS = 6 * 3_600_000;
const PING_MS = 20_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

interface Follower {
  stop(): void;
  /** One request over the follower's connection (T3 machines only). */
  request?<T>(tag: string, payload: unknown, timeoutMs: number): Promise<T>;
}

/** Other server features that react to what the recorder sees (the comms log). */
export interface RecorderListener {
  observe?(envId: string, threads: ThreadShell[]): void;
  connected?(envId: string, label: string): void;
  disconnected?(envId: string, label: string): void;
  removed?(envId: string): void;
}

export class HistoryRecorder {
  private followers = new Map<string, Follower>();
  /** The latest projects and threads seen per environment, for other server features (storage). */
  private latest = new Map<string, { projects: Record<string, ProjectShell>; threads: ThreadShell[] }>();

  /** The latest projects and threads seen for an environment, if it has reported. */
  snapshot(envId: string): { projects: Record<string, ProjectShell>; threads: ThreadShell[] } | undefined {
    return this.latest.get(envId);
  }
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private listeners: RecorderListener[] = [];

  listen(listener: RecorderListener): void {
    this.listeners.push(listener);
  }

  /** Ask a followed T3 machine something over the recorder's own connection. */
  request<T>(envId: string, tag: string, payload: unknown, timeoutMs = 15_000): Promise<T> {
    const follower = this.followers.get(envId);
    if (!follower?.request) return Promise.reject(new Error("Not connected"));
    return follower.request<T>(tag, payload, timeoutMs);
  }

  private emitObserve(envId: string, threads: ThreadShell[]): void {
    for (const l of this.listeners) l.observe?.(envId, threads);
  }

  private emitConnection(envId: string, label: string, up: boolean): void {
    for (const l of this.listeners) (up ? l.connected : l.disconnected)?.(envId, label);
  }

  private readonly registry: Registry;
  private readonly history: TurnHistory;
  private readonly hermes: (envId: string, workspaceRoot: string) => Promise<HermesBridge>;

  constructor(registry: Registry, history: TurnHistory, hermes: (envId: string, workspaceRoot: string) => Promise<HermesBridge>) {
    this.registry = registry;
    this.history = history;
    this.hermes = hermes;
  }

  start(): void {
    this.sync();
    this.timers.push(setInterval(() => { this.sync(); void this.history.flush(); }, SYNC_MS));
    this.timers.push(setInterval(() => void this.history.prune(), PRUNE_MS));
    for (const timer of this.timers) timer.unref();
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    for (const follower of this.followers.values()) follower.stop();
    this.followers.clear();
    await this.history.flush();
  }

  /** Follow newly added environments and drop removed ones. */
  private sync(): void {
    const ids = new Set(this.registry.ids());
    for (const id of ids) if (!this.followers.has(id)) this.followers.set(id, this.follow(id));
    for (const [id, follower] of this.followers) {
      if (ids.has(id)) continue;
      follower.stop();
      this.followers.delete(id);
      for (const l of this.listeners) l.removed?.(id);
    }
  }

  private follow(envId: string): Follower {
    const env = this.registry.get(envId)!;
    if (env.hermes) return this.followHermes(envId, env.label, env.hermes.workspaceRoot);
    return this.followT3(envId);
  }

  private followHermes(envId: string, label: string, workspaceRoot: string): Follower {
    let stopped = false;
    let unsubscribe: (() => void) | undefined;
    void this.hermes(envId, workspaceRoot).then((bridge) => {
      if (stopped) return;
      this.history.connected(envId, label);
      this.emitConnection(envId, label, true);
      unsubscribe = bridge.observe((project, threads) => {
        this.latest.set(envId, { projects: { [project.id]: project }, threads: threads as ThreadShell[] });
        this.history.observe(envId, { [project.id]: project }, threads as ThreadShell[]);
        this.emitObserve(envId, threads as ThreadShell[]);
      });
    }).catch((err) => console.warn(`[history] Hermes ${label} unavailable`, (err as Error).message));
    return { stop: () => { stopped = true; unsubscribe?.(); this.history.disconnected(envId); } };
  }

  private followT3(envId: string): Follower {
    let stopped = false;
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let attempts = 0;
    const history = this.history;
    const registry = this.registry;
    const latest = this.latest;
    const emitObserve = (threads: ThreadShell[]) => this.emitObserve(envId, threads);
    const emitConnection = (label: string, up: boolean) => this.emitConnection(envId, label, up);
    let up = false;
    let label = registry.get(envId)?.label ?? envId;
    let nextRequest = 2;
    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const failPending = (reason: string) => {
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
      pending.clear();
    };
    const lost = () => {
      failPending("Connection lost");
      if (!up) return;
      up = false;
      history.disconnected(envId);
      emitConnection(label, false);
    };

    const schedule = () => {
      if (stopped) return;
      const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attempts++);
      retry = setTimeout(() => void connect(), delay);
      retry.unref();
    };

    const connect = async () => {
      const env = registry.get(envId);
      if (stopped || !env) return;
      let url: URL;
      let token: string;
      try {
        url = await t3SocketUrl(registry, env, "t3-command-history");
        token = await registry.tokenFor(env);
      } catch (err) {
        // A machine on a newer protocol isn't followed until Command is updated; check back slowly.
        if (err instanceof ProtocolUnsupported) attempts = Math.max(attempts, 6);
        schedule();
        return;
      }
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, maxPayload: 64 * 1024 * 1024 });
      ws = socket;
      let projects: Record<string, ProjectShell> = {};
      let threads = new Map<string, ThreadShell>();
      let synced = false;
      const send = (message: object) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };

      socket.on("open", () => {
        attempts = 0;
        up = true;
        label = env.label;
        history.connected(envId, env.label);
        emitConnection(env.label, true);
        send({ _tag: "Request", id: "1", tag: "orchestration.subscribeShell", payload: { requestCompletionMarker: true }, headers: [] });
        ping = setInterval(() => send({ _tag: "Ping" }), PING_MS);
        ping.unref();
      });
      socket.on("message", (data) => {
        let msg: { _tag: string; requestId?: string; values?: ShellStreamItem[]; exit?: { _tag: string; value?: unknown; cause?: Array<{ error?: { message?: string } }> } };
        try { msg = JSON.parse(data.toString()); } catch { return; }
        const call = msg.requestId ? pending.get(msg.requestId) : undefined;
        if (msg._tag === "Exit" && call) {
          pending.delete(msg.requestId!);
          clearTimeout(call.timer);
          if (msg.exit?._tag === "Success") call.resolve(msg.exit.value);
          else call.reject(new Error(msg.exit?.cause?.[0]?.error?.message ?? "Request failed"));
          return;
        }
        if (msg._tag === "Exit" && msg.requestId === "1") { socket.close(); return; } // The stream ended: reconnect and resubscribe.
        if (msg._tag !== "Chunk" || msg.requestId !== "1") return;
        send({ _tag: "Ack", requestId: "1" });
        for (const item of msg.values ?? []) {
          if (item.kind === "snapshot") {
            projects = Object.fromEntries(item.snapshot.projects.map((p) => [p.id, p]));
            threads = new Map(item.snapshot.threads.map((t) => [t.id, t]));
          } else if (item.kind === "synchronized") synced = true;
          else if (item.kind === "project-upserted") projects = { ...projects, [item.project.id]: item.project };
          else if (item.kind === "project-removed") { projects = { ...projects }; delete projects[item.projectId]; }
          else if (item.kind === "thread-upserted") threads.set(item.thread.id, item.thread);
          else if (item.kind === "thread-removed") {
            // A turn can finish in the same chunk that removes its thread: record it first.
            if (synced) history.observe(envId, projects, [...threads.values()]);
            threads.delete(item.threadId);
          }
        }
        if (synced) {
          latest.set(envId, { projects, threads: [...threads.values()] });
          history.observe(envId, projects, [...threads.values()]);
          emitObserve([...threads.values()]);
        }
      });
      // A rejected token needs re-pairing in the UI; keep retrying slowly without touching state.
      socket.on("unexpected-response", (_req, res) => { attempts = Math.max(attempts, 5); res.resume(); socket.terminate(); });
      socket.on("error", () => { /* "close" follows. */ });
      socket.on("close", () => {
        clearInterval(ping);
        lost();
        if (ws === socket) schedule();
      });
    };

    void connect();
    return {
      stop: () => {
        stopped = true;
        clearTimeout(retry);
        clearInterval(ping);
        failPending("Stopped");
        ws?.terminate();
        history.disconnected(envId);
      },
      request: <T>(tag: string, payload: unknown, timeoutMs: number) => new Promise<T>((resolve, reject) => {
        const socket = ws;
        if (!socket || socket.readyState !== WebSocket.OPEN) { reject(new Error("Not connected")); return; }
        const id = `r${nextRequest++}`;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${tag} timed out`)); }, timeoutMs);
        timer.unref();
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      }),
    };
  }
}
