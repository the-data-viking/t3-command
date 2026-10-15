// Agent widgets (see shared/widgets.ts and docs/WIDGETS.md). Command looks for them in each live
// thread's workspace through T3's file RPCs, re-reads the open ones while they're on screen, and
// runs each page in a sandboxed frame. Pins come from the Command server.

import { useSyncExternalStore } from "react";
import { WIDGET_DIR, widgetIds, type WidgetPin } from "../../shared/widgets";
import { DEMO } from "../demo";
import { addLog, useGame, type EnvWorld } from "../store";
import { isHistory } from "./derive";
import { envClient, fetchJson } from "./environment";
import { RpcError } from "./rpc";
import type { ThreadShell } from "./types";

/** How often workspaces are searched for new widgets, and widgets re-read while on screen. */
export const DISCOVER_MS = 30_000;
export const DATA_MS = 5_000;
export const PAGE_MS = 30_000;
/** Data older than this (unless the page says otherwise) is flagged stale. */
export const DEFAULT_STALE_SECONDS = 600;
export const DEFAULT_SIZE = { w: 380, h: 240 };

export const workspaceKey = (envId: string, cwd: string): string => `${envId}\n${cwd}`;

/** Where a thread's agent works: its worktree, or else its project's folder. */
export function threadCwd(env: EnvWorld, thread: ThreadShell): string | undefined {
  return thread.worktreePath ?? env.projects[thread.projectId]?.workspaceRoot ?? undefined;
}

/** Workspaces of live threads on connected T3 machines (Hermes has no workspace files). */
export function widgetWorkspaces(envs: Record<string, EnvWorld>): Array<{ envId: string; cwd: string }> {
  const out = new Map<string, { envId: string; cwd: string }>();
  for (const env of Object.values(envs)) {
    if (env.summary.kind === "hermes" || env.connection !== "live") continue;
    for (const thread of Object.values(env.threads)) {
      if (thread.archivedAt || isHistory(thread)) continue;
      const cwd = threadCwd(env, thread);
      if (cwd) out.set(workspaceKey(env.summary.id, cwd), { envId: env.summary.id, cwd });
    }
  }
  return [...out.values()];
}

