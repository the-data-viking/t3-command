import { create } from "zustand";
import type { EnvSummary, MeResponse } from "../shared/api";
import type { OrchestrationThread, ProjectShell, Provider, ThreadShell } from "./t3/types";
import type { UsageState } from "./t3/usage";
import type { HostState } from "./t3/host";
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
  id: number;
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
  selection: null,
  log: loadLog(),
  muted: loadMuted(),
  artStyle: loadArtStyle(),
  showEnvManager: false,
  showLog: false,
  showHistory: false,
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
/** Entries kept in memory for the comms log; the most recent are also kept in this browser. */
const LOG_LIMIT = 500;
const LOG_SAVED = 200;
const LOG_KEY = "t3c:comms-log";

function loadLog(): LogEntry[] {
  try {
    const saved = JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]") as LogEntry[];
    if (!Array.isArray(saved)) return [];
    logId = Math.max(0, ...saved.map((e) => e.id));
    return saved;
  } catch {
    return [];
  }
}

export function addLog(entry: Omit<LogEntry, "id" | "at">): void {
  useGame.setState((s) => ({ log: [...s.log, { ...entry, id: ++logId, at: Date.now() }].slice(-LOG_LIMIT) }));
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(useGame.getState().log.slice(-LOG_SAVED)));
  } catch {
    // Per-browser convenience only.
  }
}

export function clearLog(): void {
  useGame.setState({ log: [] });
  try { localStorage.removeItem(LOG_KEY); } catch { /* Per-browser convenience only. */ }
}
