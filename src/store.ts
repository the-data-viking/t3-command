import { create } from "zustand";
import type { EnvSummary, MeResponse } from "../shared/api";
import type { OrchestrationThread, ProjectShell, Provider, ThreadShell } from "./t3/types";

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
}

export interface ThreadDetail {
  thread: OrchestrationThread;
  synced: boolean;
}

export type Selection =
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
  me?: MeResponse;
  envs: Record<string, EnvWorld>;
  /** Open thread subscriptions, keyed by unitKey(envId, threadId). */
  details: Record<string, ThreadDetail>;
  selection: Selection;
  log: LogEntry[];
  muted: boolean;
  showEnvManager: boolean;
  /** The crew member whose pending approval/question is shown as an event dialog. */
  event: { envId: string; threadId: string } | null;
}

export const unitKey = (envId: string, threadId: string): string => `${envId}:${threadId}`;

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
  selection: null,
  log: [],
  muted: loadMuted(),
  showEnvManager: false,
  event: null,
}));

export function updateEnv(envId: string, fn: (env: EnvWorld) => EnvWorld): void {
  useGame.setState((s) => {
    const env = s.envs[envId];
    return env ? { envs: { ...s.envs, [envId]: fn(env) } } : {};
  });
}

export function setSelection(selection: Selection): void {
  useGame.setState({ selection });
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
const LOG_LIMIT = 60;

export function addLog(entry: Omit<LogEntry, "id" | "at">): void {
  useGame.setState((s) => ({ log: [...s.log, { ...entry, id: ++logId, at: Date.now() }].slice(-LOG_LIMIT) }));
}
