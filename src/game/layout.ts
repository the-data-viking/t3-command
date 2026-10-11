// Fleet layout: pure geometry computed from the game store. No rendering here.
//
// Every project is a station, shared by every environment that works on it (matched by git
// identity). Crew from all those environments work side by side in the station's rooms and wear
// their environment's team color. Each environment is one ship in the fleet row above the
// stations, with a supply line to every station it has crew on.
//
//    [ship A]      [ship B]      [ship C]       fleet row: one ship per environment
//        \  ______/   \______        |          supply lines
//   ┌──────────┬──────────┬──────────┐
//   │ TERMINAL │  FILES   │  COMMS   │   systems row: crew walk here for real tool calls
//   ├────■─────┴────■─────┴────■─────┤   ■ = doors to the bridge
//   │  BRIDGE   one console per awake crew member, from any environment
//   ├──────■──────────────────┬──■───┤
//   │ QUARTERS (3 latest)     │ARCHIVE│   only the most recently settled crew stay aboard
//   └─────────────────────────┴──────┘

import type { EnvWorld, GameState } from "../store";
import { unitKey } from "../store";
import { isHistory, unitState } from "../t3/derive";
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

export type RoomKind = "terminal" | "files" | "comms" | "bridge" | "quarters" | "archive";
export type SystemRoom = "terminal" | "files" | "comms";

export interface Room {
  kind: RoomKind;
  rect: Rect;
  /** Doorway into the bridge (every room except the bridge has one). */
  door?: Point;
}

export interface Door {
  x: number;
  y: number;
  /** Door in a vertical wall (between side-by-side rooms) vs. a horizontal one. */
  vertical: boolean;
}

/** One project station. */
export interface StationLayout {
  key: string;
  name: string;
  /** "github.com/owner/repo" when T3 identified the repository. */
  repo?: string;
  /** Each environment's copy of this project. */
  members: Array<{ envId: string; projectId: string }>;
  interior: Rect;
  hull: number[]; // outline polygon
  rooms: Partial<Record<RoomKind, Room>>;
  doors: Door[];
  consoles: Point[];
  workstations: Record<SystemRoom, Point>;
  archived: number;
  /** Settled crew not shown aboard (only the most recent few are). */
  settledHidden: number;
  /** Where supply lines from ships arrive (top of the hull). */
  port: Point;
  nameplate: Point;
  bounds: Rect;
}

/** One environment's ship in the fleet row. */
export interface ShipLayout {
  envId: string;
  color: number;
  hull: Rect;
  plate: Rect;
  /** Supply lines to every station this environment has crew on. */
  links: Array<{ stationKey: string; from: Point; to: Point }>;
}

export interface CrewLayout {
  key: string;
  envId: string;
  threadId: string;
  stationKey: string;
  color: number; // team color
  /** Seat in front of the console, or bunk. */
  home: Point;
  homeRoom: RoomKind;
  console?: Point;
  sleeping: boolean;
}

export interface FleetLayout {
  stations: Map<string, StationLayout>;
  ships: Map<string, ShipLayout>;
  crew: Map<string, CrewLayout>;
  bounds: Rect;
}

export const TILE = 32;
/** How many settled crew each station keeps aboard, most recently settled first. */
export const QUARTERS_SHOWN = 3;
const HULL_PAD = 22;
export const SHIP_W = 150;
const SHIP_H = 54;
const SHIP_GAP = 60;
const FLEET_GAP = 190; // between the fleet row and the stations
const STATION_GAP_X = 200;
const STATION_GAP_Y = 140;

