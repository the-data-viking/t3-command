// Helpers and constants shared by the map's sprites and the World.

import { Sprite, type Graphics } from "pixi.js";
import { PixelText } from "./pixel-text";
import { fitText, fitTextMiddle } from "../art/pixelfont";
import * as A from "../art/sprites";
import type { UnitState } from "../t3/derive";
import type { Arms, Head } from "../art/render";
import type { Point } from "./layout";
import { PX, tex } from "./textures";
import { STATUS } from "./theme";


/** Map labels share the sprites' pixel world. */
export function label(size: number, fill: number): PixelText {
  return new PixelText(size, fill);
}

/**
 * Scale for a pixel-font label so each font pixel covers a whole number of screen pixels (at
 * least one). Nearest-neighbour sampling at in-between scales drops whole glyph columns ("CPU"
 * reading "CPJ"); whole numbers keep every letter.
 */
export function crispScale(unit: number, zoom: number): number {
  const screen = unit * zoom;
  return Math.max(1, Math.round(screen)) / screen;
}

/**
 * Size a label for the zoom at a whole number of screen pixels per font pixel (crisp, never
 * sub-pixel mush), shortened to fit `width` world px.
 */
export function fitLabel(label: PixelText, full: string, width: number, zoom: number, middle = false): void {
  const k = crispScale(label.unit, zoom);
  label.scale.set(k);
  label.text = (middle ? fitTextMiddle : fitText)(full, width * zoom, label.unit * zoom * k);
}

/**
 * Zoom levels the camera settles on. Art is drawn at PX=2 world px per art pixel, and map text
 * at 1–3 world px per font pixel; at these steps both land on whole screen pixels (zoomed far
 * out, art drops on a regular pattern and labels hold a crisp minimum). In-between steps
 * (0.75, 1.5, 2.5) made text swell, shrink back and re-truncate relative to its plate as you
 * zoomed, which read as jitter. Below FLEET_VIEW_ZOOM the map is the
 * flat fleet view, where any step with whole-pixel glyph cells (3/zoom) is crisp, so 3/8 and 3/7
 * are there too: "fit" lands close to filling the screen instead of dropping to 1/3.
 */
export const ZOOM_STEPS = [0.125, 1 / 6, 0.25, 1 / 3, 3 / 8, 3 / 7, 0.5, 1, 2, 3];

/**
 * Below this zoom the map is the fleet view: stations as flat room blocks, and one status glyph
 * per crew member instead of sprites, which would pile up and break apart at that scale.
 */
export const FLEET_VIEW_ZOOM = 0.5;

/** The nearest zoom step (in log space, so in and out feel the same). */
export function snapZoom(z: number): number {
  let best = ZOOM_STEPS[0];
  for (const s of ZOOM_STEPS) if (Math.abs(Math.log(s / z)) < Math.abs(Math.log(best / z))) best = s;
  return best;
}

/** The largest zoom step that's no more than `z` (for framing: never crop what should fit). */
export function floorZoom(z: number): number {
  return [...ZOOM_STEPS].reverse().find((s) => s <= z + 1e-6) ?? ZOOM_STEPS[0];
}

/**
 * Extra scale for small figures (crew, operators) zoomed out: held at one screen pixel per art
 * pixel rather than shrinking into mush, but never larger than that.
 */
