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
 * Size a label for the zoom: world-scaled when that's at least one screen pixel per font pixel,
 * otherwise held at exactly one (crisp, not sub-pixel mush), shortened to fit `width` world px.
 */
export function fitLabel(label: PixelText, full: string, width: number, zoom: number): void {
  const screen = label.unit * zoom;
  label.scale.set(screen < 1 ? 1 / screen : 1);
  label.text = fitText(full, width * zoom, Math.max(1, screen));
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

/** Zoom below which crew are drawn larger and labels hold a minimum on-screen size. */
export const STRATEGIC_ZOOM = 0.55;
export const WALK_SPEED = 75; // px per second, constant like FTL crew
/** Side-by-side spacing for crew sharing one system room. */
export const CREW_SPACING = 34;
/** Recruitment beam-in and camera moves; both are skipped under prefers-reduced-motion. */
export const BEAM_SECONDS = 0.9;
/** How long sparks fly after a failed turn before it settles into a scorch mark. */
export const SPARK_MS = 60_000;
export const CAMERA_SECONDS = 0.35;
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
