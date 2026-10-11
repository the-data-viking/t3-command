// Fleet layout: pure geometry computed from the game store. No rendering here.
//
//   hub      = one project, shared across every environment that has it (matched by git identity)
//   bay      = one environment's copy of a project, docked to the hub: consoles, workstations,
//              quarters, maybe an archive pod. Bays are the "modules" panels select.
//   station  = one T3 environment: a home ship in orbit above the hubs, linked to each of its bays
//   crew     = one thread: a seat at a console in its bay, or a bunk in quarters when settled

import type { EnvWorld, GameState } from "../store";
import { unitKey } from "../store";
import { isHistory, unitState } from "../t3/derive";
import type { Workstation } from "../t3/telemetry";
import type { ProjectShell, ThreadShell } from "../t3/types";
import { teamColor } from "./theme";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One environment's bay on a project hub. */
export interface ModuleLayout {
  key: string; // envId:projectId
  envId: string;
  projectId: string;
  hubKey: string;
  color: number; // the owning station's team color
  room: Rect;
  /** Short corridor from the bay down to the hub spine. */
  corridor: [Point, Point];
  /** Where the station's data link plugs in (top of the bay). */
  port: Point;
  workstations: Record<Exclude<Workstation, "console">, Point>;
  consoles: Point[];
  archive?: Rect;
  archived: number;
  quarters?: Rect;
}

export interface CrewLayout {
  key: string;
  envId: string;
  threadId: string;
  moduleKey: string;
  /** Where the crew member sits (in front of its console) or sleeps (bunk). */
  home: Point;
  console?: Point;
  sleeping: boolean;
}

export interface HubLayout {
  key: string;
  name: string;
  /** "github.com/owner/repo" when T3 identified the repository. */
  repo?: string;
  spine: Rect;
  modules: string[];
  bounds: Rect;
}

export interface StationLayout {
  envId: string;
  index: number;
  color: number;
  center: Point;
  coreRadius: number;
  bounds: Rect;
  /** Data links from the station to each of its bays. */
  links: Array<{ moduleKey: string; from: Point; to: Point }>;
}

export interface FleetLayout {
  stations: Map<string, StationLayout>;
  hubs: Map<string, HubLayout>;
  modules: Map<string, ModuleLayout>;
  crew: Map<string, CrewLayout>;
  bounds: Rect;
}

const CONSOLE_W = 46;
const CONSOLE_H = 50;
const STRIP_H = 46; // workstation strip at the top of each bay
const BUNK_W = 18;
const BUNK_H = 12;
const PAD = 14;
const ARCHIVE_W = 44;
const ARCHIVE_H = 40;
const BAY_GAP = 34;
const SPINE_H = 46;
const DOCK = 30; // corridor between a bay and its spine
const HUB_GAP = 170;
const STATION_CORE = 34;
const STATION_SPACING = 300;
const ORBIT_GAP = 230; // between the tallest bay and the station row
const STAGGER = 120; // every other station sits higher

export function sortedEnvs(state: GameState): EnvWorld[] {
  return Object.values(state.envs).sort((a, b) => a.summary.addedAt.localeCompare(b.summary.addedAt));
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

// ---- Grouping projects across environments ------------------------------------------

interface ProjectRef {
  env: EnvWorld;
  index: number; // station index
  project: ProjectShell;
}

interface HubDraft {
  key: string;
  name: string;
  repo?: string;
  members: ProjectRef[];
}

function basename(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
}

/**
 * Projects with the same git identity are one hub. Projects T3 couldn't identify join a hub
 * whose repository name matches their folder name; otherwise they stay local to their station.
 */
export function groupProjects(envs: EnvWorld[]): HubDraft[] {
  const hubs = new Map<string, HubDraft>();
  const unidentified: ProjectRef[] = [];
  envs.forEach((env, index) => {
    for (const project of Object.values(env.projects)) {
      const id = project.repositoryIdentity;
      if (!id?.canonicalKey) {
        unidentified.push({ env, index, project });
        continue;
      }
      const key = `repo:${id.canonicalKey.toLowerCase()}`;
      const hub = hubs.get(key) ?? { key, name: id.name ?? project.title, repo: id.canonicalKey, members: [] };
      hub.members.push({ env, index, project });
      hubs.set(key, hub);
    }
  });
  for (const ref of unidentified) {
    const folder = basename(ref.project.workspaceRoot);
    const match = [...hubs.values()].find(
      (h) => h.repo && (h.name.toLowerCase() === folder || h.name.toLowerCase() === ref.project.title.toLowerCase()) && !h.members.some((m) => m.env === ref.env),
    );
    if (match) match.members.push(ref);
    else hubs.set(`local:${ref.env.summary.id}:${ref.project.id}`, { key: `local:${ref.env.summary.id}:${ref.project.id}`, name: ref.project.title, members: [ref] });
  }
  for (const hub of hubs.values()) hub.members.sort((a, b) => a.index - b.index);
  // Biggest shared projects first, then by name.
  return [...hubs.values()].sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name));
}