export function sortedEnvs(state: GameState): EnvWorld[] {
  return Object.values(state.envs).sort((a, b) => a.summary.addedAt.localeCompare(b.summary.addedAt));
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

// ---- Grouping projects across environments ------------------------------------------

export interface ProjectRef {
  env: EnvWorld;
  index: number; // environment (team) index
  project: ProjectShell;
}

export interface ProjectGroup {
  key: string;
  name: string;
  repo?: string;
  members: ProjectRef[];
}

function basename(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
}

/**
 * Projects with the same git identity are one station. Projects T3 couldn't identify join a
 * station whose repository name matches their folder name; otherwise they get their own.
 */
export function groupProjects(envs: EnvWorld[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  const unidentified: ProjectRef[] = [];
  envs.forEach((env, index) => {
    for (const project of Object.values(env.projects)) {
      const id = project.repositoryIdentity;
      if (!id?.canonicalKey) {
        unidentified.push({ env, index, project });
        continue;
      }
      const key = `repo:${id.canonicalKey.toLowerCase()}`;
      const group = groups.get(key) ?? { key, name: id.name ?? project.title, repo: id.canonicalKey, members: [] };
      group.members.push({ env, index, project });
      groups.set(key, group);
    }
  });
  for (const ref of unidentified) {
    const folder = basename(ref.project.workspaceRoot);
    const match = [...groups.values()].find(
      (g) => g.repo && (g.name.toLowerCase() === folder || g.name.toLowerCase() === ref.project.title.toLowerCase()) && !g.members.some((m) => m.env === ref.env),
    );
    if (match) match.members.push(ref);
    else groups.set(`local:${ref.env.summary.id}:${ref.project.id}`, { key: `local:${ref.env.summary.id}:${ref.project.id}`, name: ref.project.title, members: [ref] });
  }
  for (const g of groups.values()) g.members.sort((a, b) => a.index - b.index);
  return [...groups.values()].sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name));
}

/** The project group (station) a given environment's project belongs to. */
export function groupFor(state: GameState, envId: string, projectId: string): ProjectGroup | undefined {
  return groupProjects(sortedEnvs(state)).find((g) => g.members.some((m) => m.env.summary.id === envId && m.project.id === projectId));
}

function settledAt(t: ThreadShell): string {
  return t.settledAt ?? t.snoozedUntil ?? t.updatedAt;
}

// ---- Stations -------------------------------------------------------------------------

interface CrewRef {
  ref: ProjectRef;
  thread: ThreadShell;
}

