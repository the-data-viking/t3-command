// The fleet as a ship: the Hermes hall (or an operations hub) on top, the machines' engineering
// decks hanging from its spine in a keel, and project modules in wings below, each machine's
// supply lines running down a bus and along corridors to the projects it serves. Crew remain
// inside connected, door-routed project rooms;
// scratch crew (work not tied to a project) stand in their machine's engineering bay.

import { dockedPrs, stationMemory } from "./memory";
import type { EnvWorld, GameState } from "../store";
import { unitKey } from "../store";
import { isHistory, unitState } from "../t3/derive";
import { isScratch, scratchProject } from "../t3/scratch";
import type { ProjectShell, ThreadShell } from "../t3/types";
import { teamColor } from "./theme";
import { botOperators, type BotOperator } from '../t3/bots';

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

/** Centre x of a system room's fixture (terminal, file bank, comms), against the room's left side. */
export function systemFixtureX(room: Rect): number {
  return Math.round((room.x + room.w * 0.3) / 2) * 2;
}
/** Half the width of a system fixture (24 art px at 2 world px each). */
export const SYSTEM_FIXTURE_HALF = 24;

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

/** One station-wide engineering node per environment, serving all its projects. */
export interface EnvironmentNodeLayout {
  key: string;
  envId: string;
  color: number;
  hull: Rect;
  plate: Rect;
  /** Direct physical connections to every project served by this environment. */
  links: Array<{ stationKey: string; from: Point; to: Point; via?: Point[] }>;
  /** Standing room for this machine's scratch crew; always drawn, lit only while crewed. */
  bay: Rect;
  /** Where the docking hatch on its roof sits: under the Hermes hall's collar, else centred. */
  hatchX: number;
  /** The machine's scratch project, once it has one. */
  scratch?: {
    projectId: string;
    /** Key of the bay's one-room station in `FleetLayout.bays`. */
    stationKey: string;
    /** Awake scratch threads beyond the bay's standing room, not drawn on the map. */
    overflow: string[];
  };
}

export interface CrewLayout {
  key: string;
  envId: string;
  threadId: string;
  stationKey: string;
  color: number; // team color
  /** Seat in front of the console, or cryo pod. */
  home: Point;
  homeRoom: RoomKind;
  console?: Point;
  sleeping: boolean;
}

export interface FleetLayout {
  controlCenter?: ControlCenterLayout;
  stations: Map<string, StationLayout>;
  /** Engineering bays as one-room stations, so their crew place and move like everyone else. */
  bays: Map<string, StationLayout>;
  environmentNodes: Map<string, EnvironmentNodeLayout>;
  crew: Map<string, CrewLayout>;
  bounds: Rect;
  hub?: Rect;
  /** The cable runs supply lines share, as overlapping rects: one band per bus lane, and each
   * corridor narrowing as its lines turn off. Drawn as one casing under the lines. */
  trunks: Rect[];
}

export interface ControlCenterLayout {
  envId: string;
  envIds: string[];
  hull: Rect;
  /** The bridge and its docked engineering modules, for camera framing. */
  bounds: Rect;
  operators: Array<{ bot: BotOperator; workstation: Rect }>;
  links: Array<{ envId: string; from: Point; to: Point; laneX: number }>;
  /**
   * The keel's spine: a stem down from the hall and a beam along the top deck row, from which
   * each deck's collar drops, so a hall sized to its operators still reaches every deck.
   */
  manifold?: { stemX: number; top: number; y: number; x0: number; x1: number };
}

export const TILE = 32;
/** How many settled crew each station keeps aboard, most recently settled first. */
export const QUARTERS_SHOWN = 3;
const HULL_PAD = 22;
export const ENV_NODE_W = 288;
export const ENV_NODE_H = 152;
/** The engineering bay inside a node (relative to its hull); matches the deck sprite's bay. */
export const ENV_BAY = { x: 222, y: 30, w: 56, h: 88 };
/** Scratch crew standing in a bay at once; the rest are counted on the bay wall. */
export const BAY_SHOWN = 2;
const NODE_GAP = 24;
/** Height of a row of Hermes operator bays (console, chair, name and status). */
const HERMES_BAY_PITCH = 124;
/** The Hermes hall is sized to its operators: a header band, their bays, and the archive and
 * routines beside them. It never spans the docks below; their collars meet it where it is. */
