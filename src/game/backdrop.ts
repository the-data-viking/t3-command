// The space behind the fleet: parallax layers of dim and near stars, a few bright ones that
// twinkle, and one planet's horizon along the bottom of the frame. Nothing here keeps the render
// loop running; panning shows the depth.

import { Container, Graphics, Rectangle, Sprite, Texture, TilingSprite, type Renderer } from "pixi.js";
import type { StyleId } from "../art/palettes";
import { STYLES } from "../art/palettes";
import { hash } from "./map-common";

/** The horizon planet's colours (light, mid, shade) per theme; High Contrast keeps a bare sky. */
const SKY: Record<StyleId, { planet?: [number, number, number] }> = {
  "flightdeck-nightshift": { planet: [0x6f8fa8, 0x3d566b, 0x1c2733] },
  nightshift: { planet: [0x6f8fa8, 0x3d566b, 0x1c2733] },
  flightdeck: { planet: [0xd0a070, 0x8a6040, 0x3a2818] },
  signal: { planet: [0x7fc4d6, 0x3f7f92, 0x163440] },
  pastel: { planet: [0xffc6d9, 0xc58aa8, 0x5a3a5a] },
  highcontrast: {},
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

/** Mix a colour toward another by k (0–1). */
function mix(a: number, b: number, k: number): number {
  const ch = (c: number, s: number) => (c >> s) & 255;
  const m = (s: number) => Math.round(ch(a, s) * (1 - k) + ch(b, s) * k);
  return (m(16) << 16) | (m(8) << 8) | m(0);
}

/** The visible cap of the horizon planet: width and height of its texture, and the planet's radius. */
const HORIZON_W = 2600, HORIZON_H = 560, HORIZON_R = 1700, HORIZON_CELL = 3;

/**
 * A planet's horizon as pixel art: the top cap of a huge disc in 3-px cells, lit from the upper
 * left with a dithered terminator and three dithered bands of atmosphere along its rim. Colours
 * are hazed toward space so it sits behind the fleet. Drawn on a 2D canvas (tens of thousands of
 * cells), once per theme.
 */
function horizonTexture(colors: [number, number, number], space: number): Texture {
  const [light, mid, shade] = colors.map((c) => mix(c, space, 0.5));
  const rim = mix(colors[0], 0xffffff, 0.25);
  const canvas = document.createElement("canvas");
  canvas.width = HORIZON_W;
  canvas.height = HORIZON_H;
  const ctx = canvas.getContext("2d")!;
  const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
  const cx = HORIZON_W / 2, cy = HORIZON_R;
  for (let y = 0; y < HORIZON_H; y += HORIZON_CELL) {
    for (let x = 0; x < HORIZON_W; x += HORIZON_CELL) {
      const dx = x - cx, dy = y - cy;
      const d = Math.hypot(dx, dy);
      const inside = HORIZON_R - d;
      const cell = Math.floor(x / HORIZON_CELL) + Math.floor(y / HORIZON_CELL);
      if (inside < 0) {
        // Atmosphere: three bands outside the rim, each sparser than the last.
        const band = Math.floor(-inside / (HORIZON_CELL * 2));
        if (band < 3 && cell % (band + 2) === 0) { ctx.fillStyle = hex(mix(rim, space, 0.55 + band * 0.15)); ctx.fillRect(x, y, HORIZON_CELL, HORIZON_CELL); }
        continue;
      }
      const lit = (-dx / HORIZON_R) * 0.9 + (-dy / HORIZON_R) * 0.4 + (inside < HORIZON_CELL * 3 ? 0.25 : 0);
      const level = lit + (cell & 1 ? 0.04 : -0.04);
      ctx.fillStyle = hex(level > 0.12 ? light : level > -0.18 ? mid : shade);
      ctx.fillRect(x, y, HORIZON_CELL, HORIZON_CELL);
    }
  }
  const t = Texture.from(canvas);
  t.source.scaleMode = "nearest";
  return t;
}

export class Backdrop {
  readonly root = new Container();
  private layers: Layer[] = [];
  private horizon?: Sprite;

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
      for (let i = 0; i < 420; i++) {
        const m = hash(`fs${i}`);
        g.rect(Math.round(hash(`fx${i}`) * 1024), Math.round(hash(`fy${i}`) * 1024), 1, 1).fill({ color: 0xffffff, alpha: 0.15 + m * 0.35 });
      }
    });
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
    add(near, 0.2);
    if (sky.planet) {
      add(twinkle("ta"), 0.2, 0);
      add(twinkle("tb"), 0.2, Math.PI / 2);
    }
    // One hero body: a planet's horizon along the bottom of the frame, over the stars (none shows
    // through it), hazed toward space so it sits behind the fleet rather than competing with it.
    this.horizon?.destroy({ texture: true });
    this.horizon = undefined;
    if (sky.planet) {
      this.horizon = new Sprite(horizonTexture(sky.planet, space));
      this.horizon.anchor.set(0.5, 0);
      this.root.addChild(this.horizon);
    }
  }

  /** Follow the camera at each layer's depth; twinkle with the animation clock. */
  update(width: number, height: number, camX: number, camY: number, t: number): void {
    if (this.horizon) {
      // The horizon fills about the bottom fifth of the frame and drifts only slightly as you pan.
      this.horizon.position.set(Math.round(width / 2 + camX * 0.03), Math.round(height * 0.8 + Math.max(-60, Math.min(60, camY * 0.03))));
    }
    for (const l of this.layers) {
      l.sprite.width = width;
      l.sprite.height = height;
      // Whole pixels, so stars and planets don't shimmer between pixels while the camera pans.
      l.sprite.tilePosition.set(Math.round(camX * l.parallax), Math.round(camY * l.parallax));
      if (l.twinkle !== undefined) l.sprite.alpha = 0.3 + 0.7 * Math.abs(Math.sin(t * 0.8 + l.twinkle));
    }
  }

  destroy(): void {
    for (const l of this.layers) l.sprite.destroy({ texture: true });
    this.horizon?.destroy({ texture: true });
    this.root.destroy();
  }
}