function layoutStation(group: ProjectGroup, x0: number, y0: number, crew: CrewLayout[]): StationLayout {
  const T = TILE;
  const all: CrewRef[] = group.members.flatMap((ref) =>
    Object.values(ref.env.threads)
      .filter((t) => t.projectId === ref.project.id)
      .map((thread) => ({ ref, thread })),
  );
  const awake = all.filter((c) => !isHistory(c.thread) && unitState(c.thread) !== "sleeping").sort((a, b) => a.thread.createdAt.localeCompare(b.thread.createdAt));
  const settled = all.filter((c) => !isHistory(c.thread) && unitState(c.thread) === "sleeping").sort((a, b) => settledAt(b.thread).localeCompare(settledAt(a.thread)));
  const asleep = settled.slice(0, QUARTERS_SHOWN);
  const archived = all.filter((c) => isHistory(c.thread)).length;

  const cols = Math.min(6, Math.max(3, Math.ceil(Math.sqrt(awake.length * 1.5))));
  const rows = Math.max(1, Math.ceil(awake.length / cols));
  const archiveW = archived ? 2 : 0;
  const w = Math.max(9, cols * 2);
  const quartersW = w - archiveW;
  const bottomH = asleep.length || archived ? (archived ? 2 : 1) : 0;
  const h = 2 + rows * 2 + bottomH;
  const key = group.key;
  const rooms: Partial<Record<RoomKind, Room>> = {};
  const doors: Door[] = [];
  const iy = y0 + 70; // nameplate above
  const W = w * T;

  // Systems row.
  const a = Math.floor(w / 3);
  const widths = [a, a, w - 2 * a];
  let x = x0;
  (["terminal", "files", "comms"] as const).forEach((kind, i) => {
    const rect = { x, y: iy, w: widths[i] * T, h: 2 * T };
    const door = { x: x + rect.w / 2, y: iy + 2 * T };
    rooms[kind] = { kind, rect, door };
    doors.push({ ...door, vertical: false });
    if (i > 0) doors.push({ x, y: iy + T, vertical: true });
    x += rect.w;
  });

  // Bridge: everyone's consoles together.
  const bridge = { x: x0, y: iy + 2 * T, w: W, h: rows * 2 * T };
  rooms.bridge = { kind: "bridge", rect: bridge };
  const consoles: Point[] = [];
  awake.forEach((c, k) => {
    const col = k % cols;
    const row = Math.floor(k / cols);
    const inRow = Math.min(cols, awake.length - row * cols);
    const cx = x0 + W / 2 + (col - (inRow - 1) / 2) * 2 * T;
    const cy = bridge.y + row * 2 * T + T * 0.55;
    consoles.push({ x: cx, y: cy });
    const envId = c.ref.env.summary.id;
    crew.push({
      key: unitKey(envId, c.thread.id),
      envId,
      threadId: c.thread.id,
      stationKey: key,
      color: teamColor(c.ref.index),
      home: { x: cx, y: cy + T * 0.85 },
      homeRoom: "bridge",
      console: { x: cx, y: cy },
      sleeping: false,
    });
  });

  // Quarters (the most recently settled crew) and the archive.
  if (bottomH) {
    const by = bridge.y + bridge.h;
    const q = { x: x0, y: by, w: quartersW * T, h: bottomH * T };
    const qDoor = { x: q.x + q.w / 2, y: by };
    rooms.quarters = { kind: "quarters", rect: q, door: qDoor };
    doors.push({ ...qDoor, vertical: false });
    asleep.forEach((c, k) => {
      const envId = c.ref.env.summary.id;
      crew.push({
        key: unitKey(envId, c.thread.id),
        envId,
        threadId: c.thread.id,
        stationKey: key,
        color: teamColor(c.ref.index),
        home: { x: q.x + T * 1.5 + k * T * 1.5, y: q.y + q.h - T / 2 },
        homeRoom: "quarters",
        sleeping: true,
      });
    });
    if (archived) {
      const ar = { x: x0 + quartersW * T, y: by, w: archiveW * T, h: bottomH * T };
      const door = { x: ar.x + ar.w / 2, y: by };
      rooms.archive = { kind: "archive", rect: ar, door };
      doors.push({ ...door, vertical: false });
      doors.push({ x: ar.x, y: by + T / 2, vertical: true });
    }
  }

  const interior = { x: x0, y: iy, w: W, h: h * T };
  const hx = interior.x - HULL_PAD;
  const hy = interior.y - HULL_PAD;
  const hw = interior.w + HULL_PAD * 2;
  const hh = interior.h + HULL_PAD * 2;
  const c = 28;
  const hull = [hx + c, hy, hx + hw - c, hy, hx + hw, hy + c, hx + hw, hy + hh - c, hx + hw - c, hy + hh, hx + c, hy + hh, hx, hy + hh - c, hx, hy + c];

  const spot = (kind: SystemRoom): Point => {
    const r = rooms[kind]!.rect;
    return { x: r.x + r.w / 2, y: r.y + r.h * 0.62 };
  };

  return {
    key,
    name: group.name,
    repo: group.repo,
    members: group.members.map((m) => ({ envId: m.env.summary.id, projectId: m.project.id })),
    interior,
    hull,
    rooms,
    doors,
    consoles,
    workstations: { terminal: spot("terminal"), files: spot("files"), comms: spot("comms") },
    archived,
    settledHidden: settled.length - asleep.length,
    port: { x: hx + hw / 2, y: hy },
    nameplate: { x: hx, y: y0 },
    bounds: { x: hx, y: y0, w: hw, h: hh + (hy - y0) },
  };
}

/**
 * Waypoints for walking between rooms. Every room opens onto the bridge, so a trip is at most:
 * out through this room's door, across the bridge, in through the target's door. Crew walk
 * axis-aligned, FTL-style.
 */
