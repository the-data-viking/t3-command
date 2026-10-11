// Orbital project campus: shared project modules around an operations hub.
// Each participating environment gets its own engine/compute node directly attached
// to the project it serves. Crew remain inside connected, door-routed project rooms.

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
  /** Rooms connected by this physical doorway. */
  rooms: [RoomKind, RoomKind];
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
  /** Side port to the operations network. */
  port: Point;
  nameplate: Point;
  bounds: Rect;
}

/** An environment service node attached to one project module. */
export interface EnvironmentNodeLayout {
  key: string;
  stationKey: string;
  projectId?: string;
  envId: string;
  color: number;
  hull: Rect;
  plate: Rect;
  /** Direct physical attachment to the owning project module. */
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
  environmentNodes: Map<string, EnvironmentNodeLayout>;
  crew: Map<string, CrewLayout>;
  bounds: Rect;
  hub?: Rect;
}

export const TILE = 32;
/** How many settled crew each station keeps aboard, most recently settled first. */
export const QUARTERS_SHOWN = 3;
const HULL_PAD = 22;
export const ENV_NODE_W = 224;
export const ENV_NODE_H = 152;
const NODE_GAP = 24;
const ATTACHMENT_GAP = 36;
const CAMPUS_GAP = 360;
const STATION_GAP_Y = 180;

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
  const W = (cols * 2 + 9) * T;
  const H = Math.max(6, rows * 2, archived ? 8 : 6) * T;
  const key = group.key;
  const rooms: Partial<Record<RoomKind, Room>> = {};
  const doors: Door[] = [];
  const iy = y0 + 70;
  const leftW = 3 * T, rightW = 6 * T;
  const bridge = { x: x0 + leftW, y: iy, w: W - leftW - rightW, h: H };
  rooms.bridge = { kind: 'bridge', rect: bridge };
  const addSide = (kind: RoomKind, rect: Rect, left: boolean) => {
    const door = { x: left ? rect.x + rect.w : rect.x, y: rect.y + rect.h / 2 };
    rooms[kind] = { kind, rect, door };
    doors.push({ ...door, vertical: true, rooms: [kind, 'bridge'] });
  };
  addSide('terminal', { x: x0, y: iy, w: leftW, h: H / 2 }, true);
  addSide('files', { x: x0, y: iy + H / 2, w: leftW, h: H / 2 }, true);
  doors.push({ x: x0 + leftW / 2, y: iy + H / 2, vertical: false, rooms: ['terminal', 'files'] });
  const rx = bridge.x + bridge.w;
  const commsH = H / 2;
  addSide('comms', { x: rx, y: iy, w: rightW, h: commsH }, false);
  const qH = archived ? (H - commsH) / 2 : H - commsH;
  const q = { x: rx, y: iy + commsH, w: rightW, h: qH };
  addSide('quarters', q, false);
  doors.push({ x: rx + rightW / 2, y: q.y, vertical: false, rooms: ['comms', 'quarters'] });
  if (archived) {
    const ar = { x: rx, y: q.y + q.h, w: rightW, h: H - commsH - qH };
    addSide('archive', ar, false);
    doors.push({ x: rx + rightW / 2, y: ar.y, vertical: false, rooms: ['quarters', 'archive'] });
  }
  const consoles: Point[] = [];
  awake.forEach((c, k) => {
    const col = k % cols, row = Math.floor(k / cols);
    const inRow = Math.min(cols, awake.length - row * cols);
    const cx = bridge.x + bridge.w / 2 + (col - (inRow - 1) / 2) * 2 * T;
    const cy = bridge.y + row * 2 * T + T * 0.9;
    consoles.push({ x: cx, y: cy });
    const envId = c.ref.env.summary.id;
    crew.push({ key: unitKey(envId, c.thread.id), envId, threadId: c.thread.id,
      stationKey: key, color: teamColor(c.ref.index), home: { x: cx, y: cy + T * 0.85 },
      homeRoom: 'bridge', console: { x: cx, y: cy }, sleeping: false });
  });
  asleep.forEach((c, k) => {
    const envId = c.ref.env.summary.id;
    crew.push({ key: unitKey(envId, c.thread.id), envId, threadId: c.thread.id,
      stationKey: key, color: teamColor(c.ref.index), home: { x: q.x + T * 1.5 + k * T * 1.5, y: q.y + q.h - T / 2 },
      homeRoom: 'quarters', sleeping: true });
  });

  const interior = { x: x0, y: iy, w: W, h: H };
  const hx = interior.x - HULL_PAD;
  const hy = interior.y - HULL_PAD;
  const hw = interior.w + HULL_PAD * 2;
  const hh = interior.h + HULL_PAD * 2;
  const c = 28;
  const hull = [hx + c, hy, hx + hw - c, hy, hx + hw, hy + c, hx + hw, hy + hh - c, hx + hw - c, hy + hh, hx + c, hy + hh, hx, hy + hh - c, hx, hy + c];

  const spot = (kind: SystemRoom): Point => {
    const r = rooms[kind]!.rect;
    // Crew stand to the right of the system sprite, feet near the bottom of the room.
    return { x: r.x + r.w * 0.66, y: r.y + r.h - 8 };
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

/** Resolve the room under a crew member's feet, including while a walk is in progress. */
export function roomAt(s: StationLayout, point: Point, fallback: RoomKind): RoomKind {
  const contains = (kind: RoomKind) => {
    const r = s.rooms[kind]?.rect;
    return r && point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h;
  };
  // Keep the current room when exactly on a shared boundary.
  if (contains(fallback)) return fallback;
  return (Object.keys(s.rooms) as RoomKind[]).find(contains) ?? fallback;
}

/** Shortest axis-aligned walk through actual doors, with a waypoint on each side. */
export function route(s: StationLayout, from: RoomKind, to: RoomKind, target: Point, start: Point): Point[] {
  from = roomAt(s, start, from);
  if (!s.rooms[from] || !s.rooms[to]) return [];
  const nodes: Array<{ point: Point; room: RoomKind; across?: number }> = [
    { point: start, room: from }, { point: target, room: to },
  ];
  for (const door of s.doors) {
    const base = nodes.length;
    if (!door.rooms.every(kind => s.rooms[kind])) continue;
    door.rooms.forEach((room, side) => {
      const r = s.rooms[room]!.rect;
      const center = door.vertical ? r.x + r.w / 2 : r.y + r.h / 2;
      const boundary = door.vertical ? door.x : door.y;
      const offset = center < boundary ? -8 : 8;
      nodes.push({
        room, across: base + 1 - side,
        point: { x: door.x + (door.vertical ? offset : 0), y: door.y + (door.vertical ? 0 : offset) },
      });
    });
  }
  const distance = nodes.map(() => Infinity);
  const previous = nodes.map(() => -1);
  const visited = new Set<number>();
  distance[0] = 0;
  while (visited.size < nodes.length) {
    let current = -1;
    nodes.forEach((_, i) => {
      if (!visited.has(i) && (current === -1 || distance[i] < distance[current])) current = i;
    });
    if (current === -1 || !Number.isFinite(distance[current])) return [];
    if (current === 1) break;
    visited.add(current);
    const node = nodes[current];
    nodes.forEach((next, i) => {
      if (visited.has(i) || (next.room !== node.room && node.across !== i)) return;
      const cost = Math.abs(next.point.x - node.point.x) + Math.abs(next.point.y - node.point.y);
      if (distance[current] + cost < distance[i]) {
        distance[i] = distance[current] + cost;
        previous[i] = current;
      }
    });
  }
  const chain: number[] = [];
  for (let i = 1; i !== 0; i = previous[i]) {
    if (i < 0) return [];
    chain.unshift(i);
  }
  const points: Point[] = [];
  let last = start;
  for (const i of chain) {
    const point = nodes[i].point;
    if (point.x !== last.x && point.y !== last.y) points.push({ x: point.x, y: last.y });
    if (point.x !== last.x || point.y !== last.y) points.push({ ...point });
    last = point;
  }
  return points;
}

// ---- Fleet ----------------------------------------------------------------------------

export function computeFleetLayout(state: GameState): FleetLayout {
  const envs = sortedEnvs(state);
  const fleet: FleetLayout = { stations: new Map(), environmentNodes: new Map(), crew: new Map(), bounds: { x: 0, y: 0, w: 0, h: 0 } };
  const groups = groupProjects(envs);
  if (envs.length === 0) return fleet;

  const crew: CrewLayout[] = [];
  const previews = groups.map(group => layoutStation(group, HULL_PAD, 0, []));
  const extent = (station: StationLayout) => Math.max(station.bounds.w,
    new Set(station.members.map(m => m.envId)).size * (ENV_NODE_W + NODE_GAP) - NODE_GAP);
  const columnW = Math.max(ENV_NODE_W, ...previews.map(extent));
  let y = 0, rowH = 0;
  groups.forEach((group, i) => {
    if (i > 0 && i % 2 === 0) { y += rowH + STATION_GAP_Y; rowH = 0; }
    const x = (i % 2) * (columnW + CAMPUS_GAP);
    const station = layoutStation(group, x + HULL_PAD, y, crew);
    station.port = { x: i % 2 === 0 ? station.bounds.x + station.bounds.w : station.bounds.x,
      y: station.interior.y + station.interior.h / 2 };
    fleet.stations.set(station.key, station);
    const unique = [...new Map(group.members.map(m => [m.env.summary.id, m])).values()];
    unique.forEach((ref, k) => {
      const nodeX = x + k * (ENV_NODE_W + NODE_GAP);
      const nodeY = station.bounds.y + station.bounds.h + ATTACHMENT_GAP;
      const from = { x: nodeX + ENV_NODE_W / 2, y: nodeY };
      const to = { x: station.interior.x + station.interior.w * (k + 1) / (unique.length + 1),
        y: station.bounds.y + station.bounds.h };
      const key = `${ref.env.summary.id}|${station.key}`;
      fleet.environmentNodes.set(key, { key, stationKey: station.key, projectId: ref.project.id,
        envId: ref.env.summary.id, color: teamColor(ref.index),
        hull: { x: nodeX, y: nodeY, w: ENV_NODE_W, h: ENV_NODE_H },
        plate: { x: nodeX + 8, y: nodeY + ENV_NODE_H - 26, w: ENV_NODE_W - 16, h: 20 },
        links: [{ stationKey: station.key, from, to }] });
    });
    rowH = Math.max(rowH, station.bounds.h + ATTACHMENT_GAP + ENV_NODE_H);
  });
  // Environments without projects still get a selectable service node.
  let emptyY = y + rowH + STATION_GAP_Y;
  envs.forEach((env, index) => {
    if (groups.some(g => g.members.some(m => m.env === env))) return;
    const key = `${env.summary.id}|unassigned`;
    fleet.environmentNodes.set(key, { key, stationKey: '', envId: env.summary.id, color: teamColor(index),
      hull: { x: 0, y: emptyY, w: ENV_NODE_W, h: ENV_NODE_H },
      plate: { x: 8, y: emptyY + ENV_NODE_H - 26, w: ENV_NODE_W - 16, h: 20 }, links: [] });
    emptyY += ENV_NODE_H + NODE_GAP;
  });
  if (groups.length > 1) fleet.hub = { x: columnW + CAMPUS_GAP / 2 - 70,
    y: (y + rowH) / 2 - 40, w: 140, h: 80 };

  for (const c of crew) fleet.crew.set(c.key, c);
  let bounds: Rect | undefined;
  for (const s of fleet.stations.values()) bounds = bounds ? union(bounds, s.bounds) : s.bounds;
  for (const s of fleet.environmentNodes.values()) bounds = bounds ? union(bounds, { ...s.hull, x: s.hull.x - 40, w: s.hull.w + 40, h: s.hull.h }) : s.hull;
  if (fleet.hub) bounds = bounds ? union(bounds, fleet.hub) : fleet.hub;
  fleet.bounds = bounds ?? { x: 0, y: 0, w: 0, h: 0 };
  return fleet;
}

/** Team color for an environment, consistent between the map and the HUD. */
export function stationColor(state: GameState, envId: string): number {
  const index = sortedEnvs(state).findIndex((e) => e.summary.id === envId);
  return teamColor(Math.max(0, index));
}
