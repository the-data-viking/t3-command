// Helpers and constants shared by the map's sprites and the World.

import { Sprite } from "pixi.js";
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
 * Zoom levels the camera settles on. Art is drawn at PX=2 world px per art pixel, so at these
 * steps every art pixel covers whole screen pixels (or, zoomed far out, drops on a regular
 * pattern). 0.75 and 1/3 are kept as in-betweens so fitting the fleet isn't too coarse.
 */
export const ZOOM_STEPS = [0.125, 1 / 6, 0.25, 1 / 3, 0.5, 0.75, 1, 1.5, 2, 2.5, 3];

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