export function route(s: StationLayout, from: RoomKind, to: RoomKind, target: Point, start: Point): Point[] {
  const points: Point[] = [];
  const step = TILE * 0.45;
  if (from !== to) {
    const out = from === "bridge" ? undefined : s.rooms[from]?.door;
    const into = to === "bridge" ? undefined : s.rooms[to]?.door;
    if (out) {
      const dir = (s.rooms[from]!.rect.y < out.y ? -1 : 1) * step;
      points.push({ x: out.x, y: start.y }, { x: out.x, y: out.y + dir }, { x: out.x, y: out.y - dir });
    }
    if (into) {
      const dir = (s.rooms[to]!.rect.y < into.y ? -1 : 1) * step;
      const last = points.at(-1) ?? start;
      points.push({ x: into.x, y: last.y }, { x: into.x, y: into.y - dir }, { x: into.x, y: into.y + dir });
    }
  }
  const last = points.at(-1) ?? start;
  points.push({ x: target.x, y: last.y }, target);
  return points;
}

// ---- Fleet ----------------------------------------------------------------------------

export function computeFleetLayout(state: GameState): FleetLayout {
  const envs = sortedEnvs(state);
  const fleet: FleetLayout = { stations: new Map(), ships: new Map(), crew: new Map(), bounds: { x: 0, y: 0, w: 0, h: 0 } };
  const groups = groupProjects(envs);
  if (envs.length === 0) return fleet;

  // Stations on a roughly square grid below the fleet row, biggest first.
  const crew: CrewLayout[] = [];
  const top = SHIP_H + 20 + FLEET_GAP;
  const columns = Math.max(1, Math.ceil(Math.sqrt(groups.length)));
  let x = 0;
  let y = top;
  let rowH = 0;
  let width = 0;
  groups.forEach((group, i) => {
    if (i > 0 && i % columns === 0) {
      x = 0;
      y += rowH + STATION_GAP_Y;
      rowH = 0;
    }
    const station = layoutStation(group, x + 22, y, crew);
    fleet.stations.set(station.key, station);
    x = station.bounds.x + station.bounds.w + STATION_GAP_X;
    rowH = Math.max(rowH, station.bounds.h);
    width = Math.max(width, station.bounds.x + station.bounds.w);
  });

  // Fleet row: one ship per environment, evenly spread across the stations' width.
  const span = Math.max(width, envs.length * (SHIP_W + SHIP_GAP) - SHIP_GAP);
  const step = envs.length > 1 ? (span - SHIP_W) / (envs.length - 1) : 0;
  envs.forEach((env, index) => {
    const sx = envs.length > 1 ? index * step : span / 2 - SHIP_W / 2;
    const hull = { x: sx, y: 0, w: SHIP_W, h: SHIP_H };
    const from = { x: sx + SHIP_W / 2, y: SHIP_H + 20 + 22 };
    const links = [...fleet.stations.values()]
      .filter((s) => s.members.some((m) => m.envId === env.summary.id))
      .map((s) => ({ stationKey: s.key, from, to: s.port }));
    fleet.ships.set(env.summary.id, {
      envId: env.summary.id,
      color: teamColor(index),
      hull,
      plate: { x: sx, y: SHIP_H + 8, w: SHIP_W, h: 20 },
      links,
    });
  });

  for (const c of crew) fleet.crew.set(c.key, c);
  let bounds: Rect | undefined;
  for (const s of fleet.stations.values()) bounds = bounds ? union(bounds, s.bounds) : s.bounds;
  for (const s of fleet.ships.values()) bounds = bounds ? union(bounds, { ...s.hull, x: s.hull.x - 40, w: s.hull.w + 40, h: s.plate.y + s.plate.h }) : s.hull;
  fleet.bounds = bounds ?? { x: 0, y: 0, w: 0, h: 0 };
  return fleet;
}

/** Team color for an environment, consistent between the map and the HUD. */
export function stationColor(state: GameState, envId: string): number {
  const index = sortedEnvs(state).findIndex((e) => e.summary.id === envId);
  return teamColor(Math.max(0, index));
}
