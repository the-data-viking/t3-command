// One live connection to one T3 environment, relayed through the t3-command server.
// Keeps that environment's slice of the game store up to date and sends commands to it.

import type { EnvSummary } from "../../shared/api";
import { addLog, unitKey, updateEnv, useGame, type Connection, type EnvWorld } from "../store";
import { unitState, type UnitState } from "./derive";
import { applyThreadEvent } from "./reducer";
import { RpcConnection, RpcError } from "./rpc";
import { assetProxyUrl } from "./assets";
import type { QuestionAnswers } from "./questions";
import { supportedUsage, historyWindow, type UsageSummary } from "./usage";
import type { HostResources } from "./host";
import { defaultBranch, latestWorktree, type ProjectRefs, type RecruitWorkspace } from "./workspace";
import type {
  AssetUrl,
  ImageResource,
  ApprovalDecision,
  InteractionMode,
  ModelSelection,
  RuntimeMode,
  ServerConfig,
  ShellStreamItem,
  ThreadShell,
  ThreadStreamItem,
} from "./types";

/** Close codes sent by the t3-command relay (server/index.ts). */
const CLOSE_NEEDS_PAIRING = 4401;
const CLOSE_UNKNOWN_ENV = 4404;

/** How many recent turns to load when opening a thread. */
const THREAD_TURN_LIMIT = 6;

export interface UnitTransition {
  envId: string;
  thread: ThreadShell;
  from: UnitState;
  to: UnitState;
}

type TransitionListener = (t: UnitTransition) => void;
const transitionListeners = new Set<TransitionListener>();

/** Subscribe to unit state changes (e.g. working → done) for sound effects and the event log. */
export function onUnitTransition(fn: TransitionListener): () => void {
  transitionListeners.add(fn);
  return () => transitionListeners.delete(fn);
}

function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function emptyWorld(summary: EnvSummary, connection: Connection): EnvWorld {
  return { summary, connection, synced: false, projects: {}, threads: {}, providers: [] };
}

interface ThreadSub {
  refs: number;
  sequence: number;
  cancel?: () => void;
}

export class EnvironmentClient {
  readonly id: string;
  private summary: EnvSummary;
  private rpc?: RpcConnection;
  private shellSequence = 0;
  private threadSubs = new Map<string, ThreadSub>();
  private retries = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private usageTimer?: ReturnType<typeof setTimeout>;
  private hostTimer?: ReturnType<typeof setTimeout>;
  private hostPending?: RpcConnection;
  private usagePending?: RpcConnection;

  constructor(summary: EnvSummary) {
    this.id = summary.id;
    this.summary = summary;
  }

