// The space behind the fleet: parallax layers of dim and near stars, a few bright ones that
// twinkle, one planet's horizon along the bottom of the frame, and each world's light: a moon, a
// sun or a ringed giant hanging in the sky with a dithered glow around it. Nothing here keeps the
// render loop running; panning shows the depth.

import { Container, Graphics, Rectangle, Sprite, Texture, TilingSprite, type Renderer } from "pixi.js";
import type { StyleId } from "../art/palettes";
import { STYLES } from "../art/palettes";
import { hash } from "./map-common";

/** A body in the sky: where its light comes from. Positions are fractions of the frame. */
interface SkyBody {
  kind: "moon" | "sun" | "ringed";
  x: number;
  y: number;
  /** Disc radius in screen pixels. */
  r: number;
  /** Lit colour, and the shade on its dark side. */
  color: number;
  shade: number;
  /** The glow around it: colour and strength (0–1). */
  glow: number;
  glowStrength: number;
  /** The ringed giant's ring colour. */
  ring?: number;
}

/** Each world's sky: its horizon planet (light, mid, shade), its light, and its stars. High Contrast keeps a bare sky. */
interface Sky {
  planet?: [number, number, number];
  body?: SkyBody;
  /** Star colours, faint to bright, and how many of them show (1 = all). */
  stars?: [number, number, number];
  starDensity?: number;
}

const NIGHT_SHIFT: Sky = {
  // A cold blue world under a thin crescent moon: the graveyard shift.
  planet: [0x6f8fa8, 0x3d566b, 0x1c2733],
  body: { kind: "moon", x: 0.88, y: 0.17, r: 24, color: 0xdfe8f0, shade: 0x2a3440, glow: 0x6f8fa8, glowStrength: 0.18 },
};

