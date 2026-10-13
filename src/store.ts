import { create } from "zustand";
import type { EnvSummary, MeResponse } from "../shared/api";
import type { OrchestrationThread, ProjectShell, Provider, ThreadShell } from "./t3/types";
import type { UsageState } from "./t3/usage";
import type { HostState } from "./t3/host";
import type { StorageView } from "../shared/storage";
import type { HermesBot } from "../shared/hermes";
import { applyHudTheme } from "./game/theme";

export type Connection = "connecting" | "live" | "reconnecting" | "needs-pairing" | "needs-update" | "offline";

/** Everything we know about one T3 environment ("base" on the map). */
export interface EnvWorld {
  summary: EnvSummary;
  connection: Connection;
  error?: string;
  synced: boolean;
  projects: Record<string, ProjectShell>;
  threads: Record<string, ThreadShell>;
  providers: Provider[];
  usage?: UsageState;
}

export interface ThreadDetail {
  thread: OrchestrationThread;
  synced: boolean;
}

export type Selection =
  | { kind: "hermes"; envId: string; profile?: string }
  | { kind: "unit"; envId: string; threadId: string }
  | { kind: "building"; envId: string; projectId: string }
  | { kind: "library"; envId: string; projectId: string }
  | null;

export type LogTone = "info" | "good" | "alert" | "bad";

export interface LogEntry {
  /** "s<n>" for the Command server's shared comms, "l<n>" for this browser's own messages. */
  id: string;
  at: number;
  tone: LogTone;
  text: string;
  envId?: string;
  threadId?: string;
}

export interface GameState {
  hermesCatalog?: { envId: string; bots: HermesBot[]; loaded: boolean; error?: string };
  me?: MeResponse;
  envs: Record<string, EnvWorld>;
  /** Open thread subscriptions, keyed by unitKey(envId, threadId). */
  details: Record<string, ThreadDetail>;
  /** Kept separate from shells so resource samples don't rebuild map geometry. */
  hosts: Record<string, HostState>;
  hostPanel: string | null;
  /** Disk usage per machine, as last measured by the Command server. */
  storage: Record<string, StorageView>;
  selection: Selection;
  log: LogEntry[];
  muted: boolean;
  /** Flight Deck map palette: warm plating or Night Shift. */
  artStyle: ArtStyle;
  showEnvManager: boolean;
  /** The scrollable comms log. */
  showLog: boolean;
  /** Recorded turn and spend history. */
  showHistory: boolean;
  /** Desktop notifications for approvals and questions while the tab isn't in view. */
  notify: boolean;
  /** The crew member whose pending approval/question is shown as an event dialog. */
  event: { envId: string; threadId: string } | null;
}

export const unitKey = (envId: string, threadId: string): string => `${envId}:${threadId}`;

export type ArtStyle = "flightdeck" | "flightdeck-nightshift";

function loadArtStyle(): ArtStyle {
  try {
    const saved = localStorage.getItem("t3c:art-style");
    if (saved === "flightdeck" || saved === "flightdeck-nightshift") return saved;
    if (saved === "kestrel") return "flightdeck";
  } catch {
    // Per-browser convenience only.
  }
  return "flightdeck-nightshift";
}

export function setArtStyle(artStyle: ArtStyle): void {
  try {
    localStorage.setItem("t3c:art-style", artStyle);
  } catch {
    // Per-browser convenience only.
  }
  applyHudTheme(artStyle);
  useGame.setState({ artStyle });
}

function loadNotify(): boolean {
  try {
    return localStorage.getItem("t3c:notify") === "1" && typeof Notification !== "undefined" && Notification.permission === "granted";
  } catch {
    return false;
  }
}

/** Turn desktop notifications on (asking the browser for permission) or off. */
export async function setNotify(on: boolean): Promise<void> {
  if (on && typeof Notification !== "undefined" && Notification.permission !== "granted") {
    if ((await Notification.requestPermission()) !== "granted") on = false;
  }
  try { localStorage.setItem("t3c:notify", on ? "1" : "0"); } catch { /* Per-browser convenience only. */ }
  useGame.setState({ notify: on });
}

function loadMuted(): boolean {
  try {
    return localStorage.getItem("t3c:muted") === "1";
  } catch {
    return false;
  }
}

