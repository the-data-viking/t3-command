import { create } from "zustand";
import type { FleetMemory } from "../shared/memory";
import type { CommsKind } from "../shared/comms";
import type { Dispatch } from "../shared/dispatches";
import type { FollowUpsView } from "../shared/followups";
import { DEFAULT_PLAYBOOKS, type Playbook } from "../shared/playbooks";
import type { EnvSummary, MeResponse, T3Latest } from "../shared/api";
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
  /** What the entry is about (server entries since kinds were added); see shared/comms.ts. */
  kind?: CommsKind;
  text: string;
  envId?: string;
  threadId?: string;
  /** A squad order or mission the entry is about. */
  dispatchId?: string;
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
  /** Crew picked together (shift-click, shift-drag, control groups) for batch actions. */
  squad: SquadMember[];
  /** Reports marked read in this browser: unitKey → the turn whose report was read. */
  readReports: Record<string, string>;
  /** Command palette and help overlay. */
  showPalette: boolean;
  showHelp: boolean;
  log: LogEntry[];
  muted: boolean;
  /** Master sound volume, 0–1. */
  volume: number;
  /** Flight Deck map palette: warm plating or Night Shift. */
  artStyle: ArtStyle;
  showEnvManager: boolean;
  /** The scrollable comms log. */
  showLog: boolean;
  /** Recorded turn and spend history. */
  showHistory: boolean;
  showTimeline: boolean;
  showBoard: boolean;
  /** Desktop notifications for approvals and questions while the tab isn't in view. */
  notify: boolean;
  /** The crew member whose pending approval/question is shown as an event dialog. */
  event: { envId: string; threadId: string } | null;
  /** A request that arrived just as you pressed a number key: announced, not popped up. */
  incoming: { envId: string; threadId: string; at: number } | null;
  /** The finished job shown as a report card ("." opens the oldest unread). */
  debrief: { envId: string; threadId: string } | null;
  /** The review panel: a crew member's latest turn, claims beside evidence. */
  review: { envId: string; threadId: string } | null;
  /** The replies to a squad order, side by side: the dispatch's id. */
  replies: string | null;
  /** The squad bar's mission dialog is open (Esc closes it before touching the squad). */
  planningMission: boolean;
  /** A run through the queue in progress: the cards it has opened so far. */
  queueRun: { seen: string[]; skipped: string[] } | null;
  /** The last run just ended: how many cards it went through (shown briefly). */
  queueClear: { handled: number; skipped: number; at: number } | null;
  /** Photo mode: the HUD hidden, the map alone with a title card (P). */
  photo: boolean;
  /** Orders the Command server will send when a busy crew member's turn ends (every device's). */
  followUps: FollowUpsView;
  /** Squad orders being followed (the Command server's list). */
  dispatches: Dispatch[];
  /** Saved orders, typed as /name in any order box (from the Command server). */
  playbooks: Playbook[];
  showPlaybooks: boolean;
  /** Each project copy's finished and failed turns (90 days), worn by its station. */
  memory: FleetMemory;
  /** The newest T3 release on npm, for offering machine updates. */
  t3Latest: T3Latest | null;
}

export const unitKey = (envId: string, threadId: string): string => `${envId}:${threadId}`;

export interface SquadMember { envId: string; threadId: string }

/** Add a crew member to the squad, or take them out if already in it. */
export function toggleSquad(member: SquadMember): void {
  useGame.setState((s) => {
    const key = unitKey(member.envId, member.threadId);
    const inSquad = s.squad.some((m) => unitKey(m.envId, m.threadId) === key);
    const squad = inSquad ? s.squad.filter((m) => unitKey(m.envId, m.threadId) !== key) : [...s.squad, member];
    return squad.length ? { squad } : { squad, planningMission: false };
  });
}

const READ_KEY = "t3c:read-reports";

function loadReadReports(): Record<string, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(READ_KEY) ?? "{}") as Record<string, string>;
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

/** Where read marks go besides this browser: the Command server (set by the comms connection). */
let readSink: ((marks: Record<string, string>) => void) | undefined;
export function setReadSink(sink: typeof readSink): void {
  readSink = sink;
}

function saveReadReports(readReports: Record<string, string>): void {
  try { localStorage.setItem(READ_KEY, JSON.stringify(readReports)); } catch { /* A cache; the server holds the marks. */ }
}

/** Mark crew members' current reports read; a later turn's report shows up again. */
export function markReportsRead(members: Array<{ envId: string; threadId: string; turnId: string }>): void {
  const marks = Object.fromEntries(members.map((m) => [unitKey(m.envId, m.threadId), m.turnId]));
  useGame.setState((s) => {
    const readReports = { ...s.readReports, ...marks };
    saveReadReports(readReports);
    return { readReports };
  });
  readSink?.(marks);
}