export function figureBoost(zoom: number, px: number): number {
  const screen = px * zoom;
  return screen >= 1 ? 1 : 1 / screen;
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Fixed supply-line geometry is independent of the animated packets travelling along it. */
/** The corners of a supply line: from, its route (or a mid-way elbow), to. Every leg is axis-aligned. */
export function linkPath(from: Point, to: Point, via?: Point[]): Point[] {
  const midX = (from.x + to.x) / 2;
  return [from, ...(via ?? [{ x: midX, y: from.y }, { x: midX, y: to.y }]), to];
}

/** Length of a supply route (its legs are axis-aligned). */
export function linkLength(from: Point, to: Point, via?: Point[]): number {
  const points = linkPath(from, to, via);
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
  return length;
}

/** The point `k` (0–1) of the way along a route by distance, so packets keep one speed round every bend. */
export function linkPoint(from: Point, to: Point, k: number, via?: Point[]): Point {
  const points = linkPath(from, to, via);
  let left = k * linkLength(from, to, via);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const leg = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (left <= leg || i === points.length - 1) {
      const t = leg ? Math.min(1, left / leg) : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= leg;
  }
  return to;
}

export function sprite(texture: ReturnType<typeof tex>, x: number, y: number, ax = 0, ay = 0, scale = PX): Sprite {
  const s = new Sprite(texture);
  s.anchor.set(ax, ay);
  s.scale.set(scale);
  s.position.set(Math.round(x), Math.round(y));
  return s;
}

export const WALK_SPEED = 75; // px per second, constant like FTL crew
/** Side-by-side spacing for crew sharing one system room. */
export const CREW_SPACING = 34;
/** Recruitment beam-in and camera moves; both are skipped under prefers-reduced-motion. */
export const BEAM_SECONDS = 0.9;
/** How long sparks fly after a failed turn before it settles into a scorch mark. */
export const SPARK_MS = 60_000;
/** How long the report-ready sparkle lasts. */
export const REPORT_MS = 1600;
export const CAMERA_SECONDS = 0.35;
/** Theme changes crossfade from the old look over this long. */
export const FADE_SECONDS = 0.45;
/** Rooms nobody is using sit in this much shadow; crew and lit rooms stay bright. */
export const ROOM_SHADOW = 0.32;
/** A crew member this new appearing on an already-loaded station was just recruited. */
export const RECRUIT_WINDOW_MS = 120_000;

export const clampZoom = (z: number) => Math.min(3, Math.max(0.12, z));

export const DOOR_ART = { closed: A.DOOR_H, half: A.DOOR_H_HALF, open: A.DOOR_H_OPEN };

export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
export const SCREEN_OFF = 0x1c2228;

/** A status colour stepped down toward an unlit screen (k 0–1), so a dim screen keeps its hue. */
function dimmed(color: number, k: number): number {
  const ch = (c: number, s: number) => (c >> s) & 255;
  const m = (s: number) => Math.round(ch(color, s) * (1 - k) + ch(SCREEN_OFF, s) * k);
  return (m(16) << 16) | (m(8) << 8) | m(0);
}

/** Console screen color for a crew member's state; blinks and flicker alternate per frame. */
export function screenColor(state: UnitState, frame: number, atConsole: boolean): number {
  switch (state) {
    case "working":
      return atConsole ? (frame % 2 ? STATUS.working : 0x9ff0ff) : dimmed(STATUS.working, 0.55);
    case "monitoring":
      return dimmed(STATUS.monitoring, 0.3);
    case "alert":
      return frame % 2 ? STATUS.alert : dimmed(STATUS.alert, 0.45);
    case "question":
      return frame % 2 ? STATUS.question : dimmed(STATUS.question, 0.45);
    case "done":
      return STATUS.done;
    case "error":
      return STATUS.error;
    default:
      return SCREEN_OFF;
  }
}

/**
 * How someone seated at a console sits, from their state: typing while working, a hand up and
 * waving while they wait on you, leaning back with a report ready, head bowed after a failure.
 * Otherwise they now and then glance left or right (seeded, so neighbours don't move in step).
 * Offline crew hold still.
 */
export function seatedPose(state: UnitState, frame: number, t: number, seed: number, offline = false): { arms: Arms; head: Head } {
  if (offline) return { arms: "idle", head: "" };
  if (state === "working") return { arms: frame % 2 ? "typeA" : "typeB", head: Math.floor(t * 1.5 + seed * 20) % 9 === 0 ? "down" : "" };
  if (state === "alert" || state === "question") return { arms: frame % 4 < 2 ? "raise" : "raiseB", head: "" };
  if (state === "done") return { arms: "relax", head: "" };
  if (state === "error") return { arms: "idle", head: "down" };
  const glance = Math.sin(t * 0.7 + seed * 40);
  return { arms: "idle", head: glance > 0.85 ? "right" : glance < -0.85 ? "left" : "" };
}

export const BADGES: Partial<Record<UnitState, A.Grid>> = {
  alert: A.BADGE_ALERT,
  question: A.BADGE_QUESTION,
  done: A.BADGE_DONE,
  error: A.BADGE_ERROR,
  monitoring: A.BADGE_MONITOR,
};

// ---- Pixel-native drawing ---------------------------------------------------------------------
// The map is pixel art: shapes are built from cells on the art grid (PX world px), never smooth
// ellipses, rounded rectangles or hairlines (see docs/ART_DIRECTION.md, "Art bible").

/** An oval ring plotted as whole art-pixel cells. */
export function pixelOval(g: Graphics, cx: number, cy: number, rx: number, ry: number, color: number, alpha = 1, cell = PX): void {
  const seen = new Set<string>();
  const steps = Math.max(16, Math.ceil((Math.PI * (rx + ry)) / cell) * 2);
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const x = Math.round((cx + Math.cos(a) * rx) / cell) * cell;
    const y = Math.round((cy + Math.sin(a) * ry) / cell) * cell;
    const key = `${x},${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    g.rect(x - cell / 2, y - cell / 2, cell, cell).fill({ color, alpha });
  }
}

/** A plate with quarter-circle corners of radius `r`, drawn in 2-px rows (no smooth curves). */
export function roundedPlate(g: Graphics, x: number, y: number, w: number, h: number, r: number, color: number): void {
  g.rect(x, y + r, w, h - 2 * r).fill(color);
  for (let row = 0; row < r; row += 2) {
    const inset = Math.round((r - Math.sqrt(r * r - (r - row - 1) ** 2)) / 2) * 2;
    g.rect(x + inset, y + row, w - 2 * inset, 2).fill(color);
    g.rect(x + inset, y + h - row - 2, w - 2 * inset, 2).fill(color);
  }
}

/** A plate with stepped (staircase) chamfered corners: `cut` deep, in `step`-sized stairs. */
export function steppedPlate(g: Graphics, x: number, y: number, w: number, h: number, cut: number, step: number, color: number, alpha = 1): void {
  const n = Math.max(1, Math.round(cut / step));
  g.rect(x, y + n * step, w, h - 2 * n * step).fill({ color, alpha });
  for (let j = 0; j < n; j++) {
    const inset = (n - j) * step;
    g.rect(x + inset, y + j * step, w - 2 * inset, step).fill({ color, alpha });
    g.rect(x + inset, y + h - (j + 1) * step, w - 2 * inset, step).fill({ color, alpha });
  }
}

/** A rectangular outline one art pixel (`cell`) wide, inside the box: no centred hairline strokes. */
export function pixelFrame(g: Graphics, x: number, y: number, w: number, h: number, color: number, alpha = 1, cell = PX): void {
  g.rect(x, y, w, cell).fill({ color, alpha });
  g.rect(x, y + h - cell, w, cell).fill({ color, alpha });
  g.rect(x, y + cell, cell, h - 2 * cell).fill({ color, alpha });
  g.rect(x + w - cell, y + cell, cell, h - 2 * cell).fill({ color, alpha });
}

/**
 * The outline of a chamfered box (corners cut by `cut`), `width` thick, with the cut corners as
 * pixel staircases of `width`-sized cells rather than smooth diagonal strokes.
 */
export function chamferOutline(g: Graphics, x: number, y: number, w: number, h: number, cut: number, color: number, width = 2 * PX): void {
  const c = Math.round(cut / width) * width;
  g.rect(x + c, y, w - 2 * c, width).fill(color);
  g.rect(x + c, y + h - width, w - 2 * c, width).fill(color);
  g.rect(x, y + c, width, h - 2 * c).fill(color);
  g.rect(x + w - width, y + c, width, h - 2 * c).fill(color);
  for (let k = width; k < c; k += width) {
    // One step of each corner's staircase, k in from the corner.
    g.rect(x + c - k, y + k, width, width).fill(color);
    g.rect(x + w - c + k - width, y + k, width, width).fill(color);
    g.rect(x + c - k, y + h - k - width, width, width).fill(color);
    g.rect(x + w - c + k - width, y + h - k - width, width, width).fill(color);
  }
}

/**
 * An orthogonal path drawn as runs of `width`-thick cells on the art grid (no centred hairline
 * strokes). With `dash`, only every other `dash`-long stretch is drawn: a severed line.
 */
export function pixelPath(g: Graphics, points: Point[], width: number, color: number, alpha = 1, dash = 0): void {
  const snap = (v: number) => Math.round(v / PX) * PX;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = { x: snap(points[i].x), y: snap(points[i].y) }, b = { x: snap(points[i + 1].x), y: snap(points[i + 1].y) };
    // A diagonal leg (not expected on supply routes) becomes an elbow.
    const legs = a.x !== b.x && a.y !== b.y ? [[a, { x: b.x, y: a.y }], [{ x: b.x, y: a.y }, b]] : [[a, b]];
    for (const [p, q] of legs) {
      const horizontal = p.y === q.y;
      const start = horizontal ? Math.min(p.x, q.x) : Math.min(p.y, q.y);
      const length = horizontal ? Math.abs(q.x - p.x) : Math.abs(q.y - p.y);
      const step = dash || length + width;
      for (let d = 0; d < length + width; d += dash ? 2 * dash : step) {
        const run = Math.min(dash || length + width, length + width - d);
        if (horizontal) g.rect(start + d, p.y, run, width).fill({ color, alpha });
        else g.rect(p.x, start + d, width, run).fill({ color, alpha });
      }
    }
  }
}

/** Arrowheads pointing right (dir 0) and up-right (dir 7), in 3-px cells; other directions rotate these. */
const ARROW_STRAIGHT = ["#....", "###..", "#####", "###..", "#...."];
const ARROW_DIAGONAL = ["#####", ".####", "..###", "...##", "....#"];

/**
 * An outlined pixel arrowhead centred on (cx, cy), pointing in one of eight directions (0 = right,
 * counting clockwise in 45° steps, so 2 = down, 6 = up), drawn in 3-px screen cells.
 */
export function pixelArrow(g: Graphics, cx: number, cy: number, dir: number, color: number, cell = 3): void {
  let grid = dir % 2 === 0 ? ARROW_STRAIGHT : ARROW_DIAGONAL;
  // Rotate clockwise 90° per quarter turn past the base direction (0 for straight, 7 for diagonal).
  const turns = dir % 2 === 0 ? dir / 2 : ((dir + 1) / 2) % 4;
  for (let k = 0; k < turns; k++) grid = grid[0].split("").map((_, x) => grid.map((row) => row[x]).reverse().join(""));
  const x0 = cx - 2.5 * cell, y0 = cy - 2.5 * cell;
  const filled: Array<[number, number]> = [];
  grid.forEach((row, y) => [...row].forEach((c, x) => { if (c === "#") filled.push([x, y]); }));
  for (const [x, y] of filled) g.rect(x0 + (x - 1) * cell, y0 + (y - 1) * cell, 3 * cell, 3 * cell).fill(0x000000);
  for (const [x, y] of filled) g.rect(x0 + x * cell, y0 + y * cell, cell, cell).fill(color);
}

/** 7×7 connection marks: a pulled plug for a machine that's unreachable, a parted chain link
 * while it's reconnecting or its readings are stale. Neutral grey, never a status colour. */
export const UNPLUGGED = ["..#.#..", "..#.#..", ".#####.", ".#####.", "..###..", "...#...", "...#..."];
export const BROKEN_LINK = ["###....", "#.#....", "###.#..", ".......", "..#.###", "....#.#", "....###"];
export const SIGNAL_GREY = 0x8a919a;

/** A small stamp: the grid's "#" cells in `fill`, ringed one cell wide in `outline` so it reads on
 * any backdrop. `x, y` is the grid's top-left; the ring reaches one cell beyond it. */
export function pixelStamp(g: Graphics, grid: string[], x: number, y: number, fill: number, outline: number, cell = PX): void {
  const on = (cx: number, cy: number) => grid[cy]?.[cx] === "#";
  for (let cy = -1; cy <= grid.length; cy++) {
    for (let cx = -1; cx <= grid[0].length; cx++) {
      if (on(cx, cy)) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) near = on(cx + dx, cy + dy);
      if (near) g.rect(x + cx * cell, y + cy * cell, cell, cell).fill(outline);
    }
  }
  grid.forEach((row, cy) => [...row].forEach((ch, cx) => { if (ch === "#") g.rect(x + cx * cell, y + cy * cell, cell, cell).fill(fill); }));
}

/** A filled box with a `width`-thick outline inside its edge (instead of a centred stroke). */
export function pixelBox(g: Graphics, x: number, y: number, w: number, h: number, fill: number, outline: number, width = PX): void {
  g.rect(x, y, w, h).fill(outline);
  g.rect(x + width, y + width, w - 2 * width, h - 2 * width).fill(fill);
}

/** A pixel diamond (centre, half-size), drawn in `cell` rows. */
export function pixelDiamond(g: Graphics, cx: number, cy: number, r: number, color: number, cell = PX): void {
  for (let dy = -r; dy <= r; dy += cell) {
    const half = r - Math.abs(dy);
    g.rect(cx - half, cy + dy - cell / 2, half * 2 || cell, cell).fill(color);
  }
}

/**
 * Light spilling from a screen into its room: a dithered cone (checkerboard cells that thin out
 * with distance) instead of a soft rectangle.
 */
export function lightSpill(g: Graphics, fx: number, fy: number, color: number, cell = 4): void {
  for (let row = 0; row < 7; row++) {
    const half = 8 + row * 5;
    const fade = 1 - row / 7;
    for (let x = -half; x < half; x += cell) {
      // Checker on whole cells (a fractional index skipped every row whose width isn't a multiple of 4).
      const col = Math.round((fx + x) / cell);
      if ((((col + row) % 2) + 2) % 2 !== 0) continue;
      g.rect(col * cell, Math.round((fy - 6 + row * cell) / cell) * cell, cell, cell).fill({ color, alpha: 0.16 * fade });
    }
  }
}

/**
 * The colour a dark room is multiplied by: the style's floor seam brightened to about 70%, so an
 * unlit room keeps its theme's hue (a warm deck dims warm) instead of greying under black.
 */
export function shadeColor(seam: number): number {
  const r = (seam >> 16) & 255, gr = (seam >> 8) & 255, b = seam & 255;
  const k = (0.7 * 255) / Math.max(1, r, gr, b);
  const c = (v: number) => Math.min(255, Math.round(v * k));
  return (c(r) << 16) | (c(gr) << 8) | c(b);
}