/** The live threads working in a workspace, most recently active first. */
export function workspaceThreads(env: EnvWorld | undefined, cwd: string): ThreadShell[] {
  if (!env) return [];
  return Object.values(env.threads)
    .filter((t) => !t.archivedAt && !isHistory(t) && threadCwd(env, t) === cwd)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** T3 answered that the folder or file isn't there (as opposed to the link failing). */
const absent = (err: unknown) => err instanceof RpcError && (err.tag.startsWith("Project") || err.tag === "Defect");

/** Workspaces listed at least once: widgets that turn up in them later are announced. */
const listed = new Set<string>();

async function listWidgets(envId: string, cwd: string): Promise<string[] | undefined> {
  const client = envClient(envId);
  if (!client) return undefined;
  try { return widgetIds(await client.listWorkspaceDir(cwd, WIDGET_DIR)); }
  catch (err) { return absent(err) ? [] : undefined; }
}

function record(envId: string, cwd: string, ids: string[]): void {
  const key = workspaceKey(envId, cwd);
  const before = useGame.getState().widgets[key] ?? [];
  if (listed.has(key)) {
    const thread = workspaceThreads(useGame.getState().envs[envId], cwd)[0];
    for (const id of ids.filter((i) => !before.includes(i))) {
      addLog({ tone: "info", text: `${thread?.title || "A crew member"} put up a widget: ${id}`, envId, threadId: thread?.id });
    }
  }
  listed.add(key);
  if (before.join("\n") === ids.join("\n")) return;
  useGame.setState((s) => {
    const widgets = { ...s.widgets };
    if (ids.length) widgets[key] = ids; else delete widgets[key];
    return { widgets };
  });
}

/** Look in one workspace now (its panel just opened, say). */
export async function refreshWorkspaceWidgets(envId: string, cwd: string): Promise<void> {
  const ids = await listWidgets(envId, cwd);
  if (ids) record(envId, cwd, ids);
}

/** Look in every live thread's workspace; ones that couldn't be read keep what they had. */
export async function discoverWidgets(): Promise<void> {
  const spaces = widgetWorkspaces(useGame.getState().envs);
  const wanted = new Set(spaces.map((w) => workspaceKey(w.envId, w.cwd)));
  await Promise.all(spaces.map((w) => refreshWorkspaceWidgets(w.envId, w.cwd)));
  // Workspaces no live thread uses any more (on machines that are connected, so it's known).
  const { envs, widgets } = useGame.getState();
  const gone = Object.keys(widgets).filter((key) => !wanted.has(key) && envs[key.slice(0, key.indexOf("\n"))]?.connection === "live");
  if (gone.length) useGame.setState((s) => ({ widgets: Object.fromEntries(Object.entries(s.widgets).filter(([key]) => !gone.includes(key))) }));
}

export function installWidgetDiscovery(): () => void {
  const run = () => { if (!document.hidden) void discoverWidgets(); };
  // Machines connect over the first few seconds; look soon, then on the interval.
  const first = setTimeout(run, 4_000);
  const timer = setInterval(run, DISCOVER_MS);
  document.addEventListener("visibilitychange", run);
  return () => { clearTimeout(first); clearInterval(timer); document.removeEventListener("visibilitychange", run); };
}

// ---- Pins ----

export function applyPins(pins: WidgetPin[]): void {
  useGame.setState({ widgetPins: pins });
}

/** Add or move a pin: shown at once, then saved for every device. */
export async function putPin(pin: WidgetPin): Promise<void> {
  useGame.setState((s) => ({ widgetPins: [...s.widgetPins.filter((p) => p.id !== pin.id), pin] }));
  if (DEMO) return;
  try { applyPins(await fetchJson<WidgetPin[]>("/api/widget-pins", { method: "PUT", body: JSON.stringify({ pin }) })); }
  catch (err) { addLog({ tone: "bad", text: `Couldn't save the widget pin: ${(err as Error).message}` }); }
}

export async function removePin(id: string): Promise<void> {
  useGame.setState((s) => ({ widgetPins: s.widgetPins.filter((p) => p.id !== id) }));
  if (DEMO) return;
  try { applyPins(await fetchJson<WidgetPin[]>("/api/widget-pins/remove", { method: "POST", body: JSON.stringify({ id }) })); }
  catch (err) { addLog({ tone: "bad", text: `Couldn't unpin the widget: ${(err as Error).message}` }); }
}

// ---- The page ----

export interface WidgetMeta {
  title?: string;
  size?: { w: number; h: number };
  staleAfter?: number;
}

const metaContent = (html: string, name: string) =>
  new RegExp(`<meta\\s[^>]*name=["']${name}["'][^>]*>`, "i").exec(html)?.[0].match(/content=["']([^"']*)["']/i)?.[1];

/** What the page says of itself: <title>, t3-widget-size and t3-widget-stale-after. */
export function widgetMeta(html: string): WidgetMeta {
  const meta: WidgetMeta = {};
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1].replace(/\s+/g, " ").trim();
  if (title) meta.title = decodeEntities(title).slice(0, 80);
  const size = /^\s*(\d{2,4})\s*[x×]\s*(\d{2,4})\s*$/.exec(metaContent(html, "t3-widget-size") ?? "");
  if (size) meta.size = { w: Number(size[1]), h: Number(size[2]) };
  const stale = Number(metaContent(html, "t3-widget-stale-after"));
  if (Number.isFinite(stale) && stale > 0) meta.staleAfter = stale;
  return meta;
}

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]!);
}

/**
 * No network from the page: its data comes from the JSON file. Scripts, styles, fonts and images
 * may still come from https (a chart library from a CDN).
 */
export const WIDGET_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src 'none'; base-uri 'none'; form-action 'none'";

/** The page with Command's policy and the t3widget API ahead of everything it has. */
export function widgetDocument(html: string, data: unknown, updatedAt: string | undefined): string {
  const json = (v: unknown) => (JSON.stringify(v) ?? "undefined").replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const preamble = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}">` +
    `<script>(()=>{let data=${json(data)},at=${json(updatedAt)};const subs=[];` +
    `const call=(fn)=>{try{fn(data,at)}catch(e){console.error(e)}};` +
    `window.t3widget={get data(){return data},get updatedAt(){return at},onData(fn){subs.push(fn);if(data!==undefined)call(fn)}};` +
    `addEventListener("message",(e)=>{const m=e.data;if(e.source!==parent||!m||m.type!=="t3-widget-data")return;data=m.data;at=m.updatedAt;subs.forEach(call)})})()</script>`;
  // Right after <head>, or the doctype: anything ahead of a doctype would put the page in quirks mode.
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + preamble + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + preamble + html.slice(doctype[0].length);
  return preamble + html;
}