// ---- Bays -----------------------------------------------------------------------------

interface BayDraft {
  ref: ProjectRef;
  awake: ThreadShell[];
  asleep: ThreadShell[];
  archived: number;
  cols: number;
  rows: number;
  bunkRows: number;
  w: number;
  h: number;
}

function draftBay(ref: ProjectRef): BayDraft {
  const threads = Object.values(ref.env.threads).filter((t) => t.projectId === ref.project.id);
  const awake = threads.filter((t) => !isHistory(t) && unitState(t) !== "sleeping").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const asleep = threads.filter((t) => !isHistory(t) && unitState(t) === "sleeping").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const archived = threads.filter(isHistory).length;
  const cols = Math.min(5, Math.max(3, Math.ceil(Math.sqrt(awake.length * 1.5))));
  const rows = Math.max(1, Math.ceil(awake.length / cols));
  const w = cols * CONSOLE_W + PAD * 2;
  const perBunkRow = Math.floor((w - PAD * 2) / BUNK_W);
  const bunkRows = asleep.length ? Math.ceil(asleep.length / perBunkRow) : 0;
  const h = STRIP_H + rows * CONSOLE_H + (bunkRows ? bunkRows * (BUNK_H + 4) + 18 : 0) + PAD;
  return { ref, awake, asleep, archived, cols, rows, bunkRows, w, h };
}

/** Place a bay with its bottom edge at `bottom` and its left edge at `left`. */
function placeBay(d: BayDraft, hubKey: string, color: number, left: number, bottom: number, crew: CrewLayout[]): ModuleLayout {
  const envId = d.ref.env.summary.id;
  const room: Rect = { x: left, y: bottom - d.h, w: d.w, h: d.h };
  const key = `${envId}:${d.ref.project.id}`;
  const stripY = room.y + 22;
  const consoles: Point[] = [];
  d.awake.forEach((t, k) => {
    const col = k % d.cols;
    const row = Math.floor(k / d.cols);
    const inRow = Math.min(d.cols, d.awake.length - row * d.cols);
    const x = room.x + room.w / 2 + (col - (inRow - 1) / 2) * CONSOLE_W;
    const y = room.y + STRIP_H + row * CONSOLE_H + 14;
    consoles.push({ x, y });
    crew.push({ key: unitKey(envId, t.id), envId, threadId: t.id, moduleKey: key, home: { x, y: y + 20 }, console: { x, y }, sleeping: false });
  });

  let quarters: Rect | undefined;
  if (d.bunkRows) {
    const qy = room.y + STRIP_H + d.rows * CONSOLE_H + 6;
    quarters = { x: room.x + PAD - 4, y: qy, w: room.w - PAD * 2 + 8, h: d.bunkRows * (BUNK_H + 4) + 10 };
    const perRow = Math.floor((room.w - PAD * 2) / BUNK_W);
    d.asleep.forEach((t, k) => {
      const x = room.x + PAD + (k % perRow) * BUNK_W + BUNK_W / 2;
      const y = qy + 10 + Math.floor(k / perRow) * (BUNK_H + 4) + BUNK_H / 2;
      crew.push({ key: unitKey(envId, t.id), envId, threadId: t.id, moduleKey: key, home: { x, y }, sleeping: true });
    });
  }

  const archive = d.archived ? { x: room.x + room.w + 10, y: room.y + room.h - ARCHIVE_H, w: ARCHIVE_W, h: ARCHIVE_H } : undefined;

  return {
    key,
    envId,
    projectId: d.ref.project.id,
    hubKey,
    color,
    room,
    corridor: [{ x: room.x + room.w / 2, y: room.y + room.h }, { x: room.x + room.w / 2, y: room.y + room.h + DOCK }],
    port: { x: room.x + room.w / 2, y: room.y - 6 },
    workstations: {
      terminal: { x: room.x + room.w * 0.22, y: stripY },
      files: { x: room.x + room.w * 0.5, y: stripY },
      comms: { x: room.x + room.w * 0.78, y: stripY },
    },
    consoles,
    archive,
    archived: d.archived,
    quarters,
  };
}

