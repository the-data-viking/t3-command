// Light you can almost feel, still in pixels: dithered cones under lit ceiling tubes, a pool in
// front of each console someone is working at, and a spotlight on whoever is waiting on you.
// Each shape is baked once per colour into a texture and drawn additively from a sprite pool, so
// a lit fleet costs a few dozen sprites a frame rather than thousands of rects. Only rooms in real
// use light up; nothing here keeps the render loop running.

import { Container, Sprite, Texture } from "pixi.js";

/** A 4×4 ordered-dither matrix: cells light in an even pattern as density rises. */
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
/** One art pixel in world px. */
const CELL = 2;

type Shape = "cone" | "pool" | "spot";

const cache = new Map<string, Texture>();

/** Mix two colours by k (0–1). */
export function mixColor(a: number, b: number, k: number): number {
  const ch = (c: number, s: number) => (c >> s) & 255;
  const m = (s: number) => Math.round(ch(a, s) * (1 - k) + ch(b, s) * k);
  return (m(16) << 16) | (m(8) << 8) | m(0);
}

/**
 * The shapes, in world px: a cone widening from a 20-px tube to 48 px over 28 px; an oval floor
 * pool 40×16; a spotlight from an 8-px source to a 40-px floor over 72 px. Three bands each,
 * sparser and fainter outward.
 */
const SIZES: Record<Shape, { w: number; h: number }> = { cone: { w: 48, h: 28 }, pool: { w: 40, h: 16 }, spot: { w: 40, h: 72 } };

function texture(shape: Shape, color: number): Texture {
  const key = `${shape}:${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { w, h } = SIZES[shape];
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const rgb = `${(color >> 16) & 255},${(color >> 8) & 255},${color & 255}`;
  for (let y = 0; y < h; y += CELL) {
    for (let x = 0; x < w; x += CELL) {
      const cx = x + CELL / 2, cy = y + CELL / 2;
      // How far out from the shape's core this cell is, 0 (core) to 1 (edge); ≥1 is outside.
      let t: number;
      if (shape === "pool") t = Math.hypot((cx - w / 2) / (w / 2), (cy - h / 2) / (h / 2));
      else {
        const top = shape === "cone" ? 20 : 8;
        const half = (top + (w - top) * (cy / h)) / 2;
        const across = Math.abs(cx - w / 2) / half;
        t = Math.max(across, shape === "spot" ? 0 : cy / h * 0.9);
      }
      if (t >= 1) continue;
      const band = t < 0.4 ? 0 : t < 0.7 ? 1 : 2;
      const density = [0.75, 0.5, 0.3][band];
      if (BAYER[(y / CELL) & 3][(x / CELL) & 3] / 16 >= density) continue;
      const alpha = (shape === "spot" ? [0.4, 0.24, 0.12] : [0.26, 0.15, 0.07])[band];
      ctx.fillStyle = `rgba(${rgb},${alpha})`;
      ctx.fillRect(x, y, CELL, CELL);
    }
  }
  const t = Texture.from(canvas);
  t.source.scaleMode = "nearest";
  cache.set(key, t);
  return t;
}

/** A pool of additive light sprites, reused frame to frame. */
export class LightLayer {
  readonly root = new Container();
  private sprites: Sprite[] = [];
  private used = 0;

  begin(): void {
    this.used = 0;
  }

  /** Light of `shape` in `color`, centred on x, with its top at y (cone, spot) or centred (pool). */
  add(shape: Shape, color: number, x: number, y: number): void {
    let s = this.sprites[this.used];
    if (!s) {
      s = new Sprite();
      s.blendMode = "add";
      s.eventMode = "none";
      this.sprites.push(s);
      this.root.addChild(s);
    }
    const tex = texture(shape, color);
    if (s.texture !== tex) s.texture = tex;
    s.anchor.set(0.5, shape === "pool" ? 0.5 : 0);
    s.position.set(Math.round(x / CELL) * CELL, Math.round(y / CELL) * CELL);
    s.visible = true;
    this.used++;
  }

  end(): void {
    for (let i = this.used; i < this.sprites.length; i++) this.sprites[i].visible = false;
  }
}