/** Read marks from the server (every device's): merged in, so reading on the phone clears it here too. */
export function mergeReadMarks(marks: Record<string, string>): void {
  useGame.setState((s) => {
    if (Object.entries(marks).every(([k, v]) => s.readReports[k] === v)) return {};
    const readReports = { ...s.readReports, ...marks };
    saveReadReports(readReports);
    return { readReports };
  });
}

export function setSquad(squad: SquadMember[]): void {
  // No squad, no mission being planned for it.
  useGame.setState(squad.length ? { squad } : { squad, planningMission: false });
}

/** Map styles in menu order: Night Shift by night and by day, Kestrel, Pastel, then High Contrast (an accessibility mode). */
export const ART_STYLES = ["flightdeck-nightshift", "signal", "flightdeck", "pastel", "highcontrast"] as const;
export type ArtStyle = (typeof ART_STYLES)[number];

function loadArtStyle(): ArtStyle {
  try {
    const saved = localStorage.getItem("t3c:theme");
    if ((ART_STYLES as readonly string[]).includes(saved ?? "")) return saved as ArtStyle;
    // Kestrel was its own palette until it merged into the warm Flight Deck (which took its name).
    if (saved === "kestrel") return "flightdeck";
    // Before the picker: two styles, where a saved "kestrel" meant the warm Flight Deck.
    const legacy = localStorage.getItem("t3c:art-style");
    if (legacy === "flightdeck" || legacy === "kestrel") return "flightdeck";
    if (legacy === "flightdeck-nightshift" || legacy === "nightshift") return "flightdeck-nightshift";
  } catch {
    // Per-browser convenience only.
  }
  // No choice yet: follow an OS request for more contrast.
  return typeof matchMedia === "function" && matchMedia("(prefers-contrast: more)").matches ? "highcontrast" : "flightdeck-nightshift";
}

export function setArtStyle(artStyle: ArtStyle): void {
  try {
    localStorage.setItem("t3c:theme", artStyle);
    // The world to return to when High Contrast is turned off again.
    if (artStyle !== "highcontrast") localStorage.setItem("t3c:world", artStyle);
  } catch {
    // Per-browser convenience only.
  }
  applyHudTheme(artStyle);
  useGame.setState({ artStyle });
}

/** High Contrast is an accessibility mode over the worlds: turning it off restores the last world. */
export function setHighContrast(on: boolean): void {
  if (on) {
    // Remember the world being left, even one chosen before worlds were remembered.
    const current = useGame.getState().artStyle;
    try { if (current !== "highcontrast") localStorage.setItem("t3c:world", current); } catch { /* Per-browser convenience only. */ }
    setArtStyle("highcontrast");
    return;
  }
  let world: string | null = null;
  try { world = localStorage.getItem("t3c:world"); } catch { /* Per-browser convenience only. */ }
  setArtStyle((ART_STYLES as readonly string[]).includes(world ?? "") && world !== "highcontrast" ? world as ArtStyle : "flightdeck-nightshift");
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
  squad: [],
  readReports: loadReadReports(),
  showPalette: false,
  showHelp: false,
  log: loadLog(),
  muted: loadMuted(),
  volume: loadVolume(),
  artStyle: loadArtStyle(),
  showEnvManager: false,
  showLog: false,
  showHistory: false,
  showTimeline: false,
  showBoard: false,
  notify: loadNotify(),
  event: null,
  incoming: null,
  debrief: null,
  review: null,
  replies: null,
  planningMission: false,
  queueRun: null,
  queueClear: null,
  photo: false,
  followUps: { paused: false, queued: [] },
  dispatches: [],
  playbooks: DEFAULT_PLAYBOOKS,
  showPlaybooks: false,
  memory: {},
  t3Latest: null,
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
  // One card at a time: a request card replaces a report card, so their number keys never overlap.
  useGame.setState(event ? { event, incoming: null, debrief: null, review: null } : { event });
}

function loadVolume(): number {
  try {
    const v = Number(localStorage.getItem("t3c:volume"));
    return localStorage.getItem("t3c:volume") !== null && v >= 0 && v <= 1 ? v : 0.7;
  } catch {
    return 0.7;
  }
}

export function setVolume(volume: number): void {
  const v = Math.min(1, Math.max(0, volume));
  try { localStorage.setItem("t3c:volume", String(v)); } catch { /* Per-browser convenience only. */ }
  useGame.setState({ volume: v, ...(v > 0 ? { muted: false } : {}) });
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
