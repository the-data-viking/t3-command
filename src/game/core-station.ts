// A study for a fleet that keeps growing, reviewed on /scalelab.html beside the live layout (not used
// by the live map yet). The fleet is one station built around a core: Hermes's command module on top,
// the machines' engineering decks as an engine room at the bottom, and arms branching off the core
// level by level. Every project docks straight onto an arm through a short collar, busy ones full size
// nearest the core, quiet ones as cryo modules further out, all of them visible. Supply runs as light
// lanes inside the structure (engine room → core → arm → collar), one per machine, lit while that
// machine has crew awake on that arm; nothing is wired across open space.

import type { GameState } from "../store";
import { unitKey } from "../store";
import { isHistory, unitState } from "../t3/derive";
import type { ThreadShell } from "../t3/types";
import {
  computeFleetLayout, ENV_NODE_H, ENV_NODE_W, groupProjects, layoutStation, podAt, QUARTERS_SHOWN, sortedEnvs,
  type CrewLayout, type Point, type ProjectGroup, type Rect, type StationLayout,
} from "./layout";
import type { BotOperator } from "../t3/bots";
import { floorZoom } from "./map-common";
import { teamColor } from "./theme";

/** A station stays full size this long after its last crew member settles, so it doesn't flicker. */
export const ACTIVE_GRACE_MS = 30 * 60_000;

/** The cryo module: a nameplate, one room of three pods, its machines' chips along the foot. */
export const COMPACT = { w: 236, h: 148, pad: 14, plate: 26, room: { w: 208, h: 80 } };
/** One supply lane: a 4 px light strip and a 2 px gap. */
export const LANE_PITCH = 6;
/** The pressurised tube from an arm to a module's hull. */
export const COLLAR = 24;
const COMPACT_GAP = 24;
const NODE_GAP = 24;
/** Between deck rows: room for each deck's nameplate, which hangs under it clear of its collar. */
const DECK_ROW_GAP = 40;
const DOCKS_PER_ROW = 6;
/** How far a hub's plating stands out past the core and the arm it joins. */
export const HUB_PAD = 16;
const COL_GAP = 48;
const LEVEL_GAP = 72;
/** Arm beyond its outermost module, for the end cap. */
const ARM_END = 40;
const HALL_GAP = 48;

export type Berth = { level: number; side: -1 | 1; col: number; up: boolean };

export interface QuietModule {
  key: string;
  name: string;
  members: Array<{ envId: string; projectId: string }>;
  hull: Rect;
  room: Rect;
  /** Where its collar meets the hull. */
  port: Point;
  /** Docked under an arm: the collar enters from above and the nameplate sits below. */
  labelBelow: boolean;
  settled: number;
  lastActive: number;
}

export interface Lane {
  envId: string;
  kind: "deck" | "manifold" | "core" | "arm";
  /** Arm index (level × 2 + side) for arm lanes. */
  arm?: number;
  a: Point;
  b: Point;
  /** That machine has crew awake somewhere this lane leads. */
  lit: boolean;
}

export interface CoreStation {
  decks: Array<{ envId: string; rect: Rect; hatchX: number; color: number }>;
  stations: Map<string, StationLayout>;
  modules: Map<string, QuietModule>;
  berths: Map<string, Berth & { arm: number }>;
  crew: Map<string, CrewLayout>;
  /** Hermes's hall, moved onto the core's crown (operators move with it). */
  hall?: { hull: Rect; operators: Array<{ bot: BotOperator; workstation: Rect }> };
  /** The command module drawn when there is no Hermes. */
  command?: Rect;
  core: Rect;
  arms: Array<{ rect: Rect; level: number }>;
  hubs: Rect[];
  manifold?: Rect;
  collars: Array<{ stationKey: string; rect: Rect }>;
  deckCollars: Rect[];
  lanes: Lane[];
  bounds: Rect;
  levels: number;
  columns: number;
}

export interface CoreOptions {
  /** Busy projects full size, quiet ones as cryo modules (off: every station full size). */
  tiers: boolean;
  viewport: Viewport;
  now: number;
}

export interface Viewport { w: number; h: number }

