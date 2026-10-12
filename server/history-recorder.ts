// Follows every environment's threads from the Command server, which runs around the clock,
// and feeds them to the turn history. T3 servers get their own shell subscription (same token
// and URL as the browser relay); local Hermes bridges are observed in-process.

import { WebSocket } from "ws";
import type { ProjectShell, ShellStreamItem, ThreadShell } from "../src/t3/types.ts";
import type { HermesBridge } from "./hermes/bridge.ts";
import type { TurnHistory } from "./history.ts";
import type { Registry } from "./registry.ts";

const SYNC_MS = 60_000;
const PRUNE_MS = 6 * 3_600_000;
const PING_MS = 20_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

interface Follower { stop(): void }

export class HistoryRecorder {
  private followers = new Map<string, Follower>();
  /** The latest projects and threads seen per environment, for other server features (storage). */
  private latest = new Map<string, { projects: Record<string, ProjectShell>; threads: ThreadShell[] }>();

  /** The latest projects and threads seen for an environment, if it has reported. */
  snapshot(envId: string): { projects: Record<string, ProjectShell>; threads: ThreadShell[] } | undefined {
    return this.latest.get(envId);
  }
  private timers: Array<ReturnType<typeof setInterval>> = [];

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
    for (const [id, follower] of this.followers) if (!ids.has(id)) { follower.stop(); this.followers.delete(id); }
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
      unsubscribe = bridge.observe((project, threads) => {
        this.latest.set(envId, { projects: { [project.id]: project }, threads: threads as ThreadShell[] });
        this.history.observe(envId, { [project.id]: project }, threads as ThreadShell[]);
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
        url = new URL("/ws", await registry.resolveUrl(env));
        token = await registry.tokenFor(env);
      } catch {
        schedule();
        return;
      }
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("clientSurface", "web");
      url.searchParams.set("clientAppVersion", "t3-command-history");
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, maxPayload: 64 * 1024 * 1024 });
      ws = socket;
      let projects: Record<string, ProjectShell> = {};
      let threads = new Map<string, ThreadShell>();
      let synced = false;
      const send = (message: object) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };

      socket.on("open", () => {
        attempts = 0;
        history.connected(envId, env.label);
        send({ _tag: "Request", id: "1", tag: "orchestration.subscribeShell", payload: { requestCompletionMarker: true }, headers: [] });
        ping = setInterval(() => send({ _tag: "Ping" }), PING_MS);
        ping.unref();
      });
      socket.on("message", (data) => {
        let msg: { _tag: string; requestId?: string; values?: ShellStreamItem[] };
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg._tag === "Exit") { socket.close(); return; } // The stream ended: reconnect and resubscribe.
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
        }
      });
      // A rejected token needs re-pairing in the UI; keep retrying slowly without touching state.
      socket.on("unexpected-response", (_req, res) => { attempts = Math.max(attempts, 5); res.resume(); socket.terminate(); });
      socket.on("error", () => { /* "close" follows. */ });
      socket.on("close", () => {
        clearInterval(ping);
        history.disconnected(envId);
        if (ws === socket) schedule();
      });
    };

    void connect();
    return {
      stop: () => {
        stopped = true;
        clearTimeout(retry);
        clearInterval(ping);
        ws?.terminate();
        history.disconnected(envId);
      },
    };
  }
}