export const HALL_HEAD = 86;
const HALL_FOOT = 14;
const HALL_SIDE = 140;
const HALL_MIN_W = 600;
export const OPERATOR_PITCH = 166;
/**
 * The fleet is a ship: a keel of engineering decks (one row of up to six, under the Hermes hall),
 * a bus beneath it with one lane per machine, and wings of stations below: two columns around a
 * service corridor that carries the supply lines. Every line runs deck → its bus lane → its
 * corridor lane → the station's port, so lines only cross where they drop from the decks.
 */
export const DOCKS_PER_ROW = 6;
/** The corridor between a wing's two station columns (the lines' lanes run down its middle). */
export const CORRIDOR_W = 160;
const WING_GAP = 96;
/** One supply-line lane per machine, this far apart on the bus and in each corridor. */
export const LANE = 8;
/** From the deck row to the first bus lane, and from the last lane to the first station row. */
const BUS_TOP = 28;
const BUS_TO_STATIONS = 40;
/** Between station rows. */
const STATION_GAP_Y = 96;
/** From the Hermes hall down to the deck row (the manifold runs in this gap). */
const HALL_TO_DECKS = 48;

/** Wings of two columns by project count: one up to 4 projects, two up to 24, then three. */
export function wingCount(projects: number): number {
  return projects <= 4 ? 1 : projects <= 24 ? 2 : 3;
}

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
    // Hermes owns persistent operators, never a repository-defined project module.
    if (env.summary.kind === 'hermes') return;
    for (const project of Object.values(env.projects)) {
      // Scratch work belongs to the machine, so it lives in the engineering bay instead.
      if (isScratch(project)) continue;
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
    // Crew stand right at the system's fixture, on its right side, feet near the bottom of the room.
    return { x: systemFixtureX(r) + SYSTEM_FIXTURE_HALF + 12, y: r.y + r.h - 8 };
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

// ---- Engineering bays ----------------------------------------------------------------

/** A bay as a one-room station: no doors or system rooms, so its crew simply stand in place. */
function layoutBay(env: EnvWorld, index: number, projectId: string, rect: Rect, crew: CrewLayout[]): { station: StationLayout; overflow: string[] } {
  const envId = env.summary.id;
  const key = `bay:${envId}`;
  const awake = Object.values(env.threads)
    .filter((t) => t.projectId === projectId && !isHistory(t) && unitState(t) !== "sleeping")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const shown = awake.slice(0, BAY_SHOWN);
  const feet = rect.y + rect.h - 6;
  shown.forEach((thread, k) => {
    const home = { x: rect.x + rect.w * (shown.length === 1 ? 0.5 : k === 0 ? 0.26 : 0.76), y: feet };
    crew.push({ key: unitKey(envId, thread.id), envId, threadId: thread.id, stationKey: key, color: teamColor(index),
      home, homeRoom: "bridge", sleeping: false });
  });
  const center = { x: rect.x + rect.w / 2, y: feet };
  const station: StationLayout = {
    key, name: "Scratch", members: [{ envId, projectId }], interior: rect, hull: [],
    rooms: { bridge: { kind: "bridge", rect } }, doors: [], consoles: [],
    workstations: { terminal: center, files: center, comms: center },
    archived: 0, settledHidden: 0, port: center, nameplate: { x: rect.x, y: rect.y }, bounds: rect,
  };
  return { station, overflow: awake.slice(BAY_SHOWN).map((t) => t.id) };
}

// ---- Fleet ----------------------------------------------------------------------------

/**
 * Rebuilding a facility destroys and recreates all of its Graphics, sprites and text. Shell
 * updates arrive for every streamed thread change, so sprites rebuild only when a fingerprint of
 * exactly what they draw changes; live details (screens, meters, crew) update in place.
 */
export const fingerprint = (...parts: unknown[]): string => JSON.stringify(parts);

/** Everything a project facility draws: its geometry, nameplate and the art style. */
export function stationDrawKey(state: GameState, s: StationLayout): string {
  return fingerprint(state.artStyle, s, state.envs[s.members[0]?.envId ?? ""]?.summary.label, stationMemory(state, s), dockedPrs(state, s));
}

/** Everything an engineering chassis draws; host meters update separately. */
export function nodeDrawKey(state: GameState, node: EnvironmentNodeLayout): string {
  return fingerprint(state.artStyle, node, state.envs[node.envId]?.summary.label);
}

/** Casing either side of a line inside a trunk. */
const TRUNK_PAD = 6;
const snapRect = (x: number, y: number, w: number, h: number): Rect => {
  const x0 = Math.round(x / 2) * 2, y0 = Math.round(y / 2) * 2;
  return { x: x0, y: y0, w: Math.round((x + w) / 2) * 2 - x0, h: Math.round((y + h) / 2) * 2 - y0 };
};

type BusLine = { drop: number; downs: number[]; lo: number; hi: number };

/** Crossings if `below`'s lane sits under `above`'s: its drop through `above`'s lane, and
 * `above`'s corridor lines down through its own. */
function laneCost(below: BusLine, above: BusLine): number {
  const inside = (x: number, line: BusLine) => x > line.lo && x < line.hi;
  return (inside(below.drop, above) ? 1 : 0) + above.downs.filter(x => inside(x, below)).length;
}

/** Bus lane order (top first) with fewest crossings: exhaustive for a small fleet, then greedy
 * insertion, which is what a larger one gets. */
export function orderLanes(lines: BusLine[]): number[] {
  const n = lines.length;
  const cost = lines.map((below, b) => lines.map((above, a) => a === b ? 0 : laneCost(below, above)));
  const total = (order: number[]) => {
    let sum = 0;
    for (let i = 0; i < order.length; i++) for (let j = i + 1; j < order.length; j++) sum += cost[order[j]][order[i]];
    return sum;
  };
  if (n <= 7) {
    let best = [...lines.keys()];
    let bestCost = total(best);
    const permute = (prefix: number[], rest: number[]) => {
      if (!rest.length) { const c = total(prefix); if (c < bestCost) { bestCost = c; best = prefix; } return; }
      rest.forEach((r, i) => permute([...prefix, r], [...rest.slice(0, i), ...rest.slice(i + 1)]));
    };
    permute([], [...lines.keys()]);
    return best;
  }
  const order: number[] = [];
  for (const line of lines.keys()) {
    let at = 0, bestCost = Infinity;
    for (let i = 0; i <= order.length; i++) {
      const c = total([...order.slice(0, i), line, ...order.slice(i)]);
      if (c < bestCost) { bestCost = c; at = i; }
    }
    order.splice(at, 0, line);
  }
  return order;
}

export function computeFleetLayout(state: GameState): FleetLayout {
  const envs = sortedEnvs(state);
  const hermes = envs.filter(env => env.summary.kind === 'hermes');
  const engineering = envs.filter(env => env.summary.kind !== 'hermes');
  const operators = hermes.length ? botOperators(state) : [];
  const fleet: FleetLayout = { stations: new Map(), bays: new Map(), environmentNodes: new Map(), crew: new Map(), bounds: { x: 0, y: 0, w: 0, h: 0 }, trunks: [] };
  const groups = groupProjects(envs);
  if (envs.length === 0) return fleet;
  const crew: CrewLayout[] = [];

  // The keel: decks in rows of up to six, every row on the same columns, centred on x = 0.
  const machines = engineering.length;
  const perRow = Math.min(DOCKS_PER_ROW, Math.max(1, machines));
  const deckRows = Math.ceil(machines / perRow);
  const rowW = perRow * ENV_NODE_W + (perRow - 1) * NODE_GAP;
  const deckAt = (i: number): Rect => ({ x: -rowW / 2 + (i % perRow) * (ENV_NODE_W + NODE_GAP), y: Math.floor(i / perRow) * (ENV_NODE_H + NODE_GAP), w: ENV_NODE_W, h: ENV_NODE_H });
  const decksBottom = machines ? deckRows * (ENV_NODE_H + NODE_GAP) - NODE_GAP : 0;
  const laneY = (k: number) => decksBottom + BUS_TOP + k * LANE;
  const stationsTop = laneY(Math.max(0, machines - 1)) + BUS_TO_STATIONS;
  const machineIndex = new Map(engineering.map((env, i) => [env.summary.id, i]));
  const deckCentre = (envId: string) => { const i = machineIndex.get(envId); return i === undefined ? 0 : deckAt(i).x + ENV_NODE_W / 2; };

  // The wings: two columns around a corridor each, centred under the keel.
  const previews = groups.map(group => layoutStation(group, HULL_PAD, 0, []));
  const colW = Math.max(ENV_NODE_W, ...previews.map(station => station.bounds.w));
  const wings = wingCount(groups.length);
  const wingW = 2 * colW + CORRIDOR_W;
  const totalW = wings * wingW + (wings - 1) * WING_GAP;
  const wingCentre = (w: number) => -totalW / 2 + wingW / 2 + w * (wingW + WING_GAP);
  type Slot = { wing: number; side: "left" | "right" | "centre" };
  const slotX = (s: Slot) => s.side === "centre" ? 0 : wingCentre(s.wing) + (s.side === "left" ? -1 : 1) * (CORRIDOR_W / 2 + colW / 2);
  // Fill row by row; each station takes the free slot in its row nearest the machines that serve
  // it (shared stations come first, so they sit up top), so lines run short.
  const rows: Array<Array<{ index: number; slot: Slot }>> = [];
  groups.forEach((group, index) => {
    const perRowSlots = 2 * wings;
    if (!rows.length || rows[rows.length - 1].length >= perRowSlots) rows.push([]);
    const row = rows[rows.length - 1];
    const ids = [...new Set(group.members.map(m => m.env.summary.id))];
    const want = ids.reduce((sum, id) => sum + deckCentre(id), 0) / Math.max(1, ids.length);
    const free: Slot[] = [];
    for (let w = 0; w < wings; w++) for (const side of ["left", "right"] as const) if (!row.some(r => r.slot.wing === w && r.slot.side === side)) free.push({ wing: w, side });
    free.sort((a, b) => Math.abs(slotX(a) - want) - Math.abs(slotX(b) - want));
    row.push({ index, slot: free[0] });
  });
  // A lone station in a one-wing last row sits on the axis, under the keel.
  const last = rows[rows.length - 1];
  if (wings === 1 && last?.length === 1) last[0].slot = { wing: 0, side: "centre" };

  let y = stationsTop;
  const placed = new Map<string, Slot>();
  // The open space above each station's row: from the bus, or the row above, to its top.
  const ceiling = new Map<string, number>();
  let above = laneY(Math.max(0, machines - 1));
  for (const row of rows) {
    let rowH = 0;
    for (const { index, slot } of row) {
      const w = previews[index].bounds.w;
      const x = slot.side === "left" ? wingCentre(slot.wing) - CORRIDOR_W / 2 - w : slot.side === "right" ? wingCentre(slot.wing) + CORRIDOR_W / 2 : -w / 2;
      const station = layoutStation(groups[index], x + HULL_PAD, y, crew);
      // The port faces the corridor; a station on the axis takes it on its left side.
      station.port = { x: slot.side === "left" ? station.bounds.x + station.bounds.w : station.bounds.x, y: station.interior.y + station.interior.h / 2 };
      fleet.stations.set(station.key, station);
      placed.set(station.key, slot);
      ceiling.set(station.key, above);
      rowH = Math.max(rowH, station.bounds.h);
    }
    above = y + rowH;
    y += rowH + STATION_GAP_Y;
  }

  // Corridor lanes, one per supply line, packed about the corridor's middle: lines to the left
  // column on its left, lines to the right on its right, the shallowest port outermost, so no line turns off
  // across another still heading deeper. Into one port, the outer line takes the upper berth;
  // round the axis station it is the other way, as the lines wrap its far side. (Lines cross
  // only on the bus, like interchanges.)
  const corridorLane = new Map<string, number>();
  const centreRank = new Map<string, { n: number; of: number }>();
  for (let w = 0; w < wings; w++) {
    for (const goingLeft of [true, false]) {
      const lines: Array<{ key: string; depth: number; order: number }> = [];
      for (const station of fleet.stations.values()) {
        const slot = placed.get(station.key)!;
        if (slot.wing !== w || (slot.side === "right") === goingLeft) continue;
        const members = [...new Set(station.members.map(m => m.envId))];
        members.forEach((envId, m) => lines.push({ key: `${envId}|${station.key}`, depth: station.port.y, order: slot.side === "centre" ? -m : m }));
        if (slot.side === "centre") members.forEach((envId, m) => centreRank.set(`${envId}|${station.key}`, { n: members.length - 1 - m, of: members.length }));
      }
      lines.sort((a, b) => a.depth - b.depth || a.order - b.order);
      const room = CORRIDOR_W / 2 - 16;
      const pitch = Math.min(LANE, room / Math.max(1, lines.length));
      lines.forEach((line, n) => corridorLane.set(line.key, wingCentre(w) + (goingLeft ? -1 : 1) * (4 + (lines.length - 1 - n) * pitch)));
    }
  }

  // Bus lanes: each machine's drop comes down to its lane and its lines leave it down their
  // corridors, so every lane a drop or a corridor line passes through is a crossing. Stack the
  // lanes in the order that makes fewest.
  const dropX = (index: number) => {
    const deck = deckAt(index);
    return Math.floor(index / perRow) < deckRows - 1
      ? deck.x + ENV_NODE_W + NODE_GAP / 2 + (Math.floor(index / perRow) - (deckRows - 2) / 2) * 6
      : deck.x + ENV_NODE_W / 2;
  };
  const busLines = engineering.map((env, index) => {
    const id = env.summary.id;
    const downs = [...fleet.stations.values()].filter(s => s.members.some(m => m.envId === id)).map(s => corridorLane.get(`${id}|${s.key}`)!);
    const xs = [dropX(index), ...downs];
    return { drop: dropX(index), downs, lo: Math.min(...xs), hi: Math.max(...xs) };
  });
  const busLane = new Map<string, number>();
  orderLanes(busLines).forEach((index, k) => busLane.set(engineering[index].summary.id, k));

  // The Hermes hall, sized to its operators, centred over the keel.
  const columns = Math.min(4, Math.max(1, operators.length));
  const bridgeW = Math.max(HALL_MIN_W, columns * OPERATOR_PITCH - 8 + 2 * HALL_SIDE);
  // Header, a row of seated operator bays per four operators, and a thin foot.
  const bridgeH = HALL_HEAD + Math.max(1, Math.ceil(operators.length / 4)) * HERMES_BAY_PITCH + HALL_FOOT;
  const bridge = { x: -bridgeW / 2, y: -HALL_TO_DECKS - bridgeH, w: bridgeW, h: bridgeH };

  engineering.forEach((env, index) => {
    const key = env.summary.id;
    const deck = deckAt(index);
    const { x, y: nodeY } = deck;
    const row = Math.floor(index / perRow);
    const k = busLane.get(key) ?? index;
    const busY = laneY(k);
    const projects = [...fleet.stations.values()].filter(station => station.members.some(m => m.envId === key));
    // This machine's band of the bus trunk, under its run from its drop to its farthest corridor.
    if (projects.length) fleet.trunks.push(snapRect(busLines[index].lo - TRUNK_PAD, busY - TRUNK_PAD, busLines[index].hi - busLines[index].lo + 2 * TRUNK_PAD, 2 * TRUNK_PAD));
    const links = projects.map(station => {
      const slot = placed.get(station.key)!;
      const members = [...new Set(station.members.map(m => m.envId))];
      const offset = (members.indexOf(key) - (members.length - 1) / 2) * 12;
      const from = { x: x + ENV_NODE_W / 2, y: nodeY + ENV_NODE_H };
      const via: Point[] = [];
      // Down from the deck to its own bus lane: straight from the bottom row, through the gap
      // beside it from a row above (its column's gaps line up all the way down).
      if (row < deckRows - 1) {
        const gapY = nodeY + ENV_NODE_H + NODE_GAP / 2;
        const gapX = dropX(index);
        via.push({ x: from.x, y: gapY }, { x: gapX, y: gapY }, { x: gapX, y: busY });
      } else via.push({ x: from.x, y: busY });
      // Along the bus to this line's lane in the station's corridor, and down it.
      const corridorX = Math.round(corridorLane.get(`${key}|${station.key}`)! / 2) * 2;
      const portY = station.port.y + offset;
      via.push({ x: corridorX, y: busY });
      if (slot.side === "centre") {
        // Round the axis station's left side: out of the corridor in the gap above its row.
        const { n, of } = centreRank.get(`${key}|${station.key}`)!;
        const top = ceiling.get(station.key)!, gap = station.bounds.y - top;
        const pitch = Math.min(LANE, (gap - 16) / Math.max(1, of));
        const turnY = Math.round((top + gap / 2 + (n - (of - 1) / 2) * pitch) / 2) * 2;
        const sideX = station.bounds.x - 24 - (of - 1 - n) * LANE;
        via.push({ x: corridorX, y: turnY }, { x: sideX, y: turnY }, { x: sideX, y: portY });
      } else via.push({ x: corridorX, y: portY });
      // The corridor trunk holds this line from the bus to where it turns off, out to the middle.
      const mid = wingCentre(slot.wing);
      const exitY = slot.side === "centre" ? via[via.length - 2].y : portY;
      const left = Math.min(corridorX - TRUNK_PAD, mid - 2), right = Math.max(corridorX + TRUNK_PAD, mid + 2);
      fleet.trunks.push(snapRect(left, laneY(0) - TRUNK_PAD, right - left, exitY - laneY(0) + 2 * TRUNK_PAD));
      return { stationKey: station.key, from, to: { x: station.port.x, y: portY }, via };
    });
    const bay = { x: x + ENV_BAY.x, y: nodeY + ENV_BAY.y, w: ENV_BAY.w, h: ENV_BAY.h };
    const scratch = scratchProject(env);
    let bayCrew: EnvironmentNodeLayout["scratch"];
    if (scratch) {
      const { station, overflow } = layoutBay(env, envs.indexOf(env), scratch.id, bay, crew);
      fleet.bays.set(station.key, station);
      bayCrew = { projectId: scratch.id, stationKey: station.key, overflow };
    }
    fleet.environmentNodes.set(key, { key, envId: key, color: stationColor(state, key),
      hull: deck,
      plate: { x: x + 8, y: nodeY + ENV_NODE_H - 26, w: ENV_NODE_W - 16, h: 20 }, links, bay, hatchX: x + ENV_NODE_W / 2,
      ...(bayCrew ? { scratch: bayCrew } : {}) });
  });
  if (hermes.length) {
    const hull = bridge;
    const envId = state.hermesCatalog?.envId && hermes.some(e => e.summary.id === state.hermesCatalog?.envId)
      ? state.hermesCatalog.envId : hermes[0].summary.id;
    const nodes = [...fleet.environmentNodes.values()];
    const top = nodes.slice(0, perRow);
    const manifoldY = hull.y + hull.h + HALL_TO_DECKS / 2;
    fleet.controlCenter = { envId, envIds: hermes.map(e => e.summary.id), hull,
      bounds: nodes.reduce((bounds, node) => union(bounds, node.hull), hull),
      operators: operators.map((bot, i) => {
        const row = Math.floor(i / 4);
        const columns = Math.min(4, operators.length - row * 4);
        return { bot, workstation: { x: hull.x + (hull.w - (columns * OPERATOR_PITCH - 8)) / 2 + (i % 4) * OPERATOR_PITCH,
          y: hull.y + HALL_HEAD + row * HERMES_BAY_PITCH, w: 158, h: 116 } };
      }),
      // The top row's collars drop from the manifold; a deck in a later row hangs from the one above.
      links: nodes.map((node, index) => ({ envId: node.envId,
        from: index < perRow ? { x: node.hatchX, y: manifoldY } : { x: node.hatchX, y: node.hull.y - NODE_GAP },
        laneX: node.hatchX,
        to: { x: node.hatchX, y: node.hull.y } })),
      ...(top.length ? { manifold: { stemX: 0, top: hull.y + hull.h, y: manifoldY,
        x0: Math.min(0, ...top.map(n => n.hatchX)), x1: Math.max(0, ...top.map(n => n.hatchX)) } } : {}),
    };
  } else if (groups.length > 1) fleet.hub = { x: -70, y: -116, w: 140, h: 80 };

  for (const c of crew) fleet.crew.set(c.key, c);
  let bounds: Rect | undefined;
  for (const s of fleet.stations.values()) bounds = bounds ? union(bounds, s.bounds) : s.bounds;
  for (const s of fleet.environmentNodes.values()) bounds = bounds ? union(bounds, { ...s.hull, x: s.hull.x - 40, w: s.hull.w + 40, h: s.hull.h }) : s.hull;
  if (fleet.hub) bounds = bounds ? union(bounds, fleet.hub) : fleet.hub;
  if (fleet.controlCenter) bounds = bounds ? union(bounds, fleet.controlCenter.hull) : fleet.controlCenter.hull;
  fleet.bounds = bounds ?? { x: 0, y: 0, w: 0, h: 0 };
  return fleet;
}

/** Team color for an environment, consistent between the map and the HUD. */
export function stationColor(state: GameState, envId: string): number {
  const index = sortedEnvs(state).findIndex((e) => e.summary.id === envId);
  return teamColor(Math.max(0, index));
}
