// Helpers and constants shared by the map's sprites and the World.

import { Sprite, type Graphics } from "pixi.js";
import { PixelText } from "./pixel-text";
import { fitText } from "../art/pixelfont";
import * as A from "../art/sprites";
import type { UnitState } from "../t3/derive";
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
export function fitLabel(label: PixelText, full: string, width: number, zoom: number): void {
  const k = crispScale(label.unit, zoom);
  label.scale.set(k);
  label.text = fitText(full, width * zoom, label.unit * zoom * k);
}

/**
 * Zoom levels the camera settles on. Art is drawn at PX=2 world px per art pixel, and map text
 * at 1–3 world px per font pixel; at these steps both land on whole screen pixels (zoomed far
 * out, art drops on a regular pattern and labels hold a crisp minimum). In-between steps
 * (0.75, 1.5, 2.5) made text swell, shrink back and re-truncate relative to its plate as you
 * zoomed, which read as jitter. 1/3 stays as the one far-out in-between; from there down the map is
 * the fleet view (FLEET_VIEW_ZOOM).
 */
export const ZOOM_STEPS = [0.125, 1 / 6, 0.25, 1 / 3, 0.5, 1, 2, 3];

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
export function linkPoint(from: Point, to: Point, k: number, via?: Point[]): Point {
  const midX = (from.x + to.x) / 2;
  const points = [from, ...(via ?? [{ x: midX, y: from.y }, { x: midX, y: to.y }]), to];
  const progress = k * (points.length - 1);
  const i = Math.min(points.length - 2, Math.floor(progress));
  const a = points[i], b = points[i + 1], t = progress - i;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
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

/** Console screen color for a crew member's state; blinks and flicker alternate per frame. */
export function screenColor(state: UnitState, frame: number, atConsole: boolean): number {
  switch (state) {
    case "working":
      return atConsole ? (frame % 2 ? STATUS.working : 0x9ff0ff) : 0x2a6f80;
    case "monitoring":
      return 0x7a5fb8;
    case "alert":
      return frame % 2 ? STATUS.alert : 0x7a1820;
    case "question":
      return frame % 2 ? STATUS.question : 0x7a6418;
    case "done":
      return STATUS.done;
    case "error":
      return STATUS.error;
    default:
      return SCREEN_OFF;
  }
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
      if (((x / cell) + row) % 2 !== 0) continue;
      g.rect(Math.round((fx + x) / cell) * cell, Math.round((fy - 6 + row * cell) / cell) * cell, cell, cell).fill({ color, alpha: 0.16 * fade });
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