/** The zoom the live map would settle on to fit `bounds` (desktop HUD: crew roster left, top bar, planet). */
export function fitZoom(bounds: Rect, viewport: Viewport): number {
  const top = 104, left = 306, bottom = 30;
  const w = viewport.w - left;
  const h = Math.min(viewport.h - bottom, viewport.h * 0.88 - 8) - top;
  return floorZoom(Math.min(1.2, w / (bounds.w + 80), h / (bounds.h + 80)));
}

const time = (s: string | null | undefined) => (s ? Date.parse(s) || 0 : 0);
const awake = (t: ThreadShell) => !isHistory(t) && unitState(t) !== "sleeping";
const even = (n: number) => Math.round(n / 2) * 2;

/** Busy: crew awake, or active in the last half hour. Everything else is quiet (and still shown). */
export function isBusy(threads: ThreadShell[], now: number): boolean {
  return threads.some(awake) || now - Math.max(0, ...threads.map((t) => time(t.updatedAt))) < ACTIVE_GRACE_MS;
}

function union(a: Rect | undefined, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

interface Entry {
  group: ProjectGroup;
  threads: Array<{ envId: string; thread: ThreadShell; team: number }>;
  busy: boolean;
  last: number;
  envIds: string[];
}
type Cell = { entries: Entry[]; full: boolean; w: number; h: number };

/** Lay the fleet out as one station, trying one to six levels and keeping the best fit on screen. */
export function computeCoreStation(state: GameState, opts: CoreOptions): CoreStation {
  let best: CoreStation | undefined, bestZoom = 0;
  for (let levels = 1; levels <= 6; levels++) {
    const layout = build(state, opts, levels);
    if (!layout) break;
    const z = fitZoom(layout.bounds, opts.viewport);
    if (!best || z > bestZoom + 1e-9 || (Math.abs(z - bestZoom) < 1e-9 && layout.bounds.w * layout.bounds.h < best.bounds.w * best.bounds.h)) {
      best = layout;
      bestZoom = z;
    }
  }
  return best ?? build(state, opts, 1)!;
}

function build(state: GameState, opts: CoreOptions, levels: number): CoreStation | undefined {
  const envs = sortedEnvs(state);
  const engineering = envs.filter((e) => e.summary.kind !== "hermes");
  const machineIndex = new Map(engineering.map((e, i) => [e.summary.id, i]));
  const crew: CrewLayout[] = [];
  const out: CoreStation = {
    decks: [], stations: new Map(), modules: new Map(), berths: new Map(), crew: new Map(),
    core: { x: 0, y: 0, w: 0, h: 0 }, arms: [], hubs: [], collars: [], deckCollars: [], lanes: [],
    bounds: { x: 0, y: 0, w: 0, h: 0 }, levels, columns: 0,
  };

  // ---- Projects, busiest first; quiet ones pair up in a berth as cryo modules.
  const entries: Entry[] = groupProjects(envs).map((group) => {
    const threads = group.members.flatMap((m) => Object.values(m.env.threads)
      .filter((t) => t.projectId === m.project.id)
      .map((thread) => ({ envId: m.env.summary.id, thread, team: m.index })));
    const plain = threads.map((t) => t.thread);
    return { group, threads, busy: !opts.tiers || isBusy(plain, opts.now), last: Math.max(0, ...plain.map((t) => time(t.updatedAt))), envIds: [...new Set(group.members.map((m) => m.env.summary.id))] };
  });
  const byRecent = (a: Entry, b: Entry) => b.last - a.last || a.group.name.localeCompare(b.group.name);
  const busy = entries.filter((e) => e.busy).sort(byRecent);
  const quiet = entries.filter((e) => !e.busy).sort(byRecent);
  const cells: Cell[] = busy.map((e) => {
    const b = layoutStation(e.group, 0, 0, []).bounds;
    return { entries: [e], full: true, w: b.w, h: b.h };
  });
  for (let k = 0; k < quiet.length; k += 2) {
    const pair = quiet.slice(k, k + 2);
    cells.push({ entries: pair, full: false, w: pair.length * COMPACT.w + (pair.length - 1) * COMPACT_GAP, h: COMPACT.h });
  }
  // Four berths per column per level: above and below the arm, either side of the core.
  const columns = Math.max(1, Math.ceil(cells.length / (4 * levels)));
  // More levels than this fleet needs: one fewer already holds it in as many columns.
  if (levels > 1 && Math.max(1, Math.ceil(cells.length / (4 * (levels - 1)))) === columns) return undefined;
  out.columns = columns;
  const slots: Berth[] = [];
  for (let col = 0; col < columns; col++) for (let level = 0; level < levels; level++) for (const up of [true, false]) for (const side of [-1, 1] as const) slots.push({ level, side, col, up });
  slots.sort((a, b) => a.col + a.level - (b.col + b.level) || a.level - b.level || Number(b.up) - Number(a.up));
  const placed = cells.map((cell, k) => ({ cell, berth: slots[k] }));
  // Each column is as wide as its widest berth, the same on both sides, so the arms stay mirrored.
  const colW = Array.from({ length: columns }, (_, col) => Math.max(COMPACT.w, ...placed.filter((p) => p.berth?.col === col).map((p) => p.cell.w)));
  const colStart = (col: number) => colW.slice(0, col).reduce((sum, w) => sum + w + COL_GAP, 0);

  // ---- Machines: lanes in the core, one per machine, centred.
  const machines = engineering.length;
  const coreW = even(Math.max(48, 20 + LANE_PITCH * machines));
  const laneX = (envId: string) => -machines * LANE_PITCH / 2 + (machineIndex.get(envId) ?? 0) * LANE_PITCH + 1;
  // Each arm side carries the lanes of the machines serving its berths.
  const armKey = (level: number, side: -1 | 1) => level * 2 + (side === 1 ? 1 : 0);
  const armLanes = new Map<number, string[]>();
  for (const { cell, berth } of placed) {
    const k = armKey(berth.level, berth.side);
    const ids = new Set(armLanes.get(k) ?? []);
    for (const e of cell.entries) for (const id of e.envIds) if (machineIndex.has(id)) ids.add(id);
    armLanes.set(k, [...ids].sort((a, b) => machineIndex.get(a)! - machineIndex.get(b)!));
  }
  const maxLanes = Math.max(2, ...[...armLanes.values()].map((l) => l.length));
  const armH = even(Math.max(40, 20 + LANE_PITCH * maxLanes));

  // ---- The crown: Hermes's hall (the live one, moved) or a command module.
  const live = computeFleetLayout(state).controlCenter;
  let crownBottom: number;
  if (live) {
    const dx = -live.hull.x - live.hull.w / 2, dy = -live.hull.y;
    const move = (r: Rect) => ({ ...r, x: r.x + dx, y: r.y + dy });
    out.hall = { hull: move(live.hull), operators: live.operators.map((o) => ({ bot: o.bot, workstation: move(o.workstation) })) };
    crownBottom = out.hall.hull.h;
  } else {
    out.command = { x: -120, y: 0, w: 240, h: 96 };
    crownBottom = 96;
  }

  // ---- Levels: an arm, its upper berths hanging above it, its lower berths below.
  const awakeOn = (envId: string, list: Entry[]) => list.some((e) => e.threads.some((t) => t.envId === envId && awake(t.thread)));
  const colX = (col: number, side: -1 | 1) => side * (coreW / 2 + HUB_PAD + 24 + colStart(col) + colW[col] / 2);
  let y = crownBottom + HALL_GAP;
  for (let level = 0; level < levels; level++) {
    const here = placed.filter((p) => p.berth.level === level);
    if (!here.length) break;
    const upH = Math.max(0, ...here.filter((p) => p.berth.up).map((p) => p.cell.h));
    const downH = Math.max(0, ...here.filter((p) => !p.berth.up).map((p) => p.cell.h));
    const armY = y + (upH ? upH + COLLAR : 0);
    const armBottom = armY + armH;
    const reach = Math.max(...here.map((p) => p.berth.col));
    const half = coreW / 2 + HUB_PAD + 24 + colStart(reach) + colW[reach] + ARM_END;
    out.arms.push({ rect: { x: -half, y: armY, w: 2 * half, h: armH }, level });
    out.hubs.push({ x: -coreW / 2 - HUB_PAD, y: armY - HUB_PAD, w: coreW + 2 * HUB_PAD, h: armH + 2 * HUB_PAD });
    for (const { cell, berth } of here) {
      const cx = colX(berth.col, berth.side);
      const arm = armKey(level, berth.side);
      // The pair's inner module sits nearest the core.
      const boxes = cell.entries.map((_, k) => {
        const w = cell.full ? cell.w : COMPACT.w;
        const left = cx - cell.w / 2 + (berth.side === 1 ? k : cell.entries.length - 1 - k) * (COMPACT.w + COMPACT_GAP);
        return { x: even(left), w };
      });
      cell.entries.forEach((e, k) => {
        const { x } = boxes[k];
        out.berths.set(e.group.key, { ...berth, arm });
        if (cell.full) {
          // Hull top sits 48 px under the station's origin (its nameplate band).
          const hullTop = berth.up ? armY - COLLAR - (cell.h - 48) : armBottom + COLLAR;
          const probe = layoutStation(e.group, 0, 0, []);
          const station = layoutStation(e.group, x - probe.bounds.x, hullTop - 48, crew);
          const hullBottom = hullTop + cell.h - 48;
          station.port = { x: even(station.bounds.x + station.bounds.w / 2), y: berth.up ? hullBottom : hullTop };
          if (!berth.up) {
            station.nameplate = { x: station.bounds.x, y: hullBottom };
            station.bounds = { ...station.bounds, y: hullTop };
          }
          out.stations.set(station.key, station);
          out.collars.push({ stationKey: station.key, rect: berth.up ? { x: station.port.x - 12, y: hullBottom, w: 24, h: COLLAR } : { x: station.port.x - 12, y: armBottom, w: 24, h: COLLAR } });
        } else {
          const top = berth.up ? armY - COLLAR - COMPACT.h : armBottom + COLLAR;
          const hull = berth.up ? { x, y: top + COMPACT.plate, w: COMPACT.w, h: COMPACT.h - COMPACT.plate } : { x, y: top, w: COMPACT.w, h: COMPACT.h - COMPACT.plate };
          const room = { x: hull.x + COMPACT.pad, y: hull.y + COMPACT.pad, w: COMPACT.room.w, h: COMPACT.room.h };
          const settled = e.threads.filter((t) => !isHistory(t.thread) && unitState(t.thread) === "sleeping")
            .sort((a, b) => time(b.thread.settledAt ?? b.thread.updatedAt) - time(a.thread.settledAt ?? a.thread.updatedAt));
          settled.slice(0, QUARTERS_SHOWN).forEach((t, n) => crew.push({
            key: unitKey(t.envId, t.thread.id), envId: t.envId, threadId: t.thread.id, stationKey: e.group.key,
            color: teamColor(t.team), home: podAt(room, n), homeRoom: "quarters", sleeping: true,
          }));
          const port = { x: even(hull.x + hull.w / 2), y: berth.up ? hull.y + hull.h : hull.y };
          out.modules.set(e.group.key, {
            key: e.group.key, name: e.group.name, members: e.group.members.map((m) => ({ envId: m.env.summary.id, projectId: m.project.id })),
            hull, room, port, labelBelow: !berth.up, settled: settled.length, lastActive: e.last,
          });
          out.collars.push({ stationKey: e.group.key, rect: berth.up ? { x: port.x - 12, y: port.y, w: 24, h: COLLAR } : { x: port.x - 12, y: armBottom, w: 24, h: COLLAR } });
        }
      });
    }
    // This level's arm lanes, out from the hub to each machine's outermost collar on that side.
    for (const side of [-1, 1] as const) {
      const ids = armLanes.get(armKey(level, side)) ?? [];
      const onSide = here.filter((p) => p.berth.side === side);
      ids.forEach((envId, n) => {
        const ly = armY + (armH - ids.length * LANE_PITCH) / 2 + n * LANE_PITCH + 1;
        const ports = onSide.flatMap((p) => p.cell.entries.filter((e) => e.envIds.includes(envId)).map((e) => (out.stations.get(e.group.key)?.port ?? out.modules.get(e.group.key)!.port).x));
        const far = side === 1 ? Math.max(...ports) + 16 : Math.min(...ports) - 16;
        const lit = awakeOn(envId, onSide.flatMap((p) => p.cell.entries));
        out.lanes.push({ envId, kind: "arm", arm: armKey(level, side), a: { x: side * (coreW / 2 + HUB_PAD), y: ly }, b: { x: far, y: ly }, lit });
      });
    }
    y = armBottom + (downH ? COLLAR + downH : 0) + LEVEL_GAP;
  }

  // ---- The engine room: a manifold under the last level, the decks hanging below it in balanced
  // brick rows (the second row offset half a deck, so its collars rise through the gaps above).
  const lastArmBottom = out.arms.length ? out.arms[out.arms.length - 1].rect.y + armH : y;
  if (machines) {
    const deckRows = machines <= DOCKS_PER_ROW ? 1 : 2;
    const firstRow = Math.ceil(machines / deckRows);
    const pitch = ENV_NODE_W + NODE_GAP;
    const sides = engineering.map((_, i) => {
      const row = i < firstRow ? 0 : 1;
      const col = row === 0 ? i : i - firstRow;
      return { row, cx: even((col - (firstRow - 1) / 2) * pitch + (row ? pitch / 2 : 0)) };
    });
    // Lane rows in the manifold: on each side, the deck nearest the core runs lowest, so no deck's
    // rise crosses another deck's lane.
    const rank = new Map<number, number>();
    for (const side of [-1, 1]) {
      const list = sides.map((s, i) => ({ i, d: s.cx * side })).filter((s) => s.d > 0 || (side === 1 && s.d === 0)).sort((a, b) => a.d - b.d);
      list.forEach((s, n) => rank.set(s.i, n));
    }
    const rows = Math.max(1, ...[...rank.values()].map((r) => r + 1));
    const manH = even(Math.max(40, 20 + LANE_PITCH * rows));
    const span = Math.max(coreW + 2 * HUB_PAD + 80, ...sides.map((s) => Math.abs(s.cx) * 2 + ENV_NODE_W - 80));
    const manY = y;
    out.manifold = { x: -span / 2, y: manY, w: span, h: manH };
    out.hubs.push({ x: -coreW / 2 - HUB_PAD, y: manY - HUB_PAD, w: coreW + 2 * HUB_PAD, h: manH + 2 * HUB_PAD });
    const deckTop = manY + manH + COLLAR;
    engineering.forEach((env, i) => {
      const { row, cx } = sides[i];
      const rect = { x: cx - ENV_NODE_W / 2, y: deckTop + row * (ENV_NODE_H + DECK_ROW_GAP), w: ENV_NODE_W, h: ENV_NODE_H };
      out.decks.push({ envId: env.summary.id, rect, hatchX: cx, color: teamColor(envs.indexOf(env)) });
      out.deckCollars.push({ x: cx - 12, y: manY + manH, w: 24, h: rect.y - manY - manH });
      const ly = manY + manH - 10 - rank.get(i)! * LANE_PITCH - 3;
      const id = env.summary.id;
      const projects = entries.filter((e) => e.envIds.includes(id));
      const lit = awakeOn(id, projects);
      out.lanes.push({ envId: id, kind: "deck", a: { x: cx - 2, y: rect.y }, b: { x: cx - 2, y: ly }, lit });
      out.lanes.push({ envId: id, kind: "manifold", a: { x: cx, y: ly }, b: { x: laneX(id), y: ly }, lit });
      // Up the core to the highest arm this machine serves.
      const armsServed = out.arms.filter((a) => [-1, 1].some((side) => (armLanes.get(armKey(a.level, side as -1 | 1)) ?? []).includes(id)));
      if (armsServed.length) {
        const top = Math.min(...armsServed.map((a) => a.rect.y + armH / 2));
        out.lanes.push({ envId: id, kind: "core", a: { x: laneX(id), y: manY - HUB_PAD }, b: { x: laneX(id), y: top }, lit });
      }
    });
  }
  const coreBottom = out.manifold ? out.manifold.y + out.manifold.h / 2 : lastArmBottom;
  out.core = { x: -coreW / 2, y: crownBottom, w: coreW, h: coreBottom - crownBottom };

  for (const c of crew) out.crew.set(c.key, c);
  let bounds: Rect | undefined = out.hall?.hull ?? out.command;
  for (const d of out.decks) bounds = union(bounds, d.rect);
  for (const s of out.stations.values()) bounds = union(bounds, s.bounds);
  for (const m of out.modules.values()) bounds = union(bounds, { x: m.hull.x, y: m.labelBelow ? m.hull.y : m.hull.y - COMPACT.plate, w: m.hull.w, h: m.hull.h + COMPACT.plate });
  for (const a of out.arms) bounds = union(bounds, a.rect);
  if (out.manifold) bounds = union(bounds, out.manifold);
  out.bounds = bounds!;
  return out;
}
