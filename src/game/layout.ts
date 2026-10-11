// Fleet layout: pure geometry computed from the game store. No rendering here.
//
// Every project is a station, shared by every environment that works on it (matched by git
// identity). Crew from all those environments work side by side in the station's rooms;
// each environment is a ship docked to the station, and its crew wear its team color.
//
//   ┌──────────┬──────────┬──────────┐
//   │ TERMINAL │  FILES   │  COMMS   │   systems row: crew walk here for real tool calls
//   ├────■─────┴────■─────┴────■─────┤   ■ = doors to the bridge
//   │  BRIDGE   one console per awake crew member, from any environment
//   ├──────■──────────────────┬──■───┤
//   │ QUARTERS  bunks         │ARCHIVE│
//   └─────────────────────────┴──────┘
//        ║            ║            ║      airlocks
//    [ship A]     [ship B]     [ship C]   one docked ship per environment

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

/** One environment's ship, docked at a project station. Panels call this a "bay". */
export interface DockLayout {
  key: string; // envId:projectId
  envId: string;
  projectId: string;
  stationKey: string;
  color: number; // team color
  hull: Rect;
  /** Airlock tube from the ship up to the station. */
  airlock: [Point, Point];
  plate: Rect;
}

/** One project station. */
export interface StationLayout {
  key: string;
  name: string;
  /** "github.com/owner/repo" when T3 identified the repository. */
  repo?: string;
  interior: Rect;
  hull: number[]; // outline polygon
  rooms: Partial<Record<RoomKind, Room>>;
  doors: Door[];
  consoles: Point[];
  workstations: Record<SystemRoom, Point>;
  archived: number;
  docks: string[];
  nameplate: Point;
  bounds: Rect;
}

export interface CrewLayout {
  key: string;
  envId: string;
  threadId: string;
  stationKey: string;
  dockKey: string;
  /** Seat in front of the console, or bunk. */
  home: Point;
  homeRoom: RoomKind;
  console?: Point;
  sleeping: boolean;
}

export interface FleetLayout {
  stations: Map<string, StationLayout>;
  docks: Map<string, DockLayout>;
  crew: Map<string, CrewLayout>;
  bounds: Rect;
}

export const TILE = 32;
const HULL_PAD = 22;
const SHIP_W = 150;
const SHIP_H = 54;
const SHIP_GAP = 26;
const AIRLOCK = 46;
const STATION_GAP_X = 220;
const STATION_GAP_Y = 160;

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

// ---- Stations -------------------------------------------------------------------------

interface CrewRef {
  ref: ProjectRef;
  thread: ThreadShell;
}

