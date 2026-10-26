// One live connection to one T3 environment, relayed through the t3-command server.
// Keeps that environment's slice of the game store up to date and sends commands to it.

import { DEMO, demoFetch } from "../demo";
import type { EnvSummary } from "../../shared/api";
import { addLog, unitKey, updateEnv, useGame, type Connection, type EnvWorld } from "../store";
import { withPrStates } from "../../shared/pr-states";
import { isNativeSubagent, unitState, type UnitState } from "./derive";
import { withNativeSubagents } from "./subagents";
import { protocolStreamPayload, v2NativeSubagents, v2ThreadStream } from "../../shared/t3-protocol";
import type { BoundedThreadSnapshot, ThreadHistoryPage } from "../../shared/thread-history";
import { applyThreadEvent } from "./reducer";
import { RpcConnection, RpcError } from "./rpc";
import { assetProxyUrl } from "./assets";
import type { QuestionAnswers } from "./questions";
import { supportedUsage, historyWindow, type UsageSummary } from "./usage";
import type { HostResources } from "./host";
import { defaultBranch, latestWorktree, type ProjectRefs, type RecruitWorkspace } from "./workspace";
import { SCRATCH_ROOT, SCRATCH_TITLE } from "./scratch";
import type {
  NativeSubagent,
  AssetUrl,
  ImageResource,
  ApprovalDecision,
  FolderListing,
  InteractionMode,
  ModelSelection,
  ProjectClone,
  PullRequestDetail,
  Provider,
  RuntimeMode,
  ServerConfig,
  ServerConfigEvent,
  ShellStreamItem,
  ThreadShell,
  ThreadStreamItem,
  VcsLocalStatus,
  VcsRemoteStatus,
  VcsStatusEvent,
} from "./types";
import { t3Defaults } from "./model-defaults";
import { enrichProjectRepositories } from "../../shared/t3-protocol";

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
  emit?: (values: unknown[]) => void;
  historyAbort?: AbortController;
}
interface NativeParentSub {
  agents: NativeSubagent[];
  cancel?: () => void;
}