export const useGame = create<GameState>()(() => ({
  envs: {},
  details: {},
  hosts: {},
  hostPanel: null,
  storage: {},
  selection: null,
  log: loadLog(),
  muted: loadMuted(),
  artStyle: loadArtStyle(),
  showEnvManager: false,
  showLog: false,
  showHistory: false,
  notify: loadNotify(),
  event: null,
}));

/** Returning the same env from `fn` is a no-op: subscribers (the map, panels) are not notified. */
export function updateEnv(envId: string, fn: (env: EnvWorld) => EnvWorld): void {
  useGame.setState((s) => {
    const env = s.envs[envId];
    if (!env) return s;
    const next = fn(env);
    return next === env ? s : { envs: { ...s.envs, [envId]: next } };
  });
}

export function setSelection(selection: Selection): void {
  useGame.setState({ selection, hostPanel: null });
}

export function openHost(envId: string): void {
  useGame.setState({ hostPanel: envId, selection: null });
}

export function openEvent(event: GameState["event"]): void {
  useGame.setState({ event });
}

export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem("t3c:muted", muted ? "1" : "0");
  } catch {
    // Per-browser convenience only.
  }
  useGame.setState({ muted });
}

let logId = 0;
/** Entries kept in memory for the comms log. */
const LOG_LIMIT = 500;
/** This browser's own messages (errors, recruits, quiet turns) are kept here; fleet events come from the server. */
const LOG_SAVED = 200;
const LOG_KEY = "t3c:comms-log-local";
const CLEARED_KEY = "t3c:comms-cleared-at";

function loadLog(): LogEntry[] {
  try {
    // Before the server kept the log, this browser kept all of it under the old key.
    const legacy = localStorage.getItem("t3c:comms-log");
    if (legacy !== null) {
      const old = JSON.parse(legacy) as Array<Omit<LogEntry, "id"> & { id: number }>;
      if (Array.isArray(old) && localStorage.getItem(LOG_KEY) === null) localStorage.setItem(LOG_KEY, JSON.stringify(old.map((e) => ({ ...e, id: `l${e.id}` }))));
      localStorage.removeItem("t3c:comms-log");
    }
    const saved = JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]") as LogEntry[];
    if (!Array.isArray(saved)) return [];
    logId = Math.max(0, ...saved.map((e) => Number(String(e.id).slice(1)) || 0));
    return saved.filter((e) => e.at > clearedAt());
  } catch {
    return [];
  }
}

function clearedAt(): number {
  try { return Number(localStorage.getItem(CLEARED_KEY)) || 0; } catch { return 0; }
}

function saveLocal(log: LogEntry[]): void {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(log.filter((e) => e.id.startsWith("l")).slice(-LOG_SAVED)));
  } catch {
    // Per-browser convenience only.
  }
}

const byTime = (a: LogEntry, b: LogEntry) => a.at - b.at || a.id.localeCompare(b.id);

/** A message about something this browser did (not a fleet event). */
export function addLog(entry: Omit<LogEntry, "id" | "at">): void {
  useGame.setState((s) => ({ log: [...s.log, { ...entry, id: `l${++logId}`, at: Date.now() }].slice(-LOG_LIMIT) }));
  saveLocal(useGame.getState().log);
}

/** Fleet events from the Command server's comms stream, merged in time order. */
export function mergeServerLog(entries: Array<Omit<LogEntry, "id"> & { id: number }>): void {
  const cleared = clearedAt();
  useGame.setState((s) => {
    const have = new Set(s.log.map((e) => e.id));
    const fresh = entries.filter((e) => e.at > cleared && !have.has(`s${e.id}`)).map((e) => ({ ...e, id: `s${e.id}` }));
    return fresh.length ? { log: [...s.log, ...fresh].sort(byTime).slice(-LOG_LIMIT) } : {};
  });
}

/** Clearing hides everything up to now in this browser; the server keeps its copy. */
export function clearLog(): void {
  useGame.setState({ log: [] });
  try {
    localStorage.setItem(CLEARED_KEY, String(Date.now()));
    localStorage.removeItem(LOG_KEY);
  } catch { /* Per-browser convenience only. */ }
}
