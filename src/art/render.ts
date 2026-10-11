// Turns sprite grids into pixel canvases: composes crew from layers and fills in per-sprite colors.

import type { Style } from "./palettes";
import * as S from "./sprites";
import type { Grid } from "./sprites";

export type Silhouette = "round" | "angular";
export type Tier = "light" | "standard" | "heavy" | "reviewer";
export type Legs = "idle" | "walkA" | "walkB";
export type Arms = "idle" | "typeA" | "typeB";

export interface Fill {
  team?: number;
  visor?: number;
  screen?: number;
}

function mix(a: number, b: number, t: number): number {
  const ch = (shift: number) => Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** Overlay layers; later layers win wherever they aren't transparent. */
export function compose(...layers: Grid[]): string[] {
  const h = Math.max(...layers.map((l) => l.length));
  const w = Math.max(...layers.map((l) => l[0]?.length ?? 0));
  const out: string[][] = Array.from({ length: h }, () => Array(w).fill("."));
  for (const layer of layers) {
    layer.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (row[x] !== ".") out[y][x] = row[x];
    });
  }
  return out.map((r) => r.join(""));
}

export function crewGrid(silhouette: Silhouette, tier: Tier, legs: Legs = "idle", arms: Arms = "idle"): string[] {
  const body = tier === "heavy" ? S.BODY_HEAVY : tier === "light" ? S.BODY_LIGHT : S.BODY_STANDARD;
  const pack = tier === "heavy" ? S.PACK_HEAVY : tier === "light" ? S.PACK_LIGHT : S.PACK_STANDARD;
  const legsGrid = legs === "walkA" ? S.LEGS_WALK_A : legs === "walkB" ? S.LEGS_WALK_B : S.LEGS_IDLE;
  const armsGrid = arms === "typeA" ? S.ARMS_TYPE_A : arms === "typeB" ? S.ARMS_TYPE_B : S.ARMS_IDLE;
  const helmet = silhouette === "round" ? S.HELMET_ROUND : S.HELMET_ANGULAR;
  const layers: Grid[] = [pack, legsGrid, body, armsGrid, helmet];
  if (tier === "reviewer") layers.push(S.SCANNER);
  return compose(...layers);
}

const cache = new Map<string, HTMLCanvasElement>();

/** Rasterize a grid at 1 px per cell. Cached per (grid, style, fill). */
export function rasterize(grid: Grid, style: Style, fill: Fill = {}, mirror = false): HTMLCanvasElement {
  const key = `${style.id}|${fill.team ?? ""}|${fill.visor ?? ""}|${fill.screen ?? ""}|${mirror ? 1 : 0}|${grid.join("/")}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const colors: Record<string, number> = { ...style.colors };
  const team = fill.team ?? 0x8a96a8;
  const visor = fill.visor ?? 0x9fb3d1;
  const screen = fill.screen ?? 0x1c2228;
  colors.T = team;
  colors.t = mix(team, 0x000000, 0.35);
  colors.V = visor;
  colors.v = mix(visor, 0xffffff, 0.55);
  colors.S = screen;
  colors.x = screen === 0x1c2228 ? 0x232a31 : mix(screen, 0xffffff, 0.45);

  const h = grid.length;
  const w = grid[0].length;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const code = grid[y][mirror ? w - 1 - x : x];
      if (code === ".") continue;
      const c = colors[code];
      if (c === undefined) continue;
      const i = (y * w + x) * 4;
      img.data[i] = (c >> 16) & 255;
      img.data[i + 1] = (c >> 8) & 255;
      img.data[i + 2] = c & 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  cache.set(key, canvas);
  return canvas;
}
