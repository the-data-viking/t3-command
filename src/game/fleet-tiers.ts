// A study for a fleet that keeps growing, reviewed on /scalelab.html beside the live layout (not used
// by the live map yet). Stations are sized by what is happening in them: a project with crew awake
// keeps its full station, one that rested recently shrinks to a cryo module, and one that has been
// quiet for days docks as a capsule in a rack below the wings. Supply lines are drawn only where work
// flows; every other machine–project pair is a colour chip on the station's hull (its line shows on
// hover). Machine decks sit in balanced brick rows, and the wings are shaped to the screen.

import type { GameState } from "../store";
import { unitKey } from "../store";
import { isHistory, unitState } from "../t3/derive";
import type { ThreadShell } from "../t3/types";
import {
  computeFleetLayout, CORRIDOR_W, ENV_NODE_H, ENV_NODE_W, groupProjects, LANE, layoutStation, orderLanes,
  podAt, QUARTERS_SHOWN, sortedEnvs, wingCount,
  type ControlCenterLayout, type CrewLayout, type Point, type ProjectGroup, type Rect, type StationLayout,
} from "./layout";
import { floorZoom } from "./map-common";
import { teamColor } from "./theme";

export type StationTier = "active" | "resting" | "dormant";

/** A station stays full size this long after its last crew member settles, so it doesn't flicker. */
export const ACTIVE_GRACE_MS = 30 * 60_000;
/** Past this long without activity, a resting station docks as a capsule. */
export const RESTING_MS = 3 * 24 * 3600_000;

/** The cryo module: one room of three pods under its nameplate, its machines' chips along the foot. */
export const COMPACT = { w: 236, h: 148, pad: 14, plate: 26, foot: 28, room: { w: 208, h: 80 } };
/** A docked capsule, and the pitch of the rack it sits in. */
export const CAPSULE = { w: 168, h: 40, pitchX: 180, pitchY: 52 };
const COMPACT_GAP = 24;
const NODE_GAP = 24;
const DOCKS_PER_ROW = 6;
const BUS_TOP = 28;
const BUS_TO_STATIONS = 40;
const STATION_GAP_Y = 96;
/** Below a row of cryo modules only (they never carry a lit line along their side). */
const MODULE_GAP_Y = 60;
const WING_GAP = 96;
const RACK_PAD = 16;
const RACK_HEAD = 28;

/** A resting module or a docked capsule. */
export interface SmallStation {
  key: string;
  name: string;
  tier: "resting" | "dormant";
  members: Array<{ envId: string; projectId: string }>;
  hull: Rect;
  /** The cryo room (resting modules only). */
  room?: Rect;
  /** Lines come in from above. */
  port: Point;
  settled: number;
  lastActive: number;
}

export interface TieredLink {
  envId: string;
  stationKey: string;
  points: Point[];
  /** Work is flowing: drawn always. Otherwise drawn only on hover. */
  lit: boolean;
}

export interface TieredLayout {
  decks: Array<{ envId: string; rect: Rect; hatchX: number; color: number }>;
  stations: Map<string, StationLayout>;
  tiers: Map<string, StationTier>;
  modules: Map<string, SmallStation>;
  capsules: Map<string, SmallStation>;
  rack?: Rect;
  links: TieredLink[];
  crew: Map<string, CrewLayout>;
  /** The Hermes hall exactly as the live layout draws it, with collars to these decks. */
  hall?: { layout: ControlCenterLayout; collars: Point[][]; manifold: { y: number; x0: number; x1: number; stemTop: number } };
  bounds: Rect;
  wings: number;
}