function layoutStation(group: ProjectGroup, x0: number, y0: number, crew: CrewLayout[]): { station: StationLayout; docks: DockLayout[] } {
  const T = TILE;
  const all: CrewRef[] = group.members.flatMap((ref) =>
    Object.values(ref.env.threads)
      .filter((t) => t.projectId === ref.project.id)
      .map((thread) => ({ ref, thread })),
  );
  const byAge = (a: CrewRef, b: CrewRef) => a.thread.createdAt.localeCompare(b.thread.createdAt);
  const awake = all.filter((c) => !isHistory(c.thread) && unitState(c.thread) !== "sleeping").sort(byAge);
  const asleep = all.filter((c) => !isHistory(c.thread) && unitState(c.thread) === "sleeping").sort(byAge);
  const archived = all.filter((c) => isHistory(c.thread)).length;

  // Size the station for its crew and its docked ships.
  const cols = Math.min(6, Math.max(3, Math.ceil(Math.sqrt(awake.length * 1.5))));
  const rows = Math.max(1, Math.ceil(awake.length / cols));
  const dockSpan = group.members.length * SHIP_W + (group.members.length - 1) * SHIP_GAP;
  const archiveW = archived ? 2 : 0;
  let w = Math.max(9, cols * 2, Math.ceil((dockSpan - 2 * HULL_PAD) / T));
  if (asleep.length) w = Math.max(w, archiveW + 3);
  const quartersW = asleep.length ? w - archiveW : 0;
  const bottomH = asleep.length || archived ? Math.max(asleep.length ? Math.ceil(asleep.length / quartersW) : 1, archived ? 2 : 1) : 0;
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
      dockKey: `${envId}:${c.ref.project.id}`,
      home: { x: cx, y: cy + T * 0.85 },
      homeRoom: "bridge",
      console: { x: cx, y: cy },
      sleeping: false,
    });
  });

  // Quarters and archive.
  if (bottomH) {
    const by = bridge.y + bridge.h;
    if (quartersW) {
      const q = { x: x0, y: by, w: quartersW * T, h: bottomH * T };
      const door = { x: q.x + q.w / 2, y: by };
      rooms.quarters = { kind: "quarters", rect: q, door };
      doors.push({ ...door, vertical: false });
      asleep.forEach((c, k) => {
        const envId = c.ref.env.summary.id;
        crew.push({
          key: unitKey(envId, c.thread.id),
          envId,
          threadId: c.thread.id,
          stationKey: key,
          dockKey: `${envId}:${c.ref.project.id}`,
          home: { x: q.x + (k % quartersW) * T + T / 2, y: q.y + Math.floor(k / quartersW) * T + T / 2 },
          homeRoom: "quarters",
          sleeping: true,
        });
      });
    }
    if (archived) {
      const ar = { x: x0 + quartersW * T, y: by, w: (w - quartersW) * T, h: bottomH * T };
      const door = { x: ar.x + ar.w / 2, y: by };
      rooms.archive = { kind: "archive", rect: ar, door };
      doors.push({ ...door, vertical: false });
      if (quartersW) doors.push({ x: ar.x, y: by + T / 2, vertical: true });
    }
  }

  const interior = { x: x0, y: iy, w: W, h: h * T };
  // Station hull: a chamfered box (no engines; it doesn't go anywhere).
  const hx = interior.x - HULL_PAD;
  const hy = interior.y - HULL_PAD;
  const hw = interior.w + HULL_PAD * 2;
  const hh = interior.h + HULL_PAD * 2;
  const c = 28;
  const hull = [hx + c, hy, hx + hw - c, hy, hx + hw, hy + c, hx + hw, hy + hh - c, hx + hw - c, hy + hh, hx + c, hy + hh, hx, hy + hh - c, hx, hy + c];

  // Docked ships hang below the station, one per environment.
  const docks: DockLayout[] = [];
  const shipTop = hy + hh + AIRLOCK;
  const startX = interior.x + interior.w / 2 - dockSpan / 2;
  group.members.forEach((ref, i) => {
    const sx = startX + i * (SHIP_W + SHIP_GAP);
    const hullRect = { x: sx, y: shipTop, w: SHIP_W, h: SHIP_H };
    const port = sx + SHIP_W / 2;
    docks.push({
      key: `${ref.env.summary.id}:${ref.project.id}`,
      envId: ref.env.summary.id,
      projectId: ref.project.id,
      stationKey: key,
      color: teamColor(ref.index),
      hull: hullRect,
      airlock: [{ x: port, y: hy + hh }, { x: port, y: shipTop }],
      plate: { x: sx, y: shipTop + SHIP_H + 8, w: SHIP_W, h: 20 },
    });
  });

  const spot = (kind: SystemRoom): Point => {
    const r = rooms[kind]!.rect;
    return { x: r.x + r.w / 2, y: r.y + r.h * 0.62 };
  };
  let bounds: Rect = { x: hx, y: y0, w: hw, h: hh + (hy - y0) };
  for (const d of docks) bounds = union(bounds, { x: d.hull.x, y: d.hull.y, w: d.hull.w, h: d.plate.y + d.plate.h - d.hull.y });

  return {
    station: {
      key,
      name: group.name,
      repo: group.repo,
      interior,
      hull,
      rooms,
      doors,
      consoles,
      workstations: { terminal: spot("terminal"), files: spot("files"), comms: spot("comms") },
      archived,
      docks: docks.map((d) => d.key),
      nameplate: { x: hx, y: y0 },
      bounds,
    },
    docks,
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
  const fleet: FleetLayout = { stations: new Map(), docks: new Map(), crew: new Map(), bounds: { x: 0, y: 0, w: 0, h: 0 } };
  const groups = groupProjects(envs);
  if (groups.length === 0) return fleet;

  // Stations on a roughly square grid, biggest first, each row as tall as its tallest station.
  const crew: CrewLayout[] = [];
  const columns = Math.ceil(Math.sqrt(groups.length));
  let x = 0;
  let y = 0;
  let rowH = 0;
  groups.forEach((group, i) => {
    if (i > 0 && i % columns === 0) {
      x = 0;
      y += rowH + STATION_GAP_Y;
      rowH = 0;
    }
    const { station, docks } = layoutStation(group, x, y, crew);
    // Shift right so the bounds (which may include wide docks) start at x.
    const dx = x - station.bounds.x;
    if (dx !== 0) {
      // Re-run at the corrected origin; cheap and keeps the geometry code simple.
      crew.splice(crew.length - crew.filter((c) => c.stationKey === station.key).length);
      const again = layoutStation(group, x + dx, y, crew);
      fleet.stations.set(again.station.key, again.station);
      for (const d of again.docks) fleet.docks.set(d.key, d);
      x = again.station.bounds.x + again.station.bounds.w + STATION_GAP_X;
      rowH = Math.max(rowH, again.station.bounds.h);
    } else {
      fleet.stations.set(station.key, station);
      for (const d of docks) fleet.docks.set(d.key, d);
      x = station.bounds.x + station.bounds.w + STATION_GAP_X;
      rowH = Math.max(rowH, station.bounds.h);
    }
  });

  for (const c of crew) fleet.crew.set(c.key, c);
  let bounds: Rect | undefined;
  for (const s of fleet.stations.values()) bounds = bounds ? union(bounds, s.bounds) : s.bounds;
  fleet.bounds = bounds ?? { x: 0, y: 0, w: 0, h: 0 };
  return fleet;
}

/** Team color for an environment, consistent between the map and the HUD. */
export function stationColor(state: GameState, envId: string): number {
  const index = sortedEnvs(state).findIndex((e) => e.summary.id === envId);
  return teamColor(Math.max(0, index));
}
