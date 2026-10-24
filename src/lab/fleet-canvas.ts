// Draws a fleet layout (the live one or the tiered study) on a 2D canvas with the Flight Deck kit in
// Night Shift, for the scale lab. A review renderer: static frames, no animation, no live data.

import { ENGINEERING_SPOTS, FLIGHT_KIT as KIT, flightCrew } from "../art/flightdeck";
import { STYLES } from "../art/palettes";
import { glyphFor, STATUS_GLYPHS } from "../art/pixelfont";
import { rasterize } from "../art/render";
import type { Grid } from "../art/sprites";
import type { GameState } from "../store";
import { unitState, type UnitState } from "../t3/derive";
import type { FleetLayout, Point, Rect, StationLayout } from "../game/layout";
import { podAt, QUARTERS_SHOWN, sortedEnvs, systemFixtureX } from "../game/layout";
import type { SmallStation, TieredLayout } from "../game/fleet-tiers";
import { HERMES_COLOR, STATUS, teamColor } from "../game/theme";

const style = STYLES["flightdeck-nightshift"];
const c = style.colors;
const PX = 2;
const SCREEN_OFF = 0x1c2a33;
const css = (n: number, a = 1) => a === 1 ? `#${n.toString(16).padStart(6, "0")}` : `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
const img = (grid: Grid, fill: { team?: number; visor?: number; screen?: number } = {}) => rasterize(grid, style, fill);

export interface DrawLink { envId: string; stationKey: string; points: Point[]; lit: boolean; color: number }
export interface DrawSmall extends SmallStation { colors: number[]; litColors: number[] }
export interface DrawModel {
  decks: Array<{ envId: string; rect: Rect; color: number; name: string; working: number }>;
  hall?: { hull: Rect; operators: Array<{ rect: Rect; name: string }>; collars: Point[][]; manifold?: { y: number; x0: number; x1: number; stemX: number; stemTop: number } };
  stations: Array<{ layout: StationLayout; colors: number[]; litColors: number[]; awake: number; settled: number }>;
  modules: DrawSmall[];
  capsules: DrawSmall[];
  rack?: Rect;
  links: DrawLink[];
  crew: Array<{ key: string; at: Point; color: number; sleeping: boolean; state: UnitState }>;
  /** Machine colour chips on hulls (the tiered study) instead of a port plate per line. */
  chips: boolean;
  bounds: Rect;
}

export type Hit = { kind: "deck" | "station"; key: string; rect: Rect; label: string };

function envMeta(state: GameState) {
  const envs = sortedEnvs(state);
  const color = (id: string) => teamColor(Math.max(0, envs.findIndex((e) => e.summary.id === id)));
  const working = (envId: string, members?: Array<{ envId: string; projectId: string }>) => {
    const env = state.envs[envId];
    if (!env) return 0;
    return Object.values(env.threads).filter((t) => (!members || members.some((m) => m.envId === envId && m.projectId === t.projectId))
      && unitState(t) !== "sleeping" && t.latestTurn !== null).length;
  };
  return { color, working, label: (id: string) => state.envs[id]?.summary.label ?? id };
}

function crewOf(state: GameState, list: Iterable<{ key: string; envId: string; threadId: string; home: Point; color: number; sleeping: boolean }>) {
  return [...list].map((m) => {
    const t = state.envs[m.envId]?.threads[m.threadId];
    return { key: m.key, at: m.home, color: m.color, sleeping: m.sleeping, state: t ? unitState(t) : "idle" as UnitState };
  });
}

function stationEntry(state: GameState, s: StationLayout, meta: ReturnType<typeof envMeta>) {
  const ids = [...new Set(s.members.map((m) => m.envId))];
  const lit = ids.filter((id) => meta.working(id, s.members) > 0);
  let awake = 0, settled = 0;
  for (const m of s.members) for (const t of Object.values(state.envs[m.envId]?.threads ?? {})) {
    if (t.projectId !== m.projectId || t.latestTurn === null) continue;
    if (unitState(t) === "sleeping") settled++; else awake++;
  }
  return { layout: s, colors: ids.map(meta.color), litColors: lit.map(meta.color), awake, settled };
}

export function fromLive(state: GameState, f: FleetLayout): DrawModel {
  const meta = envMeta(state);
  const cc = f.controlCenter;
  return {
    decks: [...f.environmentNodes.values()].map((n) => ({ envId: n.envId, rect: n.hull, color: n.color, name: meta.label(n.envId), working: meta.working(n.envId) })),
    hall: cc && { hull: cc.hull, operators: cc.operators.map((o) => ({ rect: o.workstation, name: o.bot.title ?? o.bot.name })),
      collars: cc.links.map((l) => [l.from, l.to]),
      manifold: cc.manifold && { y: cc.manifold.y, x0: cc.manifold.x0, x1: cc.manifold.x1, stemX: cc.manifold.stemX, stemTop: cc.manifold.top } },
    stations: [...f.stations.values()].map((s) => stationEntry(state, s, meta)),
    modules: [], capsules: [],
    links: [...f.environmentNodes.values()].flatMap((n) => n.links.map((l) => ({ envId: n.envId, stationKey: l.stationKey, points: [l.from, ...(l.via ?? []), l.to], lit: true, color: n.color }))),
    crew: crewOf(state, f.crew.values()),
    chips: false,
    bounds: f.bounds,
  };
}

export function fromTiered(state: GameState, t: TieredLayout): DrawModel {
  const meta = envMeta(state);
  const small = (s: SmallStation): DrawSmall => {
    const ids = [...new Set(s.members.map((m) => m.envId))];
    return { ...s, colors: ids.map(meta.color), litColors: ids.filter((id) => meta.working(id, s.members) > 0).map(meta.color) };
  };
  const hall = t.hall;
  return {
    decks: t.decks.map((d) => ({ envId: d.envId, rect: d.rect, color: d.color, name: meta.label(d.envId), working: meta.working(d.envId) })),
    hall: hall && { hull: hall.layout.hull, operators: hall.layout.operators.map((o) => ({ rect: o.workstation, name: o.bot.title ?? o.bot.name })),
      collars: hall.collars, manifold: { y: hall.manifold.y, x0: hall.manifold.x0, x1: hall.manifold.x1, stemX: 0, stemTop: hall.manifold.stemTop } },
    stations: [...t.stations.values()].map((s) => stationEntry(state, s, meta)),
    modules: [...t.modules.values()].map(small),
    capsules: [...t.capsules.values()].map(small),
    rack: t.rack,
    links: t.links.map((l) => ({ ...l, color: meta.color(l.envId) })),
    crew: crewOf(state, t.crew.values()),
    chips: true,
    bounds: t.bounds,
  };
}

export function hits(m: DrawModel): Hit[] {
  return [
    ...m.decks.map((d) => ({ kind: "deck" as const, key: d.envId, rect: d.rect, label: d.name })),
    ...m.stations.map((s) => ({ kind: "station" as const, key: s.layout.key, rect: s.layout.bounds, label: s.layout.name })),
    ...m.modules.map((s) => ({ kind: "station" as const, key: s.key, rect: { x: s.hull.x, y: s.hull.y - 26, w: s.hull.w, h: s.hull.h + 26 }, label: s.name })),
    ...m.capsules.map((s) => ({ kind: "station" as const, key: s.key, rect: s.hull, label: s.name })),
  ];
}

// ---- Primitives ----------------------------------------------------------------------------

type Ctx = CanvasRenderingContext2D;

/** A plate with stepped (pixel) chamfers. */
function stepped(g: Ctx, x: number, y: number, w: number, h: number, cut: number, color: number) {
  g.fillStyle = css(color);
  const step = 4;
  g.fillRect(x, y + cut, w, h - 2 * cut);
  for (let k = 0; k * step < cut; k++) {
    const inset = cut - k * step;
    g.fillRect(x + inset, y + k * step, w - 2 * inset, step);
    g.fillRect(x + inset, y + h - (k + 1) * step, w - 2 * inset, step);
  }
}

function plate(g: Ctx, r: Rect, cut: number, fill = c.H) {
  stepped(g, r.x - PX, r.y - PX, r.w + 2 * PX, r.h + 2 * PX, cut + PX, c.k);
  stepped(g, r.x, r.y, r.w, r.h, cut, fill);
  g.fillStyle = css(c.h); g.fillRect(r.x + cut, r.y + 2, r.w - 2 * cut, 4);
  g.fillStyle = css(c.D); g.fillRect(r.x + cut, r.y + r.h - 6, r.w - 2 * cut, 4);
}

function draw(g: Ctx, grid: Grid, x: number, y: number, ax = 0, ay = 0, fill = {}) {
  const im = img(grid, fill);
  g.drawImage(im, Math.round(x - im.width * PX * ax), Math.round(y - im.height * PX * ay), im.width * PX, im.height * PX);
}

function tile(g: Ctx, grid: Grid, r: Rect) {
  const im = img(grid);
  const s = im.width * PX;
  g.save();
  g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
  for (let y = r.y; y < r.y + r.h; y += s) for (let x = r.x; x < r.x + r.w; x += s) g.drawImage(im, x, y, s, s);
  g.restore();
}

function frame(g: Ctx, r: Rect, color: number, t = 4) {
  g.fillStyle = css(color);
  g.fillRect(r.x, r.y, r.w, t); g.fillRect(r.x, r.y + r.h - t, r.w, t);
  g.fillRect(r.x, r.y, t, r.h); g.fillRect(r.x + r.w - t, r.y, t, r.h);
}

/** Pixel-font text, outlined, `unit` world px per font pixel. Returns its width. */
function text(g: Ctx, s: string, x: number, y: number, color: number, unit: number, maxW = Infinity): number {
  let str = s.toUpperCase();
  const adv = 6 * unit;
  if (str.length * adv > maxW) str = str.slice(0, Math.max(1, Math.floor(maxW / adv) - 1)) + "…";
  const cells: Array<[number, number]> = [];
  [...str].forEach((ch, i) => glyphFor(ch).forEach((row, ry) => [...row].forEach((v, rx) => { if (v === "#") cells.push([x + i * adv + rx * unit, y + ry * unit]); })));
  g.fillStyle = css(c.k);
  for (const [cx, cy] of cells) g.fillRect(cx - unit, cy - unit, unit * 3, unit * 3);
  g.fillStyle = css(color);
  for (const [cx, cy] of cells) g.fillRect(cx, cy, unit, unit);
  return str.length * adv;
}

function glyph(g: Ctx, rows: string[], x: number, y: number, color: number, unit: number) {
  g.fillStyle = css(c.k);
  rows.forEach((row, ry) => [...row].forEach((v, rx) => { if (v === "#") g.fillRect(x + (rx - 1) * unit, y + (ry - 1) * unit, unit * 3, unit * 3); }));
  g.fillStyle = css(color);
  rows.forEach((row, ry) => [...row].forEach((v, rx) => { if (v === "#") g.fillRect(x + rx * unit, y + ry * unit, unit, unit); }));
}

function path(g: Ctx, pts: Point[], width: number, color: string, dash = 0) {
  g.fillStyle = color;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    const horizontal = y0 === y1;
    const len = horizontal ? x1 - x0 : y1 - y0;
    for (let d = 0; d < len + width; d += dash ? dash * 2 : len + width) {
      const run = dash ? Math.min(dash, len + width - d) : len + width;
      if (horizontal) g.fillRect(x0 - width / 2 + d, y0 - width / 2, run, width);
      else g.fillRect(x0 - width / 2, y0 - width / 2 + d, width, run);
    }
  }
}

function chips(g: Ctx, colors: number[], lit: number[], x: number, y: number, vertical: boolean) {
  colors.forEach((col, k) => {
    const cx = vertical ? x : x + k * 10, cy = vertical ? y + k * 10 : y;
    g.fillStyle = css(c.k); g.fillRect(cx - 2, cy - 2, 12, 12);
    g.fillStyle = css(col, lit.includes(col) ? 1 : 0.45); g.fillRect(cx, cy, 8, 8);
  });
}

// ---- Scene -----------------------------------------------------------------------------------

export interface Camera { x: number; y: number; z: number }

export function render(g: Ctx, m: DrawModel, cam: Camera, size: { w: number; h: number; dpr: number }, hover?: Hit) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.imageSmoothingEnabled = false;
  g.fillStyle = css(style.space);
  g.fillRect(0, 0, size.w * size.dpr, size.h * size.dpr);
  g.setTransform(size.dpr * cam.z, 0, 0, size.dpr * cam.z, size.dpr * cam.x, size.dpr * cam.y);
  const unit = Math.max(PX, 1 / cam.z);
  const ink = style.mapInk ?? { text: 0xd8e2ea, muted: 0x8695a5 };

  // Hall collars and manifold (Hermes tan), under the decks.
  if (m.hall) {
    const pipe = css(HERMES_COLOR, 0.75);
    if (m.hall.manifold) {
      const mf = m.hall.manifold;
      path(g, [{ x: mf.stemX, y: mf.stemTop }, { x: mf.stemX, y: mf.y }], 8, css(c.k));
      path(g, [{ x: mf.x0, y: mf.y }, { x: mf.x1, y: mf.y }], 8, css(c.k));
      path(g, [{ x: mf.stemX, y: mf.stemTop }, { x: mf.stemX, y: mf.y }], 4, pipe);
      path(g, [{ x: mf.x0, y: mf.y }, { x: mf.x1, y: mf.y }], 4, pipe);
    }
    for (const col of m.hall.collars) { path(g, col, 8, css(c.k)); path(g, col, 4, pipe); }
  }

  // Supply lines: lit ones always, the rest only for what's hovered.
  const shown = (l: DrawLink) => l.lit || (hover && (hover.key === l.stationKey || hover.key === l.envId));
  const trunk = style.trunk ?? c.D;
  for (const l of m.links) if (l.lit) path(g, l.points, 12, css(trunk));
  for (const l of m.links) if (l.lit) path(g, l.points, 4, css(l.color, hover && hover.key !== l.stationKey && hover.key !== l.envId ? 0.35 : 1));
  if (hover) for (const l of m.links) if (!l.lit && shown(l)) { path(g, l.points, 8, css(c.k, 0.8)); path(g, l.points, 4, css(l.color), 8); }

  // Hall.
  if (m.hall) {
    const h = m.hall.hull;
    plate(g, h, 16);
    frame(g, { x: h.x + 6, y: h.y + 6, w: h.w - 12, h: h.h - 12 }, HERMES_COLOR, 2);
    text(g, "HERMES", h.x + 24, h.y + 22, HERMES_COLOR, Math.max(unit, 3));
    for (const o of m.hall.operators) {
      g.fillStyle = css(c.D); g.fillRect(o.rect.x, o.rect.y, o.rect.w, o.rect.h);
      draw(g, KIT.CONSOLE, o.rect.x + o.rect.w / 2, o.rect.y + 10, 0.5, 0, { screen: 0x3b4d5a });
      draw(g, flightCrew("round", "standard", "behind", "typeA"), o.rect.x + o.rect.w / 2, o.rect.y + 92, 0.5, 1, { team: HERMES_COLOR, visor: 0xc8b48c });
      text(g, o.name, o.rect.x + 8, o.rect.y + o.rect.h - 18, ink.muted, unit, o.rect.w - 16);
    }
  }

  // Engineering decks.
  for (const d of m.decks) {
    draw(g, KIT.ENGINEERING_DECK, d.rect.x, d.rect.y, 0, 0, { team: d.color });
    ENGINEERING_SPOTS.cells.forEach((cell, k) => {
      if (k >= d.working) return;
      g.fillStyle = css(STATUS.working);
      g.fillRect(d.rect.x + cell.x * PX, d.rect.y + cell.y * PX, cell.w * PX, cell.h * PX);
    });
    const w = Math.min(d.rect.w - 16, d.name.length * 6 * unit + 12);
    g.fillStyle = css(c.k); g.fillRect(d.rect.x + 8, d.rect.y - 10, w, 7 * unit + 10);
    frame(g, { x: d.rect.x + 8, y: d.rect.y - 10, w, h: 7 * unit + 10 }, d.color, 2);
    text(g, d.name, d.rect.x + 14, d.rect.y - 5, d.color, unit, w - 12);
  }

  // Full stations.
  for (const s of m.stations) station(g, s, m, unit, ink);
  const crewAt = new Map<string, Array<DrawModel["crew"][number]>>();
  for (const cr of m.crew) crewAt.set(`${cr.at.x},${cr.at.y}`, [...(crewAt.get(`${cr.at.x},${cr.at.y}`) ?? []), cr]);
  for (const cr of m.crew) {
    if (cr.sleeping) { draw(g, KIT.CRYO_SLEEPER, cr.at.x, cr.at.y, 0.5, 0.5, { team: cr.color }); continue; }
    draw(g, flightCrew("round", "standard", "behind", "typeA"), cr.at.x, cr.at.y, 0.5, 1, { team: cr.color, visor: 0xc8b48c });
    glyph(g, STATUS_GLYPHS[cr.state], cr.at.x - 5, cr.at.y - 62, STATUS[cr.state], PX);
  }

  // Cryo modules.
  for (const s of m.modules) {
    const room = s.room!;
    text(g, s.name, s.hull.x, s.hull.y - 22, ink.text, unit, s.hull.w);
    plate(g, s.hull, 12);
    tile(g, KIT.FLOOR_QUARTERS, room);
    for (let k = 0; k < QUARTERS_SHOWN; k++) { const at = podAt(room, k); draw(g, KIT.CRYO_EMPTY, at.x, at.y, 0.5, 0.5); }
    // Nobody is awake aboard, so the room sits in shadow; its sleepers render above it.
    g.fillStyle = css(style.space, 0.38); g.fillRect(room.x, room.y, room.w, room.h);
    for (const cr of m.crew) {
      if (cr.sleeping && cr.at.x >= room.x && cr.at.x <= room.x + room.w && cr.at.y >= room.y && cr.at.y <= room.y + room.h) draw(g, KIT.CRYO_SLEEPER, cr.at.x, cr.at.y, 0.5, 0.5, { team: cr.color });
    }
    frame(g, { x: room.x - 4, y: room.y - 4, w: room.w + 8, h: room.h + 8 }, style.wall);
    g.fillStyle = css(c.k); g.fillRect(s.port.x - 8, s.hull.y - 6, 16, 8);
    const foot = room.y + room.h + 8;
    chips(g, s.colors, s.litColors, s.hull.x + 16, foot + 3, false);
    if (unit <= PX) text(g, `${s.settled} settled`, s.hull.x + s.hull.w - 14 - `${s.settled} settled`.length * 6 * unit, foot, ink.muted, unit);
  }

  // The dock.
  if (m.rack) {
    const r = m.rack;
    plate(g, r, 12, c.D);
    if (unit <= PX) text(g, `Dock · ${m.capsules.length} quiet projects`, r.x + 16, r.y + 10, ink.muted, unit);
    for (const s of m.capsules) {
      const h = s.hull;
      stepped(g, h.x - PX, h.y - PX, h.w + 2 * PX, h.h + 2 * PX, 8, c.k);
      stepped(g, h.x, h.y, h.w, h.h, 6, c.H);
      g.fillStyle = css(c.h); g.fillRect(h.x + 6, h.y + 2, h.w - 12, 2);
      chips(g, s.colors, s.litColors, h.x + 8, h.y + 8, true);
      const days = Math.max(1, Math.round((Date.now() - s.lastActive) / 86_400_000));
      // Capsule text is small deck text: it hides once a font pixel outgrows the capsule.
      if (unit <= PX) {
        text(g, s.name, h.x + 22, h.y + 8, ink.text, unit, h.w - 30);
        text(g, s.lastActive ? `quiet ${days}d` : "no runs", h.x + 22, h.y + 24, ink.muted, unit, h.w - 30);
      }
    }
  }

  // Hover outline: white on a dark art-pixel outline (the map's selection rule).
  if (hover) {
    const r = hover.rect;
    frame(g, { x: r.x - 8, y: r.y - 8, w: r.w + 16, h: r.h + 16 }, c.k, 6);
    frame(g, { x: r.x - 6, y: r.y - 6, w: r.w + 12, h: r.h + 12 }, 0xffffff, 2);
  }
}

function station(g: Ctx, entry: DrawModel["stations"][number], m: DrawModel, unit: number, ink: { text: number; muted: number }) {
  const s = entry.layout;
  const xs = s.hull.filter((_, k) => k % 2 === 0), ys = s.hull.filter((_, k) => k % 2 === 1);
  const hull = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  text(g, s.name, s.nameplate.x, s.nameplate.y + 8, ink.text, unit, hull.w);
  // The caption hides once its font pixels would be bigger than the nameplate has room for.
  const sub = [entry.awake ? `${entry.awake} on duty` : "quiet", entry.settled ? `${entry.settled} settled` : ""].filter(Boolean).join(" · ");
  if (unit <= PX) text(g, sub, s.nameplate.x, s.nameplate.y + 8 + 7 * unit + 6, ink.muted, unit, hull.w);
  plate(g, hull, 28);
  const i = s.interior;
  tile(g, KIT.FLOOR, i);
  if (s.rooms.bridge) tile(g, KIT.FLOOR_BRIDGE, s.rooms.bridge.rect);
  if (s.rooms.quarters) tile(g, KIT.FLOOR_QUARTERS, s.rooms.quarters.rect);
  for (const [kind, grid] of [["terminal", KIT.TERMINAL], ["files", KIT.FILES], ["comms", KIT.COMMS]] as const) {
    const r = s.rooms[kind]?.rect;
    if (r) draw(g, grid, systemFixtureX(r), r.y + r.h - 6, 0.5, 1, { screen: SCREEN_OFF });
  }
  for (const p of s.consoles) {
    draw(g, KIT.CHAIR, p.x, p.y + 22, 0.5, 1);
    draw(g, KIT.CONSOLE, p.x, p.y - 26, 0.5, 0, { screen: entry.awake ? 0x3d8fa0 : SCREEN_OFF });
  }
  const q = s.rooms.quarters?.rect;
  if (q) for (let k = 0; k < QUARTERS_SHOWN; k++) { const at = podAt(q, k); draw(g, KIT.CRYO_EMPTY, at.x, at.y, 0.5, 0.5); }
  const ar = s.rooms.archive?.rect;
  if (ar) for (let y = ar.y + 8; y + 18 <= ar.y + ar.h - 4; y += 26) for (let x = ar.x + 4; x + 28 <= ar.x + ar.w - 2; x += 30) draw(g, KIT.SHELF, x, y, 0, 0, { team: c.m });
  // Rooms nobody is using sit in shadow; the bridge is lit while crew are aboard.
  for (const room of Object.values(s.rooms)) {
    if (!room || (room.kind === "bridge" && entry.awake)) continue;
    g.fillStyle = css(style.space, 0.38); g.fillRect(room.rect.x, room.rect.y, room.rect.w, room.rect.h);
  }
  for (const room of Object.values(s.rooms)) if (room) frame(g, { x: room.rect.x - 2, y: room.rect.y - 2, w: room.rect.w + 4, h: room.rect.h + 4 }, style.wall);
  frame(g, { x: i.x - 4, y: i.y - 4, w: i.w + 8, h: i.h + 8 }, style.wall);
  for (const d of s.doors) {
    g.fillStyle = css(c.m);
    if (d.vertical) g.fillRect(d.x - 4, d.y - 16, 8, 32); else g.fillRect(d.x - 16, d.y - 4, 32, 8);
  }
  if (m.chips) {
    // One chip per serving machine on the port plate; bright while that machine has crew here.
    const n = entry.colors.length;
    g.fillStyle = css(c.k); g.fillRect(s.port.x - 8, s.port.y - n * 5 - 6, 16, n * 10 + 12);
    chips(g, entry.colors, entry.litColors, s.port.x - 4, s.port.y - n * 5, true);
  } else {
    const plateH = Math.max(40, Math.round((12 * s.members.length + 16) / 4) * 4);
    g.fillStyle = css(c.k); g.fillRect(s.port.x - 6, s.port.y - plateH / 2, 12, plateH);
    g.fillStyle = css(c.D); g.fillRect(s.port.x - 4, s.port.y - plateH / 2 + 2, 8, plateH - 4);
  }
}