export class EnvironmentClient {
  readonly id: string;
  private summary: EnvSummary;
  private rpc?: RpcConnection;
  private shellSequence = 0;
  private threadSubs = new Map<string, ThreadSub>();
  private nativeParents = new Map<string, NativeParentSub>();
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
    for (const sub of this.nativeParents.values()) sub.cancel?.();
    for (const sub of this.threadSubs.values()) { sub.cancel?.(); sub.historyAbort?.abort(); }
    this.threadSubs.clear();
    this.nativeParents.clear();
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
    }, this.summary.kind === "hermes" ? 1 : this.summary.protocolVersion ?? 1);
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
    for (const [threadId, sub] of this.nativeParents) this.subscribeNativeParent(threadId, sub);
  }

  private onClose(code: number, reason: string): void {
    clearTimeout(this.usageTimer);
    clearTimeout(this.hostTimer);
    useGame.setState((s) => s.hosts[this.id] ? { hosts: { ...s.hosts,
      [this.id]: { ...s.hosts[this.id], error: "Host connection lost." } } } : {});
    for (const sub of this.threadSubs.values()) { sub.cancel?.(); sub.cancel = undefined; sub.emit = undefined; sub.historyAbort?.abort(); }
    for (const sub of this.nativeParents.values()) { sub.cancel?.(); sub.cancel = undefined; }
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

  /**
   * Follow provider status (health notes, rate limits) live. Servers without the config stream,
   * such as the Hermes bridge, get a one-time server.getConfig instead.
   */
  private loadConfig(): void {
    const rpc = this.rpc!;
    rpc.stream<ServerConfigEvent>("subscribeServerConfig", {}, (events) => {
      for (const event of events) {
        const providers = event.type === "snapshot" && "config" in event ? event.config.providers
          : event.type === "providerStatuses" && "payload" in event ? event.payload.providers : undefined;
        if (providers) updateEnv(this.id, (e) => ({ ...e, providers }));
        const settings = event.type === "snapshot" && "config" in event ? event.config.settings
          : event.type === "settingsUpdated" && "payload" in event ? event.payload.settings : undefined;
        if (settings) updateEnv(this.id, (e) => ({ ...e, t3Defaults: t3Defaults(settings) }));
      }
    }, (err) => {
      if (!err || err.tag === "Disconnected" || this.disposed || this.rpc !== rpc || !rpc.isOpen) return;
      if (/Unknown request tag/.test(err.message)) { void this.fetchConfig(); return; }
      console.warn(`[${this.summary.label}] config stream ended`, err);
      setTimeout(() => this.rpc === rpc && rpc.isOpen && this.loadConfig(), 1000);
    });
  }

  private async fetchConfig(): Promise<void> {
    try {
      const config = await this.rpc!.request<ServerConfig>("server.getConfig");
      updateEnv(this.id, (e) => ({ ...e, providers: config.providers, ...(config.settings ? { t3Defaults: t3Defaults(config.settings) } : {}) }));
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
            threads = Object.fromEntries(item.snapshot.threads.map((t) => [t.id, withPrStates(t, useGame.getState().prStates)]));
            this.shellSequence = item.snapshot.snapshotSequence;
            break;
          case "synchronized":
            synced = true;
            break;
          case "project-enrichment":
            projects = enrichProjectRepositories(projects, item.projects, item.resolvedRoots);
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
            const thread = withNativeSubagents({ [item.thread.id]: item.thread }, this.nativeAgents())[item.thread.id];
            const prev = threads[item.thread.id];
            if (synced) {
              const from = prev ? unitState(prev) : "idle";
              const to = unitState(thread);
              if (from !== to || !prev) transitions.push({ envId: this.id, thread, from, to });
            }
            threads = { ...threads, [thread.id]: withPrStates(thread, useGame.getState().prStates) };
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
      threads = withNativeSubagents(threads, this.nativeAgents().filter((agent) => !!threads[agent.parentThreadId]));
      return { ...env, projects, threads, synced };
    });
    for (const t of transitions) for (const fn of transitionListeners) fn(t);
    this.followNativeParents();
  }

  private nativeAgents() {
    return [...this.nativeParents.values()].flatMap((sub) => sub.agents);
  }

  /** Native child shells carry no lifecycle. Follow each owning parent once, even with no panel open. */
  private followNativeParents(): void {
    if (this.summary.protocolVersion !== 2 || !this.rpc?.isOpen) return;
    const threads = useGame.getState().envs[this.id]?.threads ?? {};
    const parents = new Set(Object.values(threads).filter(isNativeSubagent).map((t) => t.lineage?.parentThreadId).filter((id): id is string => !!id && !!threads[id]));
    for (const [id, sub] of this.nativeParents) {
      if (parents.has(id)) continue;
      this.nativeParents.delete(id);
      sub.cancel?.();
    }
    for (const id of parents) {
      if (this.nativeParents.has(id)) continue;
      const sub: NativeParentSub = { agents: [] };
      this.nativeParents.set(id, sub);
      this.subscribeNativeParent(id, sub);
    }
    this.refreshNativeChildren();
  }

  /** Bootstrap lifecycle state over HTTP, then follow only subagent events on the relay. */
  private subscribeNativeParent(threadId: string, sub: NativeParentSub): void {
    sub.cancel?.();
    const rpc = this.rpc;
    if (!rpc?.isOpen) return;
    const controller = new AbortController();
    let sequence = -1;
    let cancel: (() => void) | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    sub.cancel = () => { controller.abort(); cancel?.(); clearTimeout(retry); };
    const current = () => !controller.signal.aborted && !this.disposed && this.rpc === rpc && rpc.isOpen && this.nativeParents.get(threadId) === sub;
    const again = () => { if (current()) retry = setTimeout(() => this.subscribeNativeParent(threadId, sub), 5_000); };
    const apply = (values: unknown[]) => {
      if (!current()) return;
      for (const value of values) {
        const item = value as { kind: string; sequence?: number; snapshotSequence?: number; projection?: { subagents?: unknown }; event?: { type: string; payload: unknown } };
        if (item.kind === "snapshot" && Number(item.snapshotSequence) >= sequence) {
          sequence = Number(item.snapshotSequence);
          sub.agents = v2NativeSubagents(item.projection?.subagents, threadId);
        }
        else if (item.kind === "event" && Number(item.sequence) > sequence && item.event?.type === "subagent.updated") {
          sequence = Number(item.sequence);
          const next = v2NativeSubagents([item.event.payload], threadId)[0];
          if (next) sub.agents = [...sub.agents.filter((a) => a.id !== next.id), next];
        }
      }
      this.refreshNativeChildren();
    };
    void fetchJson<BoundedThreadSnapshot>(this.threadPath(threadId, "subagents"), { signal: controller.signal }).then((snapshot) => {
      if (!current()) return;
      apply([{ kind: "snapshot", ...snapshot }]);
      cancel = rpc.rawStream("orchestration.subscribeThread", protocolStreamPayload(2, "orchestration.subscribeThread", {
        threadId, afterSequence: snapshot.snapshotSequence, requestCompletionMarker: true, commandSubagentsOnly: true,
      }), apply, again);
    }).catch(again);
  }

  private threadPath(threadId: string, kind: string): string {
    return `/env/${encodeURIComponent(this.id)}/threads/${encodeURIComponent(threadId)}/${kind}`;
  }

  private refreshNativeChildren(): void {
    const transitions: UnitTransition[] = [];
    updateEnv(this.id, (env) => {
      const threads = withNativeSubagents(env.threads, this.nativeAgents());
      if (threads === env.threads) return env;
      if (env.synced) for (const thread of Object.values(threads)) {
        const from = unitState(env.threads[thread.id]);
        const to = unitState(thread);
        if (from !== to) transitions.push({ envId: this.id, thread, from, to });
      }
      return { ...env, threads };
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
      s.historyAbort?.abort();
      this.threadSubs.delete(threadId);
      useGame.setState((state) => {
        const details = { ...state.details };
        delete details[unitKey(this.id, threadId)];
        return { details };
      });
    };
  }

  private applyThreadItems(threadId: string, sub: ThreadSub, items: ThreadStreamItem[]): void {
    const key = unitKey(this.id, threadId);
    useGame.setState((state) => {
      let detail = state.details[key];
      for (const item of items) {
        if (item.kind === "snapshot") {
          detail = { thread: item.snapshot.thread, synced: false,
            ...(item.snapshot.history ? { history: { ...item.snapshot.history,
              loading: detail?.history?.cursor === item.snapshot.history.cursor ? detail.history.loading : false,
              error: detail?.history?.cursor === item.snapshot.history.cursor ? detail.history.error : undefined,
            } } : {}) };
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
  }

  private subscribeThread(threadId: string, sub: ThreadSub): void {
    sub.cancel?.();
    sub.historyAbort?.abort();
    const rpc = this.rpc;
    if (!rpc?.isOpen) return;
    const controller = new AbortController();
    let cancel: (() => void) | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    sub.emit = undefined;
    sub.cancel = () => { controller.abort(); cancel?.(); clearTimeout(retry); };
    const current = () => !controller.signal.aborted && !this.disposed && this.rpc === rpc && rpc.isOpen && this.threadSubs.get(threadId) === sub;
    const ended = (err?: RpcError) => {
      if (current() && err?.tag !== "Disconnected") retry = setTimeout(() => this.subscribeThread(threadId, sub), 5_000);
    };
    if (this.summary.protocolVersion !== 2) {
      cancel = rpc.stream<ThreadStreamItem>("orchestration.subscribeThread", {
        threadId, reasoningMessages: true, requestCompletionMarker: true, turnLimit: THREAD_TURN_LIMIT,
        ...(sub.sequence > 0 ? { afterSequence: sub.sequence } : {}),
      }, (items) => { if (current()) this.applyThreadItems(threadId, sub, items); }, ended);
      return;
    }
    const key = unitKey(this.id, threadId);
    const shell = useGame.getState().envs[this.id]?.threads[threadId];
    if (shell) useGame.setState((state) => ({ details: { ...state.details, [key]: {
      thread: state.details[key]?.thread ?? { ...shell, messages: [], activities: [], checkpoints: [] }, synced: false,
    } } }));
    void fetchJson<BoundedThreadSnapshot>(this.threadPath(threadId, "bounded"), { signal: controller.signal }).then((snapshot) => {
      if (!current()) return;
      const decode = v2ThreadStream();
      sub.emit = (values) => { if (current()) this.applyThreadItems(threadId, sub, decode(values)); };
      sub.emit([{ kind: "snapshot", ...snapshot }]);
      cancel = rpc.rawStream("orchestration.subscribeThread", protocolStreamPayload(2, "orchestration.subscribeThread", {
        threadId, afterSequence: snapshot.snapshotSequence, requestCompletionMarker: true,
      }), sub.emit, ended);
    }).catch((err) => {
      if (!current()) return;
      useGame.setState((state) => {
        const detail = state.details[key];
        return detail ? { details: { ...state.details, [key]: { ...detail, error: (err as Error).message } } } : {};
      });
      // An explicit retry keeps unsupported/oversized snapshots from becoming a download loop.
    });
  }

  retryThread(threadId: string): void {
    const sub = this.threadSubs.get(threadId);
    if (sub) this.subscribeThread(threadId, sub);
  }

  async loadOlderHistory(threadId: string): Promise<void> {
    const sub = this.threadSubs.get(threadId);
    const key = unitKey(this.id, threadId);
    const history = useGame.getState().details[key]?.history;
    if (!sub?.emit || !history?.hasMore || !history.cursor || history.loading) return;
    const cursor = history.cursor;
    const emit = sub.emit;
    const controller = new AbortController();
    sub.historyAbort?.abort();
    sub.historyAbort = controller;
    const update = (changes: { loading: boolean; error?: string }) => useGame.setState((state) => {
      const detail = state.details[key];
      return detail?.history?.cursor === cursor && this.threadSubs.get(threadId) === sub && sub.emit === emit
        ? { details: { ...state.details, [key]: { ...detail, history: { ...detail.history, ...changes } } } } : {};
    });
    update({ loading: true });
    try {
      const page = await fetchJson<ThreadHistoryPage>(`${this.threadPath(threadId, "history")}?cursor=${encodeURIComponent(cursor)}`, { signal: controller.signal });
      if (controller.signal.aborted || this.threadSubs.get(threadId) !== sub || sub.emit !== emit || useGame.getState().details[key]?.history?.cursor !== cursor) return;
      emit([{ kind: "history-page", ...page }]);
      useGame.setState((state) => {
        const detail = state.details[key];
        return detail?.history ? { details: { ...state.details, [key]: { ...detail, history: { ...detail.history, loading: false } } } } : {};
      });
    } catch (err) { if (!controller.signal.aborted) update({ loading: false, error: (err as Error).message }); }
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

  /**
   * Make sure this machine has T3's "No project" scratch project (idempotent). T3 servers without
   * projects.ensureScratch get the same project created directly; they won't give threads their
   * own folders inside it.
   */
  async ensureScratch(): Promise<string> {
    if (!this.rpc?.isOpen) throw new RpcError("Disconnected", `${this.summary.label} is not connected`);
    try {
      return (await this.rpc.request<{ projectId: string }>("projects.ensureScratch", {})).projectId;
    } catch (err) {
      if (!(err instanceof Error) || !/Unknown request tag/.test(err.message)) throw err;
      const projectId = uuid();
      await this.dispatch({ type: "project.create", projectId, title: SCRATCH_TITLE, workspaceRoot: SCRATCH_ROOT,
        createWorkspaceRootIfMissing: true, defaultModelSelection: null, createdAt: new Date().toISOString() });
      return projectId;
    }
  }

  /**
   * Folders on this machine matching a typed path (filesystem.browse): a path ending in "/" lists
   * that folder, otherwise its siblings starting with the last segment. `~` is this machine's home.
   */
  async browseFolders(partialPath: string): Promise<FolderListing> {
    if (!this.rpc?.isOpen) throw new RpcError("Disconnected", `${this.summary.label} is not connected`);
    return this.rpc.request<FolderListing>("filesystem.browse", { partialPath }, 15_000);
  }

  /**
   * Add a folder on this machine as a T3 project. With `createIfMissing` T3 makes the folder, and
   * `initGit` then makes it a repository so crew can work in worktrees. T3 refuses a second project
   * on the same folder.
   */
  async addProject(opts: { title: string; workspaceRoot: string; createIfMissing?: boolean; initGit?: boolean }): Promise<string> {
    const projectId = uuid();
    await this.dispatch({ type: "project.create", projectId, title: opts.title, workspaceRoot: opts.workspaceRoot,
      createWorkspaceRootIfMissing: opts.createIfMissing === true, defaultModelSelection: null, createdAt: new Date().toISOString() });
    if (opts.initGit) {
      const root = await this.projectRoot(projectId);
      await this.rpc!.request("vcs.init", { cwd: root, kind: "git" }, 30_000);
    }
    return projectId;
  }

  /**
   * Remove a project from T3 on this machine; its folder stays on disk. T3 refuses while the project
   * has threads unless `withThreads`, which deletes those threads (and their conversations) too.
   */
  retireProject(projectId: string, withThreads: boolean): Promise<unknown> {
    return this.dispatch({ type: "project.delete", projectId, ...(withThreads ? { force: true } : {}) });
  }

  /** The project's folder as T3 normalised it, once its shell event has arrived. */
  private projectRoot(projectId: string): Promise<string> {
    const now = () => useGame.getState().envs[this.id]?.projects[projectId]?.workspaceRoot;
    return new Promise((resolve, reject) => {
      const found = now();
      if (found) return resolve(found);
      const timer = setTimeout(() => { unsubscribe(); reject(new Error("The new project didn't appear on this machine")); }, 15_000);
      const unsubscribe = useGame.subscribe(() => {
        const root = now();
        if (root) { clearTimeout(timer); unsubscribe(); resolve(root); }
      });
    });
  }

  /**
   * Clone a repository into `destinationPath` (which must not exist, or be empty) as a new project.
   * T3 adds the project straight away and clones in the background; follow it with watchClones.
   */
  async cloneProject(opts: { title: string; remoteUrl: string; destinationPath: string }): Promise<string> {
    if (!this.rpc?.isOpen) throw new RpcError("Disconnected", `${this.summary.label} is not connected`);
    const projectId = uuid();
    try {
      await this.rpc.request("projectClone.start", { projectId, title: opts.title, remoteUrl: opts.remoteUrl,
        destinationPath: opts.destinationPath, createdAt: new Date().toISOString() }, 60_000);
    } catch (err) {
      if (err instanceof Error && /Unknown request tag/.test(err.message)) throw new Error(`T3 on ${this.summary.label} can't clone repositories; update it, or clone there and add the folder`);
      throw err;
    }
    return projectId;
  }

  /** Every tracked clone on this machine, now and after each change; returns a function to stop. */
  watchClones(onList: (clones: ProjectClone[]) => void, onError: (message: string) => void): () => void {
    const rpc = this.rpc;
    if (!rpc?.isOpen) { onError(`${this.summary.label} is not connected`); return () => {}; }
    let stopped = false;
    const cancel = rpc.stream<ProjectClone[]>("subscribeProjectClones", {}, (lists) => { if (!stopped && lists.length) onList(lists[lists.length - 1]); }, (err) => {
      if (err && err.tag !== "Disconnected" && !stopped) onError(err.message);
    });
    return () => { stopped = true; cancel(); };
  }

  cancelClone(projectId: string): Promise<unknown> {
    if (!this.rpc?.isOpen) return Promise.reject(new RpcError("Disconnected", `${this.summary.label} is not connected`));
    return this.rpc.request("projectClone.cancel", { projectId });
  }

  retryClone(projectId: string): Promise<unknown> {
    if (!this.rpc?.isOpen) return Promise.reject(new RpcError("Disconnected", `${this.summary.label} is not connected`));
    return this.rpc.request("projectClone.retry", { projectId });
  }

  /** Send a follow-up message to an existing thread, keeping its model and modes (unless overridden). */
  order(threadId: string, text: string, modes: { interactionMode?: InteractionMode } = {}): Promise<unknown> {
    const t = this.thread(threadId);
    return this.dispatch({
      type: "thread.turn.start",
      threadId,
      message: { messageId: uuid(), role: "user", text, attachments: [] },
      modelSelection: t.modelSelection,
      runtimeMode: t.runtimeMode,
      interactionMode: modes.interactionMode ?? t.interactionMode,
      createdAt: new Date().toISOString(),
    });
  }

  /** Plan mode (the agent proposes before it acts) or default. */
  setInteractionMode(threadId: string, interactionMode: InteractionMode): Promise<unknown> {
    return this.dispatch({ type: "thread.interaction-mode.set", threadId, interactionMode, createdAt: new Date().toISOString() });
  }

  setRuntimeMode(threadId: string, runtimeMode: RuntimeMode): Promise<unknown> {
    return this.dispatch({ type: "thread.runtime-mode.set", threadId, runtimeMode, createdAt: new Date().toISOString() });
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

  /** One usage summary for any calendar window; the History panel asks for longer ranges on open. */
  async usageFor(window: { sinceDay: string; untilDay: string; timeZone: string }): Promise<UsageSummary> {
    if (!this.rpc?.isOpen) throw new RpcError("Disconnected", `${this.summary.label} is not connected`);
    const summary = await this.rpc.request<UsageSummary>("server.getUsageSummary", window, 90_000);
    if (!supportedUsage(summary)) throw new Error(`Unsupported usage contract v${summary.contractVersion}`);
    return summary;
  }

  /** Unified diff of everything the thread changed, up to turn `toTurnCount`. */
  async fullThreadDiff(threadId: string, toTurnCount: number): Promise<string> {
    if (!this.rpc?.isOpen) throw new RpcError("Disconnected", `${this.summary.label} is not connected`);
    const result = await this.rpc.request<{ diff: string }>("orchestration.getFullThreadDiff", { threadId, toTurnCount }, 60_000);
    return result.diff;
  }

  /** A pull request's detail as T3 reads it from the host: checks, mergeability, reviewers. */
  async pullRequestDetail(projectId: string, repository: string, number: number, host?: string): Promise<PullRequestDetail> {
    if (!this.rpc?.isOpen) throw new RpcError("Disconnected", `${this.summary.label} is not connected`);
    return this.rpc.request<PullRequestDetail>("pullRequests.detail", { projectId, repository, number, ...(host ? { host } : {}), allowStale: true }, 30_000);
  }

  /** Unified diff of what turns (from, to] changed in the agent's workspace. */
  async turnDiff(threadId: string, fromTurnCount: number, toTurnCount: number): Promise<string> {
    if (!this.rpc?.isOpen) throw new RpcError("Disconnected", `${this.summary.label} is not connected`);
    const result = await this.rpc.request<{ diff: string }>("orchestration.getTurnDiff", { threadId, fromTurnCount, toTurnCount }, 30_000);
    return result.diff;
  }

  /** A directory inside a workspace (projects.listEntries); git-ignored entries are included. */
  async listWorkspaceDir(cwd: string, directoryPath: string): Promise<Array<{ path: string; kind: string }>> {
    if (!this.rpc?.isOpen) throw new RpcError("Disconnected", `${this.summary.label} is not connected`);
    return (await this.rpc.request<{ entries: Array<{ path: string; kind: string }> }>("projects.listEntries", { cwd, directoryPath }, 15_000)).entries;
  }

  /** A file inside a workspace (projects.readFile): at most 1 MB, `truncated` past that. */
  async readWorkspaceFile(cwd: string, relativePath: string): Promise<{ contents: string; truncated: boolean }> {
    if (!this.rpc?.isOpen) throw new RpcError("Disconnected", `${this.summary.label} is not connected`);
    return this.rpc.request<{ contents: string; truncated: boolean }>("projects.readFile", { cwd, relativePath }, 15_000);
  }

  /**
   * Restore the agent's files and conversation to just after turn `turnCount`, dropping later
   * turns. Destructive: callers confirm first.
   */
  rollBackToTurn(threadId: string, turnCount: number): Promise<unknown> {
    return this.dispatch({ type: "thread.checkpoint.revert", threadId, turnCount, createdAt: new Date().toISOString() });
  }

  /**
   * Have T3 install the latest release of a provider's CLI on this machine. Resolves once the
   * install finishes; progress also arrives live through the provider status stream.
   */
  async updateProvider(driver: string, instanceId: string): Promise<void> {
    if (!this.rpc?.isOpen) throw new RpcError("Disconnected", `${this.summary.label} is not connected`);
    const result = await this.rpc.request<{ providers: Provider[] }>("server.updateProvider", { provider: driver, instanceId }, 15 * 60_000);
    if (result?.providers) updateEnv(this.id, (e) => ({ ...e, providers: result.providers }));
  }

  /**
   * Have this machine's T3 update itself to an exact release. T3 downloads and installs it, then
   * restarts into it (its background service or the server itself) or, for the desktop app,
   * prepares the update and relaunches once committed. The connection drops as it restarts and
   * reconnects to the new version. Running turns carry on when T3 supports it and we ask.
   */
  async updateT3(targetVersion: string, continueRunningThreads: boolean): Promise<{ method: string; targetVersion: string }> {
    if (!this.rpc?.isOpen) throw new RpcError("Disconnected", `${this.summary.label} is not connected`);
    const input = { targetVersion, ...(continueRunningThreads ? { continueRunningThreads: true } : {}) };
    const result = await this.rpc.request<{ targetVersion: string; method: string; desktopUpdateToken?: string }>("server.updateServer", input, 20 * 60_000);
    // The desktop app prepares the update and waits to be told to relaunch into it.
    if (result.method === "desktop-app" && result.desktopUpdateToken) {
      await this.rpc.request("server.commitDesktopUpdate", { requestId: result.desktopUpdateToken }, 60_000).catch((err: unknown) => {
        // It relaunches as it acknowledges, so a dropped connection here means it's on its way.
        if (!(err instanceof RpcError && err.tag === "Disconnected")) throw err;
      });
    }
    return { method: result.method, targetVersion: result.targetVersion };
  }

  /**
   * Follow a workspace's git state; returns a function to stop. T3 serves its cached status to
   * new subscribers, so ask it to recompute once and treat that result as the first snapshot.
   */
  watchVcs(cwd: string, onEvent: (event: VcsStatusEvent) => void, onError: (message: string) => void): () => void {
    const rpc = this.rpc;
    if (!rpc?.isOpen) { onError(`${this.summary.label} is not connected`); return () => {}; }
    let stopped = false;
    void rpc.request<VcsLocalStatus & VcsRemoteStatus>("vcs.refreshStatus", { cwd }, 30_000).then((status) => {
      if (stopped) return;
      const { hasUpstream, aheadCount, behindCount, pr, ...local } = status;
      onEvent({ _tag: "snapshot", local, remote: { hasUpstream, aheadCount, behindCount, pr } });
    }).catch(() => { /* The stream's own snapshot still arrives. */ });
    const cancel = rpc.stream<VcsStatusEvent>("subscribeVcsStatus", { cwd }, (events) => { if (!stopped) events.forEach(onEvent); }, (err) => {
      if (err && err.tag !== "Disconnected" && !stopped) onError(err.message);
    });
    return () => { stopped = true; cancel(); };
  }

  interrupt(threadId: string): Promise<unknown> {
    const t = this.thread(threadId);
    if (isNativeSubagent(t)) {
      const agent = t.nativeSubagent;
      if (!agent?.runId) return Promise.reject(new Error("The parent has not reported an interruptible subagent run"));
      return this.dispatch({ type: "subagent.stop", threadId: agent.parentThreadId, runId: agent.runId, subagentId: agent.id });
    }
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
  if (DEMO) {
    const answer = demoFetch(path);
    if (answer === undefined) throw new Error("Not available in the demo fleet");
    return answer as T;
  }
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
    const protocolChanged = world && (world.summary.protocolVersion ?? 1) !== (summary.protocolVersion ?? 1);
    const authorizationChanged = world && (world.summary.tokenExpiresAt !== summary.tokenExpiresAt || world.summary.permissionNotice !== summary.permissionNotice);
    if (existing && !protocolChanged && !authorizationChanged && !(blocked && summary.status === "ok")) {
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