export interface TierOptions {
  /** Size stations by activity (off: every station full size, as live). */
  tiers: boolean;
  /** "lit": lines only where work flows. "all": a line per machine–project pair, as live. */
  lines: "lit" | "all";
  /** Pick the wing count that fits the viewport best (off: the live rule). */
  shape: boolean;
  viewport: { w: number; h: number };
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

export function stationTier(threads: ThreadShell[], now: number): StationTier {
  if (threads.some(awake)) return "active";
  const last = Math.max(0, ...threads.map((t) => time(t.updatedAt)));
  if (now - last < ACTIVE_GRACE_MS) return "active";
  return now - last < RESTING_MS ? "resting" : "dormant";
}

function union(a: Rect | undefined, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

interface Entry {
  group: ProjectGroup;
  threads: Array<{ envId: string; thread: ThreadShell; team: number }>;
  tier: StationTier;
  last: number;
  envIds: string[];
}

export function computeTieredLayout(state: GameState, opts: TierOptions): TieredLayout {
  if (!opts.shape) return build(state, opts, wingCount(groupProjects(sortedEnvs(state)).length));
  let best: TieredLayout | undefined, bestZoom = 0;
  for (let wings = 1; wings <= 4; wings++) {
    const layout = build(state, opts, wings);
    const z = fitZoom(layout.bounds, opts.viewport);
    if (!best || z > bestZoom + 1e-9 || (Math.abs(z - bestZoom) < 1e-9 && layout.bounds.w * layout.bounds.h < best.bounds.w * best.bounds.h)) {
      best = layout;
      bestZoom = z;
    }
  }
  return best!;
}

function build(state: GameState, opts: TierOptions, wings: number): TieredLayout {
  const envs = sortedEnvs(state);
  const engineering = envs.filter((e) => e.summary.kind !== "hermes");
  const out: TieredLayout = { decks: [], stations: new Map(), tiers: new Map(), modules: new Map(), capsules: new Map(), links: [], crew: new Map(), bounds: { x: 0, y: 0, w: 0, h: 0 }, wings };
  if (!envs.length) return out;
  const crew: CrewLayout[] = [];

  // ---- The keel: one row up to six machines, then two brick rows (the second offset half a deck,
  // so every upper deck drops straight down through a gap in the row below).
  const machines = engineering.length;
  const deckRows = machines <= DOCKS_PER_ROW ? 1 : 2;
  const firstRow = Math.ceil(machines / deckRows);
  const pitch = ENV_NODE_W + NODE_GAP;
  engineering.forEach((env, i) => {
    const row = i < firstRow ? 0 : 1;
    const col = row === 0 ? i : i - firstRow;
    const cx = (col - (firstRow - 1) / 2) * pitch + (row ? pitch / 2 : 0);
    const rect = { x: cx - ENV_NODE_W / 2, y: row * (ENV_NODE_H + NODE_GAP), w: ENV_NODE_W, h: ENV_NODE_H };
    out.decks.push({ envId: env.summary.id, rect, hatchX: cx, color: teamColor(envs.indexOf(env)) });
  });
  const deckOf = new Map(out.decks.map((d) => [d.envId, d]));
  const decksBottom = machines ? deckRows * (ENV_NODE_H + NODE_GAP) - NODE_GAP : 0;
  const laneY = (k: number) => decksBottom + BUS_TOP + k * LANE;
  const stationsTop = laneY(Math.max(0, machines - 1)) + BUS_TO_STATIONS;

  // ---- Stations by tier, busiest first.
  const entries: Entry[] = groupProjects(envs).map((group) => {
    const threads = group.members.flatMap((m) => Object.values(m.env.threads)
      .filter((t) => t.projectId === m.project.id)
      .map((thread) => ({ envId: m.env.summary.id, thread, team: m.index })));
    const plain = threads.map((t) => t.thread);
    const tier = opts.tiers ? stationTier(plain, opts.now) : "active";
    return { group, threads, tier, last: Math.max(0, ...plain.map((t) => time(t.updatedAt))), envIds: [...new Set(group.members.map((m) => m.env.summary.id))] };
  });
  for (const e of entries) out.tiers.set(e.group.key, e.tier);
  const byRecent = (a: Entry, b: Entry) => b.last - a.last || a.group.name.localeCompare(b.group.name);
  const active = entries.filter((e) => e.tier === "active").sort(byRecent);
  const resting = entries.filter((e) => e.tier === "resting").sort(byRecent);
  const dormant = entries.filter((e) => e.tier === "dormant").sort((a, b) => a.group.name.localeCompare(b.group.name));

  // Cells fill the wing slots: a full station each, or two cryo modules side by side.
  const pad = -layoutStation(active[0]?.group ?? entries[0]?.group ?? { key: "", name: "", members: [] }, 0, 0, []).bounds.x;
  type Cell = { entries: Entry[]; w: number; h: number; want: number };
  const want = (es: Entry[]) => {
    const xs = es.flatMap((e) => e.envIds).map((id) => deckOf.get(id)?.hatchX ?? 0);
    return xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
  };
  const cells: Cell[] = active.map((e) => {
    const b = layoutStation(e.group, 0, 0, []).bounds;
    return { entries: [e], w: b.w, h: b.h, want: want([e]) };
  });
  for (let k = 0; k < resting.length; k += 2) {
    const pair = resting.slice(k, k + 2);
    cells.push({ entries: pair, w: pair.length * COMPACT.w + (pair.length - 1) * COMPACT_GAP, h: COMPACT.h, want: want(pair) });
  }
  const colW = Math.max(ENV_NODE_W, ...cells.map((c) => c.w), resting.length > 1 ? 2 * COMPACT.w + COMPACT_GAP : 0);
  const wingW = 2 * colW + CORRIDOR_W;
  const totalW = wings * wingW + (wings - 1) * WING_GAP;
  const wingCentre = (w: number) => -totalW / 2 + wingW / 2 + w * (wingW + WING_GAP);
  type Side = "left" | "right";
  const slotX = (w: number, side: Side) => wingCentre(w) + (side === "left" ? -1 : 1) * (CORRIDOR_W / 2 + colW / 2);

  // Place rows: each cell takes the free slot in its row nearest the machines that serve it.
  type Placed = { entry: Entry; wing: number; side: Side; rowTop: number; gapAbove: number; small?: SmallStation };
  const placed: Placed[] = [];
  let y = stationsTop;
  let gapAbove = BUS_TO_STATIONS;
  for (let r = 0; r * 2 * wings < cells.length; r++) {
    const row = cells.slice(r * 2 * wings, (r + 1) * 2 * wings);
    const taken = new Set<string>();
    let rowH = 0;
    for (const cell of row) {
      const free: Array<{ wing: number; side: Side }> = [];
      for (let w = 0; w < wings; w++) for (const side of ["left", "right"] as const) if (!taken.has(`${w}${side}`)) free.push({ wing: w, side });
      free.sort((a, b) => Math.abs(slotX(a.wing, a.side) - cell.want) - Math.abs(slotX(b.wing, b.side) - cell.want));
      const slot = free[0];
      taken.add(`${slot.wing}${slot.side}`);
      const inner = slot.side === "left" ? wingCentre(slot.wing) - CORRIDOR_W / 2 : wingCentre(slot.wing) + CORRIDOR_W / 2;
      const dir = slot.side === "left" ? -1 : 1;
      if (cell.entries[0].tier === "active") {
        const e = cell.entries[0];
        const x = slot.side === "left" ? inner - cell.w : inner;
        const station = layoutStation(e.group, x + pad, y, crew);
        station.port = { x: slot.side === "left" ? station.bounds.x + station.bounds.w : station.bounds.x, y: station.interior.y + station.interior.h / 2 };
        out.stations.set(station.key, station);
        placed.push({ entry: e, wing: slot.wing, side: slot.side, rowTop: y, gapAbove });
      } else {
        cell.entries.forEach((e, k) => {
          const near = inner + dir * k * (COMPACT.w + COMPACT_GAP);
          const x = slot.side === "left" ? near - COMPACT.w : near;
          const small = smallStation(e, "resting", { x, y, w: COMPACT.w, h: COMPACT.h }, crew);
          out.modules.set(small.key, small);
          placed.push({ entry: e, wing: slot.wing, side: slot.side, rowTop: y, gapAbove, small });
        });
      }
      rowH = Math.max(rowH, cell.h);
    }
    gapAbove = row.some((cell) => cell.entries[0].tier === "active") ? STATION_GAP_Y : MODULE_GAP_Y;
    y += rowH + gapAbove;
  }

  // The dock: a rack of capsules across the wings, below the last row.
  if (dormant.length) {
    const width = Math.max(totalW, machines ? out.decks.reduce((w, d) => Math.max(w, Math.abs(d.rect.x), Math.abs(d.rect.x + d.rect.w)), 0) * 2 : 0);
    const perRow = Math.max(1, Math.min(dormant.length, Math.floor((width - 2 * RACK_PAD + (CAPSULE.pitchX - CAPSULE.w)) / CAPSULE.pitchX)));
    const rows = Math.ceil(dormant.length / perRow);
    const rackW = perRow * CAPSULE.pitchX - (CAPSULE.pitchX - CAPSULE.w) + 2 * RACK_PAD;
    const rack = { x: -rackW / 2, y: cells.length ? y : stationsTop, w: rackW, h: RACK_HEAD + rows * CAPSULE.pitchY - (CAPSULE.pitchY - CAPSULE.h) + RACK_PAD };
    out.rack = rack;
    dormant.forEach((e, k) => {
      const x = rack.x + RACK_PAD + (k % perRow) * CAPSULE.pitchX;
      const cy = rack.y + RACK_HEAD + Math.floor(k / perRow) * CAPSULE.pitchY;
      const small = smallStation(e, "dormant", { x, y: cy, w: CAPSULE.w, h: CAPSULE.h }, crew);
      out.capsules.set(small.key, small);
      // A capsule's line runs down the nearest corridor, then along the gap above the rack.
      let wing = 0;
      for (let w = 1; w < wings; w++) if (Math.abs(wingCentre(w) - (x + CAPSULE.w / 2)) < Math.abs(wingCentre(wing) - (x + CAPSULE.w / 2))) wing = w;
      placed.push({ entry: e, wing, side: x + CAPSULE.w / 2 < wingCentre(wing) ? "left" : "right", rowTop: rack.y, gapAbove, small });
    });
  }

  // ---- Supply lines. Lit lines get their own corridor lanes (shallowest outermost, as live);
  // the rest share the corridor's middle and show only on hover.
  type Pending = { envId: string; at: Placed; lit: boolean; port: Point; top: boolean };
  const pending: Pending[] = [];
  for (const at of placed) {
    const station = out.stations.get(at.entry.group.key);
    for (const envId of at.entry.envIds) {
      if (!deckOf.has(envId)) continue;
      const lit = opts.lines === "all" || at.entry.threads.some((t) => t.envId === envId && awake(t.thread));
      if (station) {
        const members = at.entry.envIds;
        const offset = (members.indexOf(envId) - (members.length - 1) / 2) * 12;
        pending.push({ envId, at, lit, port: { x: station.port.x, y: station.port.y + offset }, top: false });
      } else pending.push({ envId, at, lit, port: at.small!.port, top: true });
    }
  }
  const laneX = new Map<Pending, number>();
  for (let w = 0; w < wings; w++) for (const side of ["left", "right"] as const) {
    const dir = side === "left" ? -1 : 1;
    const lines = pending.filter((p) => p.lit && p.at.wing === w && p.at.side === side).sort((a, b) => a.port.y - b.port.y);
    const room = CORRIDOR_W / 2 - 16;
    const step = Math.min(LANE, room / Math.max(1, lines.length));
    lines.forEach((p, n) => laneX.set(p, Math.round((wingCentre(w) + dir * (4 + (lines.length - 1 - n) * step)) / 2) * 2));
    for (const p of pending) if (!p.lit && p.at.wing === w && p.at.side === side) laneX.set(p, wingCentre(w) + dir * 4);
  }
  // Bus lanes, stacked for the fewest crossings (the live rule).
  const busLines = out.decks.map((d) => {
    const downs = pending.filter((p) => p.envId === d.envId).map((p) => laneX.get(p)!);
    const xs = [d.hatchX, ...downs];
    return { drop: d.hatchX, downs, lo: Math.min(...xs), hi: Math.max(...xs) };
  });
  const busLane = new Map<string, number>();
  orderLanes(busLines).forEach((index, k) => busLane.set(out.decks[index].envId, k));
  for (const p of pending) {
    const deck = deckOf.get(p.envId)!;
    const busY = laneY(busLane.get(p.envId) ?? 0);
    const x = laneX.get(p)!;
    const points: Point[] = [{ x: deck.hatchX, y: deck.rect.y + ENV_NODE_H }, { x: deck.hatchX, y: busY }, { x, y: busY }];
    if (p.top) {
      // Out of the corridor in the gap above the row, then down into the module's roof.
      const gapY = Math.round((p.at.rowTop - p.at.gapAbove / 2 + (p.lit ? 0 : 8)) / 2) * 2;
      points.push({ x, y: gapY }, { x: p.port.x, y: gapY }, p.port);
    } else points.push({ x, y: p.port.y }, p.port);
    out.links.push({ envId: p.envId, stationKey: p.at.entry.group.key, points, lit: p.lit });
  }

  // ---- The Hermes hall: the live hall, its collars dropping to this keel.
  const live = computeFleetLayout(state).controlCenter;
  if (live) {
    const manifoldY = live.hull.y + live.hull.h + 24;
    // Second-row decks hang through the gaps in the first (the brick offset lines them up).
    const collars = out.decks.map((d) => [{ x: d.hatchX, y: manifoldY }, { x: d.hatchX, y: d.rect.y }]);
    const xs = out.decks.map((d) => d.hatchX);
    out.hall = { layout: live, collars, manifold: { y: manifoldY, x0: Math.min(0, ...xs), x1: Math.max(0, ...xs), stemTop: live.hull.y + live.hull.h } };
  }

  for (const c of crew) out.crew.set(c.key, c);
  let bounds: Rect | undefined;
  for (const d of out.decks) bounds = union(bounds, d.rect);
  for (const s of out.stations.values()) bounds = union(bounds, s.bounds);
  for (const s of out.modules.values()) bounds = union(bounds, s.hull);
  if (out.rack) bounds = union(bounds, out.rack);
  if (out.hall) bounds = union(bounds, out.hall.layout.hull);
  out.bounds = bounds ?? { x: 0, y: 0, w: 0, h: 0 };
  return out;

  function smallStation(e: Entry, tier: "resting" | "dormant", box: Rect, into: CrewLayout[]): SmallStation {
    const settled = e.threads.filter((t) => !isHistory(t.thread) && unitState(t.thread) === "sleeping")
      .sort((a, b) => time(b.thread.settledAt ?? b.thread.updatedAt) - time(a.thread.settledAt ?? a.thread.updatedAt));
    const room = tier === "resting"
      ? { x: box.x + COMPACT.pad, y: box.y + COMPACT.plate + COMPACT.pad, w: COMPACT.room.w, h: COMPACT.room.h }
      : undefined;
    const hull = tier === "resting" ? { x: box.x, y: box.y + COMPACT.plate, w: box.w, h: box.h - COMPACT.plate } : box;
    if (room) settled.slice(0, QUARTERS_SHOWN).forEach((t, k) => into.push({
      key: unitKey(t.envId, t.thread.id), envId: t.envId, threadId: t.thread.id, stationKey: e.group.key,
      color: teamColor(t.team), home: podAt(room, k), homeRoom: "quarters", sleeping: true,
    }));
    return {
      key: e.group.key, name: e.group.name, tier,
      members: e.group.members.map((m) => ({ envId: m.env.summary.id, projectId: m.project.id })),
      hull, room, port: { x: Math.round((hull.x + hull.w / 2) / 2) * 2, y: hull.y }, settled: settled.length, lastActive: e.last,
    };
  }
}
