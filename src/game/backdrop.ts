// The space behind the fleet: parallax layers of dim stars and nebulae, distant pixel-art planets,
// nearer stars, and a few bright ones that twinkle while the map is animating anyway. Nothing here
// keeps the render loop running; panning shows the depth.

import { Container, Graphics, Rectangle, TilingSprite, type Renderer, type Texture } from "pixi.js";
import type { StyleId } from "../art/palettes";
import { STYLES } from "../art/palettes";
import { hash } from "./map-common";

/** Nebula tints and planet colors (light, mid, shade) per theme. */
const SKY: Record<StyleId, { nebula: number[]; planets: Array<[number, number, number]>; nebulaAlpha: number }> = {
  "flightdeck-nightshift": { nebula: [0x1a1033, 0x0b1f2e, 0x2a1220], planets: [[0x6f8fa8, 0x3d566b, 0x1c2733], [0xb08a6a, 0x6e5240, 0x2d2119]], nebulaAlpha: 0.05 },
  nightshift: { nebula: [0x1a1033, 0x0b1f2e, 0x2a1220], planets: [[0x6f8fa8, 0x3d566b, 0x1c2733], [0xb08a6a, 0x6e5240, 0x2d2119]], nebulaAlpha: 0.05 },
  flightdeck: { nebula: [0x2b1a10, 0x1b1f2e, 0x2e1c12], planets: [[0xd0a070, 0x8a6040, 0x3a2818], [0x8fa6b8, 0x56697a, 0x232c35]], nebulaAlpha: 0.06 },
  signal: { nebula: [0x0e2a40, 0x14233f, 0x0a3038], planets: [[0x7fc4d6, 0x3f7f92, 0x163440], [0xd9b98f, 0x957552, 0x3b2c1d]], nebulaAlpha: 0.07 },
  pastel: { nebula: [0x3a1f4a, 0x23305a, 0x4a2140], planets: [[0xffc6d9, 0xc58aa8, 0x5a3a5a], [0xa8d8ff, 0x6f9ccc, 0x33466a]], nebulaAlpha: 0.08 },
  highcontrast: { nebula: [], planets: [], nebulaAlpha: 0 },
};

interface Layer { sprite: TilingSprite; parallax: number; twinkle?: number }

function texture(renderer: Renderer, size: number, draw: (g: Graphics) => void): Texture {
  const g = new Graphics();
  g.rect(0, 0, size, size).fill({ color: 0x000000, alpha: 0 });
  draw(g);
  const t = renderer.generateTexture({ target: g, frame: new Rectangle(0, 0, size, size) });
  g.destroy();
  return t;
}

/** A pixel-art planet: 3-px cells, lit from the upper left, with a dithered terminator. */
function planet(g: Graphics, cx: number, cy: number, radius: number, [light, mid, shade]: [number, number, number], ringed: boolean): void {
  const cell = 3;
  const n = Math.ceil(radius / cell);
  for (let y = -n; y <= n; y++) {
    for (let x = -n; x <= n; x++) {
      const d = Math.hypot(x, y) / n;
      if (d > 1) continue;
      const z = Math.sqrt(1 - d * d);
      const lit = (-x / n) * 0.6 + (-y / n) * 0.5 + z * 0.62; // dot with a light from the upper left
      const dither = (x + y) & 1 ? 0.08 : -0.08;
      const level = lit + dither;
      g.rect(cx + x * cell, cy + y * cell, cell, cell).fill(level > 0.55 ? light : level > 0.05 ? mid : shade);
    }
  }
  if (ringed) {
    for (let x = -n * 1.8; x <= n * 1.8; x++) {
      const y = Math.round(x * 0.22);
      if (Math.hypot(x, y) < n * 0.95 && y < 0) continue; // behind the planet
      g.rect(cx + Math.round(x) * cell, cy + y * cell, cell, cell).fill({ color: mid, alpha: 0.8 });
    }
  }
}

export class Backdrop {
  readonly root = new Container();
  private layers: Layer[] = [];