  start(): void {
    document.addEventListener("visibilitychange", this.onVisibility);
    const blocked: Partial<Record<EnvSummary["status"], Connection>> = {
      "needs-pairing": "needs-pairing",
      "needs-update": "needs-update",
    };
    const connection = blocked[this.summary.status];
    useGame.setState((s) => ({
      envs: { ...s.envs, [this.id]: emptyWorld(this.summary, connection ?? "connecting") },
    }));
    if (connection) {
      updateEnv(this.id, (e) => ({ ...e, error: this.summary.statusDetail }));
      return;
    }
    this.connect();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.usageTimer);
    clearTimeout(this.hostTimer);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.rpc?.close();
    useGame.setState((s) => {
      const envs = { ...s.envs };
      delete envs[this.id];
      const details = Object.fromEntries(Object.entries(s.details).filter(([k]) => !k.startsWith(`${this.id}:`)));
      const selection = s.selection?.envId === this.id ? null : s.selection;
      const hosts = { ...s.hosts };
      delete hosts[this.id];
      return { envs, details, selection, hosts, hostPanel: s.hostPanel === this.id ? null : s.hostPanel };
    });
  }

  // ---- Connection lifecycle ------------------------------------------------------

  private connect(): void {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const url = `${scheme}://${location.host}/env/${encodeURIComponent(this.id)}/ws`;
    this.rpc = new RpcConnection(url, {
      onOpen: () => this.onOpen(),
      onClose: (code, reason) => this.onClose(code, reason),
    });
  }

  private setConnection(connection: Connection, error?: string): void {
    updateEnv(this.id, (e) => ({ ...e, connection, error }));
  }

  private onOpen(): void {
    this.retries = 0;
    this.setConnection("live");
    this.loadConfig();
    void this.loadUsage();
    void this.loadHost();
    this.subscribeShell();
    for (const [threadId, sub] of this.threadSubs) this.subscribeThread(threadId, sub);
  }

  private onClose(code: number, reason: string): void {
    clearTimeout(this.usageTimer);
    clearTimeout(this.hostTimer);
    useGame.setState((s) => s.hosts[this.id] ? { hosts: { ...s.hosts,
      [this.id]: { ...s.hosts[this.id], error: "Host connection lost." } } } : {});
    for (const sub of this.threadSubs.values()) sub.cancel = undefined;
    if (this.disposed) return;
    if (code === CLOSE_NEEDS_PAIRING) {
      this.setConnection("needs-pairing", reason || "T3 rejected t3-command's token");
      return;
    }
    if (code === CLOSE_UNKNOWN_ENV) {
      this.setConnection("offline", "This environment was removed from t3-command");
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** this.retries++);
    this.setConnection("reconnecting", reason || `Connection lost; retrying in ${Math.round(delay / 1000)}s`);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private async loadConfig(): Promise<void> {
    try {
      const config = await this.rpc!.request<ServerConfig>("server.getConfig");
      updateEnv(this.id, (e) => ({ ...e, providers: config.providers }));
    } catch (err) {
      console.warn(`[${this.summary.label}] server.getConfig failed`, err);
    }
  }

  private async loadUsage(): Promise<void> {
    if (this.summary.kind === "hermes") {
      const error = "Hermes usage estimates are unavailable";
      updateEnv(this.id, (env) => env.usage?.error === error && !env.usage.summary ? env : { ...env, usage: { error } });
      return;
    }
    const rpc = this.rpc;
    if (!rpc?.isOpen || this.disposed || this.usagePending === rpc) return;
    clearTimeout(this.usageTimer);
    this.usagePending = rpc;
    let retry = true;
    try {
      // Native transcript scans are memoised by T3; never run overlapping scans here.
      if (document.visibilityState !== "hidden") {
        const summary = await rpc.request<UsageSummary>("server.getUsageSummary", historyWindow(), 90_000);
        if (this.disposed || this.rpc !== rpc || !rpc.isOpen) return;
        if (!supportedUsage(summary)) throw new Error(`Unsupported usage contract v${summary.contractVersion}`);
        updateEnv(this.id, (e) => ({ ...e, usage: { summary } }));
      }
    } catch (err) {
      if (this.disposed || this.rpc !== rpc || !rpc.isOpen) return;
      const message = err instanceof Error ? err.message : String(err);
      retry = !/Unknown request tag|Unsupported usage contract/.test(message);
      updateEnv(this.id, (e) => ({ ...e, usage: { ...e.usage, error: message } }));
    } finally {
      if (this.usagePending === rpc) this.usagePending = undefined;
      if (retry && !document.hidden && !this.disposed && this.rpc === rpc && rpc.isOpen) {
        this.usageTimer = setTimeout(() => void this.loadUsage(), 60_000);
      }
    }
  }

  private onVisibility = (): void => {
    if (document.hidden) {
      clearTimeout(this.hostTimer);
      clearTimeout(this.usageTimer);
      return;
    }
    void this.loadHost();
    void this.loadUsage();
  };

  private async loadHost(): Promise<void> {
    const rpc = this.rpc;
    if (!rpc?.isOpen || this.disposed || this.hostPending === rpc) return;
    clearTimeout(this.hostTimer);
    this.hostPending = rpc;
    let retry = true;
    try {
      if (!document.hidden) {
        const snapshot = await rpc.request<HostResources>("server.getHostResources", {}, 15_000);
        if (this.disposed || this.rpc !== rpc || !rpc.isOpen) return;
        useGame.setState((s) => {
          const history = (s.hosts[this.id]?.history ?? []).filter((h) => h.sampledAt > snapshot.sampledAt - 20 * 60_000 && h.sampledAt !== snapshot.sampledAt);
          return { hosts: { ...s.hosts, [this.id]: { snapshot, history: [...history, snapshot].slice(-120) } } };
        });
      }
    } catch (err) {
      if (this.disposed || this.rpc !== rpc || !rpc.isOpen) return;
      const error = err instanceof Error ? err.message : String(err);
      retry = !error.includes("Unknown request tag");
      useGame.setState((s) => ({ hosts: { ...s.hosts, [this.id]: { ...s.hosts[this.id], history: s.hosts[this.id]?.history ?? [], error } } }));
    } finally {
      if (this.hostPending === rpc) this.hostPending = undefined;
      if (retry && !document.hidden && !this.disposed && this.rpc === rpc && rpc.isOpen) this.hostTimer = setTimeout(() => void this.loadHost(), 10_000);
    }
  }

  // ---- Shell: projects + threads -------------------------------------------------

  private subscribeShell(): void {
    const payload = {
      requestCompletionMarker: true,
      ...(this.shellSequence > 0 ? { afterSequence: this.shellSequence } : {}),
    };
    this.rpc!.stream<ShellStreamItem>(
      "orchestration.subscribeShell",
      payload,
      (items) => this.applyShell(items),
      (err) => {
        // Disconnects are handled by onClose. Anything else (e.g. "live event buffer is full")
        // means the stream died on a live connection: resume from where we were.
        if (err && err.tag !== "Disconnected" && !this.disposed && this.rpc?.isOpen) {
          console.warn(`[${this.summary.label}] shell stream ended`, err);
          setTimeout(() => this.rpc?.isOpen && this.subscribeShell(), 1000);
        }
      },
    );
  }

  private applyShell(items: ShellStreamItem[]): void {
    const transitions: UnitTransition[] = [];
    updateEnv(this.id, (env) => {
      let { projects, threads, synced } = env;
      for (const item of items) {
        switch (item.kind) {
          case "snapshot":
            if (synced && this.summary.kind === "hermes") {
              for (const thread of item.snapshot.threads) {
                const prev = threads[thread.id];
                const from = prev ? unitState(prev) : "idle";
                const to = unitState(thread);
                if (from !== to || !prev) transitions.push({ envId: this.id, thread, from, to });
              }
            }
            projects = Object.fromEntries(item.snapshot.projects.map((p) => [p.id, p]));
            threads = Object.fromEntries(item.snapshot.threads.map((t) => [t.id, t]));
            this.shellSequence = item.snapshot.snapshotSequence;
            break;
          case "synchronized":
            synced = true;
            break;
          case "project-upserted":
            if (item.sequence <= this.shellSequence) break;
            projects = { ...projects, [item.project.id]: item.project };
            this.shellSequence = item.sequence;
            break;
          case "project-removed":
            if (item.sequence <= this.shellSequence) break;
            projects = { ...projects };
            delete projects[item.projectId];
            this.shellSequence = item.sequence;
            break;
          case "thread-upserted": {
            if (item.sequence <= this.shellSequence) break;
            const prev = threads[item.thread.id];
            if (synced) {
              const from = prev ? unitState(prev) : "idle";
              const to = unitState(item.thread);
              if (from !== to || !prev) transitions.push({ envId: this.id, thread: item.thread, from, to });
            }
            threads = { ...threads, [item.thread.id]: item.thread };
            this.shellSequence = item.sequence;
            break;
          }
          case "thread-removed":
            if (item.sequence <= this.shellSequence) break;
            threads = { ...threads };
            delete threads[item.threadId];
            this.shellSequence = item.sequence;
            break;
        }
      }
      return { ...env, projects, threads, synced };
    });
    for (const t of transitions) for (const fn of transitionListeners) fn(t);
  }

  // ---- Thread detail subscriptions -----------------------------------------------

  /** Start following a thread's messages and activity. Returns a function to stop. */
  watchThread(threadId: string): () => void {
    let sub = this.threadSubs.get(threadId);
    if (!sub) {
      sub = { refs: 0, sequence: 0 };
      this.threadSubs.set(threadId, sub);
      if (this.rpc?.isOpen) this.subscribeThread(threadId, sub);
    }
    sub.refs++;
    const s = sub;
    return () => {
      if (--s.refs > 0) return;
      s.cancel?.();
      this.threadSubs.delete(threadId);
      useGame.setState((state) => {
        const details = { ...state.details };
        delete details[unitKey(this.id, threadId)];
        return { details };
      });
    };
  }

  private subscribeThread(threadId: string, sub: ThreadSub): void {
    const key = unitKey(this.id, threadId);
    const payload = {
      threadId,
      reasoningMessages: true,
      requestCompletionMarker: true,
      turnLimit: THREAD_TURN_LIMIT,
      ...(sub.sequence > 0 ? { afterSequence: sub.sequence } : {}),
    };
    sub.cancel = this.rpc!.stream<ThreadStreamItem>(
      "orchestration.subscribeThread",
      payload,
      (items) => {
        useGame.setState((state) => {
          let detail = state.details[key];
          for (const item of items) {
            if (item.kind === "snapshot") {
              detail = { thread: item.snapshot.thread, synced: false };
              sub.sequence = item.snapshot.snapshotSequence;
            } else if (item.kind === "synchronized") {
              if (detail) detail = { ...detail, synced: true };
            } else if (detail && item.event.sequence > sub.sequence) {
              detail = { ...detail, thread: applyThreadEvent(detail.thread, item.event) };
              sub.sequence = item.event.sequence;
            }
          }
          return detail ? { details: { ...state.details, [key]: detail } } : {};
        });
      },
      (err) => {
        if (err && err.tag !== "Disconnected" && this.threadSubs.get(threadId) === sub && this.rpc?.isOpen) {
          console.warn(`[${this.summary.label}] thread stream ended`, err);
          setTimeout(() => this.threadSubs.get(threadId) === sub && this.rpc?.isOpen && this.subscribeThread(threadId, sub), 1000);
        }
      },
    );
  }

  // ---- Commands ------------------------------------------------------------------

  /** Mint a short-lived URL using the same authenticated connection as this thread. */
  async imageUrl(resource: ImageResource): Promise<{ url: string; expiresAt: number }> {
    if (!this.rpc?.isOpen) throw new RpcError("Disconnected", `${this.summary.label} is not connected`);
    const asset = await this.rpc.request<AssetUrl>("assets.createUrl", { resource });
    return { url: assetProxyUrl(this.id, asset.relativeUrl), expiresAt: asset.expiresAt };
  }

  private dispatch(command: Record<string, unknown>): Promise<{ sequence: number }> {
    if (!this.rpc?.isOpen) return Promise.reject(new RpcError("Disconnected", `${this.summary.label} is not connected`));
    return this.rpc.request("orchestration.dispatchCommand", { commandId: uuid(), ...command });
  }

  private thread(threadId: string): ThreadShell {
    const thread = useGame.getState().envs[this.id]?.threads[threadId];
    if (!thread) throw new Error("Unknown thread");
    return thread;
  }

  /** Send a follow-up message to an existing thread, keeping its model and modes. */
  order(threadId: string, text: string): Promise<unknown> {
    const t = this.thread(threadId);
    return this.dispatch({
      type: "thread.turn.start",
      threadId,
      message: { messageId: uuid(), role: "user", text, attachments: [] },
      modelSelection: t.modelSelection,
      runtimeMode: t.runtimeMode,
      interactionMode: t.interactionMode,
      createdAt: new Date().toISOString(),
    });
  }

  /** Read all refs, including worktrees, from this project's host (never the Command host). */
  async projectRefs(projectId: string): Promise<ProjectRefs> {
    const project = useGame.getState().envs[this.id]?.projects[projectId];
    if (!project) throw new Error("Unknown project");
    if (!this.rpc?.isOpen) throw new RpcError("Disconnected", `${this.summary.label} is not connected`);
    const refs: ProjectRefs["refs"] = [];
    let cursor: number | null = 0;
    let isRepo = false;
    do {
      const page: ProjectRefs & { nextCursor: number | null } = await this.rpc.request("vcs.listRefs", {
        cwd: project.workspaceRoot, cursor, limit: 100, includeMatchingRemoteRefs: true, refresh: cursor === 0,
      });
      refs.push(...page.refs);
      isRepo = page.isRepo;
      cursor = page.nextCursor;
    } while (cursor !== null);
    return { refs, isRepo };
  }

  /** Create a new thread and use T3's native bootstrap for worktree setup. */
  async recruit(opts: {
    projectId: string;
    text: string;
    modelSelection: ModelSelection;
    runtimeMode: RuntimeMode;
    interactionMode?: InteractionMode;
    workspace?: RecruitWorkspace;
    hermesProfile?: string;
  }): Promise<string> {
    const env = useGame.getState().envs[this.id];
    const project = env?.projects[opts.projectId];
    let branch: string | null = null;
    let worktreePath: string | null = null;
    let prepareWorktree: Record<string, unknown> | undefined;
    const workspace = opts.workspace;
    if (workspace) {
      if (!project) throw new Error("Unknown project");
      if (this.summary.kind === "hermes") {
        if (workspace.mode !== "local" || workspace.branch) throw new Error("Hermes supports only its configured workspace checkout");
      } else {
        const { refs, isRepo } = await this.projectRefs(opts.projectId);
        if (workspace.mode === "worktree") {
          branch = workspace.branch ?? defaultBranch(refs) ?? null;
          if (!isRepo || !branch || !refs.some((r) => r.name === branch)) throw new Error("Select an available Git base branch for the new worktree");
          prepareWorktree = { projectCwd: project.workspaceRoot, baseBranch: branch,
            branch: `t3code-${uuid().slice(0, 8)}`, requireWorktree: true, startFromOrigin: workspace.startFromOrigin ?? true };
        } else if (workspace.mode === "latest" || workspace.mode === "existing") {
          const latest = workspace.mode === "latest" ? latestWorktree(Object.values(env.threads), opts.projectId, project.workspaceRoot) : undefined;
          const path = workspace.mode === "existing" ? workspace.path : latest?.worktreePath;
          const ref = refs.find((r) => !r.isRemote && r.worktreePath === path && path !== project.workspaceRoot);
          if (!ref) throw new Error("The selected worktree is no longer available. Refresh the workspace choices.");
          branch = ref.name;
          worktreePath = ref.worktreePath;
        } else {
          const current = refs.find((r) => r.current);
          const selected = workspace.branch ? refs.find((r) => r.name === workspace.branch && !r.isRemote) : current;
          if (workspace.branch && !selected) throw new Error("The selected checkout branch is no longer available");
          if (selected?.worktreePath && selected.worktreePath !== project.workspaceRoot) throw new Error("That branch is checked out in another worktree. Choose that worktree instead.");
          if (selected && !selected.current) {
            const switched = await this.rpc!.request<{ refName: string | null }>("vcs.switchRef", { cwd: project.workspaceRoot, refName: selected.name });
            branch = switched.refName;
          } else branch = selected?.name ?? null;
        }
      }
    }
    const threadId = uuid();
    const createdAt = new Date().toISOString();
    const interactionMode = opts.interactionMode ?? "default";
    const firstLine = opts.text.trim().split("\n")[0];
    const title = firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
    await this.dispatch({
      type: "thread.turn.start",
      threadId,
      message: { messageId: uuid(), role: "user", text: opts.text, attachments: [] },
      modelSelection: opts.modelSelection,
      titleSeed: opts.text,
      runtimeMode: opts.runtimeMode,
      interactionMode,
      bootstrap: {
        createThread: {
          projectId: opts.projectId,
          ...(this.summary.kind === "hermes" ? { hermesProfile: opts.hermesProfile ?? "default" } : {}),
          title,
          modelSelection: opts.modelSelection,
          runtimeMode: opts.runtimeMode,
          interactionMode,
          branch,
          worktreePath,
          createdAt,
        },
        ...(prepareWorktree ? { prepareWorktree, runSetupScript: true } : {}),
      },
      createdAt,
    });
    return threadId;
  }

  interrupt(threadId: string): Promise<unknown> {
    const t = this.thread(threadId);
    const turnId = t.latestTurn?.state === "running" ? t.latestTurn.turnId : undefined;
    return this.dispatch({
      type: "thread.turn.interrupt",
      threadId,
      ...(turnId ? { turnId } : {}),
      createdAt: new Date().toISOString(),
    });
  }

  respondToApproval(threadId: string, requestId: string, decision: ApprovalDecision): Promise<unknown> {
    return this.dispatch({ type: "thread.approval.respond", threadId, requestId, decision, createdAt: new Date().toISOString() });
  }

  respondToQuestion(threadId: string, requestId: string, answers: QuestionAnswers): Promise<unknown> {
    return this.dispatch({ type: "thread.user-input.respond", threadId, requestId, answers, createdAt: new Date().toISOString() });
  }

  dismissQuestion(threadId: string, requestId: string): Promise<unknown> {
    return this.dispatch({ type: "thread.user-input.dismiss", threadId, requestId, createdAt: new Date().toISOString() });
  }

  /** Send a unit to camp (mark the thread settled). */
  settle(threadId: string): Promise<unknown> {
    return this.dispatch({ type: "thread.settle", threadId });
  }

  /** Wake a unit back up (unsettle the thread). */
  unsettle(threadId: string): Promise<unknown> {
    return this.dispatch({ type: "thread.unsettle", threadId, reason: "user" });
  }
}