// ---- Fleet ----------------------------------------------------------------------------

export function computeFleetLayout(state: GameState): FleetLayout {
  const envs = sortedEnvs(state);
  const fleet: FleetLayout = { stations: new Map(), hubs: new Map(), modules: new Map(), crew: new Map(), bounds: { x: 0, y: 0, w: 0, h: 0 } };
  if (envs.length === 0) return fleet;

  // Hubs sit side by side on a common baseline (the top of their spines is y = 0).
  const crew: CrewLayout[] = [];
  let cursor = 0;
  let tallest = 0;
  for (const hub of groupProjects(envs)) {
    const bays = hub.members.map(draftBay);
    const left = cursor;
    let x = left + 40;
    const modules: ModuleLayout[] = [];
    for (const d of bays) {
      const m = placeBay(d, hub.key, teamColor(d.ref.index), x, -DOCK, crew);
      modules.push(m);
      tallest = Math.max(tallest, d.h);
      x += d.w + (m.archive ? ARCHIVE_W + 20 : 0) + BAY_GAP;
    }
    const right = Math.max(x - BAY_GAP + 40, left + 260);
    const spine: Rect = { x: left, y: 0, w: right - left, h: SPINE_H };
    let bounds = spine;
    for (const m of modules) {
      bounds = union(bounds, m.room);
      if (m.archive) bounds = union(bounds, m.archive);
      fleet.modules.set(m.key, m);
    }
    fleet.hubs.set(hub.key, { key: hub.key, name: hub.name, repo: hub.repo, spine, modules: modules.map((m) => m.key), bounds });
    cursor = right + HUB_GAP;
  }

  // Stations orbit above their bay on the biggest hub they work on (hubs are ordered biggest
  // first), so the main links drop straight down and only links to smaller hubs slant.
  const stationY = -DOCK - tallest - ORBIT_GAP;
  const wanted = envs.map((env, index) => {
    const bays = [...fleet.modules.values()].filter((m) => m.envId === env.summary.id);
    const x = bays.length ? bays[0].port.x : Number.POSITIVE_INFINITY;
    return { env, index, x, bays };
  });
  const placed = [...wanted].sort((a, b) => a.x - b.x || a.index - b.index);
  let lastX = Number.NEGATIVE_INFINITY;
  const fallbackStart = cursor - HUB_GAP + STATION_SPACING; // stations with no bays line up to the right
  let fallbackX = fallbackStart;
  placed.forEach((s, order) => {
    let x = Number.isFinite(s.x) ? s.x : fallbackX;
    if (!Number.isFinite(s.x)) fallbackX += STATION_SPACING;
    x = Math.max(x, lastX + STATION_SPACING);
    lastX = x;
    // Alternate heights so neighboring stations' banners don't collide.
    const y = stationY - (order % 2) * STAGGER;
    const center = { x, y };
    const bottom = { x, y: y + STATION_CORE + 6 };
    fleet.stations.set(s.env.summary.id, {
      envId: s.env.summary.id,
      index: s.index,
      color: teamColor(s.index),
      center,
      coreRadius: STATION_CORE,
      bounds: { x: x - STATION_CORE - 6, y: y - STATION_CORE - 6, w: (STATION_CORE + 6) * 2, h: (STATION_CORE + 6) * 2 },
      links: s.bays.map((m) => ({ moduleKey: m.key, from: bottom, to: m.port })),
    });
  });

  for (const c of crew) fleet.crew.set(c.key, c);
  let bounds: Rect | undefined;
  for (const h of fleet.hubs.values()) bounds = bounds ? union(bounds, h.bounds) : h.bounds;
  for (const s of fleet.stations.values()) bounds = bounds ? union(bounds, s.bounds) : s.bounds;
  fleet.bounds = bounds!;
  return fleet;
}

/** Team color for an environment, consistent between the map and the HUD. */
export function stationColor(state: GameState, envId: string): number {
  const index = sortedEnvs(state).findIndex((e) => e.summary.id === envId);
  return teamColor(Math.max(0, index));
}