const SKY: Record<StyleId, Sky> = {
  "flightdeck-nightshift": NIGHT_SHIFT,
  nightshift: NIGHT_SHIFT,
  // Day shift: the same world in sunlight, the sun's glare washing out all but the brightest stars.
  signal: {
    planet: [0x7fc4d6, 0x3f7f92, 0x163440],
    body: { kind: "sun", x: 0.86, y: 0.16, r: 30, color: 0xfff6dc, shade: 0xffd98a, glow: 0xffe6a8, glowStrength: 0.42 },
    starDensity: 0.35,
  },
  // Kestrel: an amber desert world, a bronze ringed giant overhead, warm dust in the starlight.
  flightdeck: {
    planet: [0xd0a070, 0x8a6040, 0x3a2818],
    body: { kind: "ringed", x: 0.8, y: 0.22, r: 46, color: 0xe0b078, shade: 0x5a3a20, glow: 0xc28e52, glowStrength: 0.16, ring: 0xf1d6a8 },
    stars: [0xfff1dc, 0xffd9a0, 0xffc890],
  },
  // Pastel: candy dusk, a big cream crescent moon and pink and mint stars.
  pastel: {
    planet: [0xffc6d9, 0xc58aa8, 0x5a3a5a],
    body: { kind: "moon", x: 0.8, y: 0.2, r: 44, color: 0xfff1d6, shade: 0x5a4470, glow: 0xffc6d9, glowStrength: 0.3 },
    stars: [0xffffff, 0xffc6d9, 0xa8f0d0],
  },
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

/** Pixel cell for the sky body and its glow. */
const BODY_CELL = 3;
/** A 4×4 ordered-dither matrix: cells light in a fixed, even pattern as density rises. */
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

/**
 * A body in the sky as pixel art, centred in its texture: a dithered glow fading out in bands,
 * then the disc lit from the frame's centre (where the fleet is). A moon shows a crescent, the sun
 * a bright disc with a pale rim, the ringed giant bands and a tilted ring passing behind and in
 * front of it. Drawn once per theme.
 */
function bodyTexture(body: SkyBody, space: number): Texture {
  const glowR = body.r * (body.kind === "sun" ? 5 : 3.5);
  const size = Math.ceil((glowR * 2) / BODY_CELL) * BODY_CELL;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
  const c = size / 2;
  // Lit from the upper left, as everything on the map is (the art bible's one light).
  const lx = -1, ly = -0.6;
  const ringTilt = -0.32, ringA = body.r * 2.1, ringB = body.r * 0.42;
  const inRing = (dx: number, dy: number): "front" | "back" | undefined => {
    if (body.kind !== "ringed") return undefined;
    const rx = dx * Math.cos(ringTilt) + dy * Math.sin(ringTilt);
    const ry = -dx * Math.sin(ringTilt) + dy * Math.cos(ringTilt);
    const e = Math.hypot(rx / ringA, ry / ringB);
    if (e < 0.72 || e > 1 || (e > 0.84 && e < 0.88)) return undefined; // Two bands with a gap.
    return ry > 0 ? "front" : "back";
  };
  for (let y = 0; y < size; y += BODY_CELL) {
    for (let x = 0; x < size; x += BODY_CELL) {
      const dx = x + BODY_CELL / 2 - c, dy = y + BODY_CELL / 2 - c;
      const d = Math.hypot(dx, dy);
      const cell = Math.floor(x / BODY_CELL) + Math.floor(y / BODY_CELL);
      const ring = inRing(dx, dy);
      if (d <= body.r) {
        if (ring === "front") { ctx.fillStyle = hex(mix(body.ring!, space, 0.25)); ctx.fillRect(x, y, BODY_CELL, BODY_CELL); continue; }
        const nx = dx / body.r, ny = dy / body.r;
        let lit = nx * lx + ny * ly;
        if (body.kind === "moon") {
          // A crescent: the disc's lit side only, its edge dithered.
          lit = lit * 1.4 - 0.25;
        } else if (body.kind === "sun") {
          lit = 1 - d / body.r < 0.12 ? 0.2 : 1;
        }
        const band = body.kind === "ringed" && Math.floor((ny + 1) * 5) % 2 === 0 ? 0.1 : 0;
        const level = lit + band + (cell & 1 ? 0.06 : -0.06);
        const color = level > 0.35 ? body.color : level > -0.05 ? mix(body.color, body.shade, 0.55) : body.shade;
        ctx.fillStyle = hex(mix(color, space, body.kind === "sun" ? 0 : 0.2));
        ctx.fillRect(x, y, BODY_CELL, BODY_CELL);
        continue;
      }
      if (ring) { ctx.fillStyle = hex(mix(body.ring!, space, ring === "back" ? 0.45 : 0.25)); ctx.fillRect(x, y, BODY_CELL, BODY_CELL); continue; }
      // The glow: ordered dithering (no diagonal hatching), denser and brighter toward the body.
      const t = (d - body.r) / (glowR - body.r);
      if (t >= 1) continue;
      const density = body.glowStrength * 2.2 * (1 - t) ** 2.4;
      const col = Math.floor(x / BODY_CELL), row = Math.floor(y / BODY_CELL);
      if (BAYER[row % 4][col % 4] / 16 >= density) continue;
      ctx.fillStyle = hex(mix(body.glow, space, t < 0.2 ? 0.4 : t < 0.45 ? 0.6 : 0.82));
      ctx.fillRect(x, y, BODY_CELL, BODY_CELL);
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
  private body?: { sprite: Sprite; x: number; y: number };

  private readonly renderer: Renderer;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  /** (Re)build every layer for a theme. */
  build(style: StyleId, width: number, height: number): void {
    for (const l of this.layers) { l.sprite.destroy({ texture: true, textureSource: true }); }
    this.layers = [];
    const sky = SKY[style] ?? SKY["flightdeck-nightshift"];
    const space = STYLES[style].space;
    const [faint, warm, cool] = sky.stars ?? [0xffffff, 0xffd9a0, 0xa0d8ff];
    const density = sky.starDensity ?? 1;
    const far = texture(this.renderer, 1024, (g) => {
      g.rect(0, 0, 1024, 1024).fill(space);
      for (let i = 0; i < Math.round(420 * density); i++) {
        const m = hash(`fs${i}`);
        g.rect(Math.round(hash(`fx${i}`) * 1024), Math.round(hash(`fy${i}`) * 1024), 1, 1).fill({ color: faint, alpha: 0.15 + m * 0.35 });
      }
    });
    const near = texture(this.renderer, 1024, (g) => {
      for (let i = 0; i < Math.round(160 * density); i++) {
        const m = hash(`ns${i}`);
        const color = m > 0.92 ? warm : m > 0.84 ? cool : faint;
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
    // The world's light, behind the horizon: it sets low behind the planet only at the frame's edge.
    this.body?.sprite.destroy({ texture: true, textureSource: true });
    this.body = undefined;
    if (sky.body) {
      const sprite = new Sprite(bodyTexture(sky.body, space));
      sprite.anchor.set(0.5);
      this.root.addChild(sprite);
      this.body = { sprite, x: sky.body.x, y: sky.body.y };
    }
    this.horizon?.destroy({ texture: true, textureSource: true });
    this.horizon = undefined;
    if (sky.planet) {
      this.horizon = new Sprite(horizonTexture(sky.planet, space));
      this.horizon.anchor.set(0.5, 0);
      this.root.addChild(this.horizon);
    }
  }

  /** Follow the camera at each layer's depth; twinkle with the animation clock. */
  update(width: number, height: number, camX: number, camY: number, t: number): void {
    if (this.body) {
      // Far away: it barely moves as you pan.
      this.body.sprite.position.set(Math.round(width * this.body.x + camX * 0.015), Math.round(height * this.body.y + camY * 0.015));
    }
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
    for (const l of this.layers) l.sprite.destroy({ texture: true, textureSource: true });
    this.horizon?.destroy({ texture: true, textureSource: true });
    this.body?.sprite.destroy({ texture: true, textureSource: true });
    this.root.destroy();
  }
}