// ---- Hub: one client per environment registered with the t3-command server ----------

const clients = new Map<string, EnvironmentClient>();

export function envClient(envId: string): EnvironmentClient | undefined {
  return clients.get(envId);
}

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/** Reconcile live connections with the server's environment list. */
export async function refreshEnvironments(): Promise<void> {
  const summaries = await fetchJson<EnvSummary[]>("/api/envs");
  const seen = new Set<string>();
  for (const summary of summaries) {
    seen.add(summary.id);
    const existing = clients.get(summary.id);
    const world = useGame.getState().envs[summary.id];
    // Re-create a client that was blocked (e.g. needs pairing) once the server says it's fine.
    const blocked = world && (world.connection === "needs-pairing" || world.connection === "needs-update");
    if (existing && !(blocked && summary.status === "ok")) {
      updateEnv(summary.id, (e) => JSON.stringify(e.summary) === JSON.stringify(summary) ? e : { ...e, summary });
      continue;
    }
    existing?.dispose();
    const client = new EnvironmentClient(summary);
    clients.set(summary.id, client);
    client.start();
  }
  for (const [id, client] of clients) {
    if (seen.has(id)) continue;
    client.dispose();
    clients.delete(id);
  }
}

export function logError(context: string, err: unknown): void {
  addLog({ tone: "bad", text: `${context}: ${err instanceof Error ? err.message : String(err)}` });
}