  private readonly renderer: Renderer;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  /** (Re)build every layer for a theme. */
  build(style: StyleId, width: number, height: number): void {
    for (const l of this.layers) { l.sprite.destroy({ texture: true }); }
    this.layers = [];
    const sky = SKY[style] ?? SKY["flightdeck-nightshift"];
    const space = STYLES[style].space;
    const far = texture(this.renderer, 1024, (g) => {
      g.rect(0, 0, 1024, 1024).fill(space);
      sky.nebula.forEach((color, i) => {
        for (let c = 0; c < 2; c++) {
          const x = hash(`nx${i}${c}`) * 1024, y = hash(`ny${i}${c}`) * 1024;
          for (let j = 0; j < 40; j++) {
            g.circle(x + (hash(`n${i}${c}${j}x`) - 0.5) * 360, y + (hash(`n${i}${c}${j}y`) - 0.5) * 240, 20 + hash(`n${i}${c}${j}r`) * 60).fill({ color, alpha: sky.nebulaAlpha });
          }
        }
      });
      for (let i = 0; i < 420; i++) {
        const m = hash(`fs${i}`);
        g.rect(Math.round(hash(`fx${i}`) * 1024), Math.round(hash(`fy${i}`) * 1024), 1, 1).fill({ color: 0xffffff, alpha: 0.15 + m * 0.35 });
      }
    });
    const planets = sky.planets.length ? texture(this.renderer, 2048, (g) => {
      planet(g, 520, 380, 30, sky.planets[0], false);
      planet(g, 1560, 1420, 18, sky.planets[1], true);
    }) : undefined;
    const near = texture(this.renderer, 1024, (g) => {
      for (let i = 0; i < 160; i++) {
        const m = hash(`ns${i}`);
        const color = m > 0.92 ? 0xffd9a0 : m > 0.84 ? 0xa0d8ff : 0xffffff;
        g.rect(Math.round(hash(`nx${i}`) * 1024), Math.round(hash(`ny${i}`) * 1024), m > 0.96 ? 2 : 1, m > 0.96 ? 2 : 1).fill({ color, alpha: 0.45 + m * 0.5 });
      }
    });
    // Two sets of bright stars that twinkle out of phase, so the sky never pulses as one.
    const twinkle = (seed: string) => texture(this.renderer, 1024, (g) => {
      for (let i = 0; i < 8; i++) {
        const x = Math.round(hash(`${seed}x${i}`) * 1024), y = Math.round(hash(`${seed}y${i}`) * 1024);
        g.rect(x, y, 2, 2).fill(0xffffff);
        g.rect(x - 2, y, 6, 2).fill({ color: 0xffffff, alpha: 0.35 });
        g.rect(x, y - 2, 2, 6).fill({ color: 0xffffff, alpha: 0.35 });
      }
    });
    const add = (t: Texture | undefined, parallax: number, tw?: number) => {
      if (!t) return;
      const sprite = new TilingSprite({ texture: t, width, height });
      this.root.addChild(sprite);
      this.layers.push({ sprite, parallax, twinkle: tw });
    };
    add(far, 0.06);
    add(planets, 0.1);
    // Distant: planets sit back in the haze rather than competing with the stations.
    if (this.layers.at(-1)?.sprite.texture === planets) this.layers.at(-1)!.sprite.alpha = 0.55;
    add(near, 0.2);
    if (sky.planets.length) {
      add(twinkle("ta"), 0.2, 0);
      add(twinkle("tb"), 0.2, Math.PI / 2);
    }
  }

  /** Follow the camera at each layer's depth; twinkle with the animation clock. */
  update(width: number, height: number, camX: number, camY: number, t: number): void {
    for (const l of this.layers) {
      l.sprite.width = width;
      l.sprite.height = height;
      l.sprite.tilePosition.set(camX * l.parallax, camY * l.parallax);
      if (l.twinkle !== undefined) l.sprite.alpha = 0.3 + 0.7 * Math.abs(Math.sin(t * 0.8 + l.twinkle));
    }
  }

  destroy(): void {
    for (const l of this.layers) l.sprite.destroy({ texture: true });
    this.root.destroy();
  }
}