/** When the data was last updated: its own "updatedAt" (ISO, or epoch s or ms), if it has one. */
export function dataUpdatedAt(data: unknown): number | undefined {
  const at = data && typeof data === "object" && !Array.isArray(data) ? (data as { updatedAt?: unknown }).updatedAt : undefined;
  const ms = typeof at === "number" ? (at < 1e12 ? at * 1000 : at) : typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

// ---- Feeds: each widget on screen re-read on a timer, shared by everything showing it ----

export interface WidgetFeed {
  page?: string;
  meta: WidgetMeta;
  /** The page couldn't be read (gone from the workspace, or too big). */
  pageError?: string;
  data?: unknown;
  /** When the data last changed: its updatedAt, else when Command saw it change. */
  dataAt?: number;
  dataError?: string;
  /** The machine isn't connected: what's shown is the last read. */
  offline?: boolean;
}

class Feed {
  state: WidgetFeed = { meta: {} };
  private users = new Set<() => void>();
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private dataText?: string;
  private pageText?: string;
  private readonly envId: string;
  private readonly cwd: string;
  private readonly id: string;

  constructor(envId: string, cwd: string, id: string) {
    this.envId = envId;
    this.cwd = cwd;
    this.id = id;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.users.add(listener);
    if (this.users.size === 1) this.start();
    return () => {
      this.users.delete(listener);
      if (!this.users.size) this.stop();
    };
  };

  private set(patch: Partial<WidgetFeed>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.users) listener();
  }

  private start(): void {
    void this.readPage();
    void this.readData();
    this.timers = [
      setInterval(() => void this.readPage(), PAGE_MS),
      // A page not read yet (the machine was still connecting, say) is tried again with the data.
      setInterval(() => { if (this.pageText === undefined) void this.readPage(); void this.readData(); }, DATA_MS),
    ];
  }

  private stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** The machine's client, if it's connected and the page is in view. */
  private client() {
    const live = useGame.getState().envs[this.envId]?.connection === "live";
    if (live === !!this.state.offline) this.set({ offline: !live });
    return live && !document.hidden ? envClient(this.envId) : undefined;
  }

  private async readPage(): Promise<void> {
    const client = this.client();
    if (!client) return;
    try {
      const file = await client.readWorkspaceFile(this.cwd, `${WIDGET_DIR}/${this.id}.html`);
      if (file.truncated) return this.set({ pageError: "The page is over 1 MB" });
      if (file.contents === this.pageText) return this.state.pageError ? this.set({ pageError: undefined }) : undefined;
      this.pageText = file.contents;
      this.set({ page: file.contents, meta: widgetMeta(file.contents), pageError: undefined });
    } catch (err) {
      if (absent(err)) this.set({ pageError: "The widget's page is gone from the workspace" });
    }
  }

  private async readData(): Promise<void> {
    const client = this.client();
    if (!client) return;
    try {
      const file = await client.readWorkspaceFile(this.cwd, `${WIDGET_DIR}/${this.id}.json`);
      if (file.truncated) return this.set({ dataError: "Its data is over 1 MB" });
      if (file.contents === this.dataText) return this.state.dataError ? this.set({ dataError: undefined }) : undefined;
      let data: unknown;
      try { data = JSON.parse(file.contents); }
      catch { return this.set({ dataError: "Its data isn't valid JSON (caught mid-write?)" }); }
      // Without its own updatedAt, data first read now has no known age; a later change does.
      const seenChange = this.dataText !== undefined;
      this.dataText = file.contents;
      this.set({ data, dataAt: dataUpdatedAt(data) ?? (seenChange ? Date.now() : undefined), dataError: undefined });
    } catch (err) {
      // No data file: a static widget, or its feeder hasn't written yet.
      if (absent(err) && this.dataText !== undefined) this.set({ dataError: "Its data file is gone" });
    }
  }
}

const feeds = new Map<string, Feed>();

function feedFor(envId: string, cwd: string, id: string): Feed {
  const key = `${workspaceKey(envId, cwd)}\n${id}`;
  let feed = feeds.get(key);
  if (!feed) feeds.set(key, feed = new Feed(envId, cwd, id));
  return feed;
}

/** A widget's page and data, re-read while anything showing it is mounted. */
export function useWidgetFeed(envId: string, cwd: string, id: string): WidgetFeed {
  const feed = feedFor(envId, cwd, id);
  return useSyncExternalStore(feed.subscribe, () => feed.state);
}

/** Whether the data has gone longer than the page allows without an update. */
export function isStale(feed: WidgetFeed, now: number): boolean {
  return feed.dataAt !== undefined && now - feed.dataAt > (feed.meta.staleAfter ?? DEFAULT_STALE_SECONDS) * 1000;
}

/** The size a widget opens at when pinned. */
export function pinSize(meta: WidgetMeta): { w: number; h: number } {
  return meta.size ?? DEFAULT_SIZE;
}
