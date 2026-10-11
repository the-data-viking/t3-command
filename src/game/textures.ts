// Pixi textures from the pixel-art sprite kit, for the active art style. Always nearest-neighbor,
// so sprites stay crisp at the map's integer scale. Memoized: the map asks for textures every
// frame (animation, screen states), and each lookup must be cheap.

import { Texture } from "pixi.js";
import { STYLES, type Style } from "../art/palettes";
import { rasterize, type Arms, type Fill, type Legs, type Silhouette, type Tier } from "../art/render";
import type { Grid } from "../art/sprites";
import * as S from "../art/sprites";
import { FLIGHT_KIT, flightCrew } from "../art/flightdeck";
import { useGame } from "../store";

/** World pixels per sprite pixel. One 16 px sprite tile = one 32 px map tile. */
export const PX = 2;

export function currentStyle(): Style {
  return STYLES[useGame.getState().artStyle];
}

const fixtures = new Map<Grid, Grid>([
  [S.CONSOLE, FLIGHT_KIT.CONSOLE], [S.TERMINAL, FLIGHT_KIT.TERMINAL],
  [S.FILES, FLIGHT_KIT.FILES], [S.COMMS, FLIGHT_KIT.COMMS], [S.CHAIR, FLIGHT_KIT.CHAIR],
]);

const byGrid = new WeakMap<Grid, Map<string, Texture>>();

export function tex(grid: Grid, fill: Fill = {}): Texture {
  grid = fixtures.get(grid) ?? grid;
  const style = currentStyle();
  const key = `${style.id}|${fill.team ?? ""}|${fill.visor ?? ""}|${fill.screen ?? ""}`;
  let forGrid = byGrid.get(grid);
  if (!forGrid) byGrid.set(grid, (forGrid = new Map()));
  let t = forGrid.get(key);
  if (!t) {
    t = Texture.from(rasterize(grid, style, fill));
    t.source.scaleMode = "nearest";
    forGrid.set(key, t);
  }
  return t;
}

const crewCache = new Map<string, Texture>();

export function crewTex(silhouette: Silhouette, tier: Tier, legs: Legs, arms: Arms, team: number, visor: number): Texture {
  const style = currentStyle();
  const key = `${style.id}|${silhouette}|${tier}|${legs}|${arms}|${team}|${visor}`;
  let t = crewCache.get(key);
  if (!t) {
    t = Texture.from(rasterize(flightCrew(silhouette, tier, legs, arms), style, { team, visor }));
    t.source.scaleMode = "nearest";
    crewCache.set(key, t);
  }
  return t;
}
