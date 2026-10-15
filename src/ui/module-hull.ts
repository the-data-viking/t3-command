// A widget card's hull, drawn like a station module on the map (see StationSprite.build) with the
// same plate helpers: outline and plating with the world's corners, light and shade bands, ribs,
// viewports along the top band, the port plate in the station's team colour, and the room's walls.
// Drawn on a canvas at one CSS px per world px, so its art pixels match the map at 100% zoom.

import type { Graphics } from "pixi.js";
import { STYLES, type StyleId } from "../art/palettes";
import { skyLight } from "../game/backdrop";
import { pixelFrame, roundedPlate, steppedPlate } from "../game/map-common";
import { PX } from "../game/textures";

/** Hull plating around the room (its 4-px walls included), in CSS px. */
export const HULL_PAD = { top: 26, side: 20, bottom: 22 } as const;
const WALL = 4;

type Fill = number | { color: number; alpha?: number };

/** Just enough of Pixi's Graphics for the plate helpers: rect(...).fill(...), onto a 2D canvas. */
function canvasGraphics(ctx: CanvasRenderingContext2D): Graphics {
  const g = {
    rect(x: number, y: number, w: number, h: number) {
      return {
        fill(f: Fill) {
          const { color, alpha = 1 } = typeof f === "number" ? { color: f } : f;
          ctx.globalAlpha = alpha;
          ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
          ctx.fillRect(x, y, w, h);
          ctx.globalAlpha = 1;
          return g;
        },
      };
    },
  };
  return g as unknown as Graphics;
}

/**
 * Draw the hull for a w×h card. `lit`: the widget is live, so its viewports glow with the world's
 * lamp colour, as a station's do while its rooms are lit.
 */
export function drawModuleHull(ctx: CanvasRenderingContext2D, w: number, h: number, styleId: StyleId, team: number, lit: boolean): void {
  const style = STYLES[styleId];
  const c = style.colors;
  const g = canvasGraphics(ctx);
  const silhouette = style.hull ?? "industrial";
  const cut = silhouette === "industrial" ? 16 : 24;
  ctx.clearRect(0, 0, w, h);
  // One-art-pixel outline, then the plate.
  if (silhouette === "soft") {
    roundedPlate(g, 0, 0, w, h, cut + PX, c.k);
    roundedPlate(g, PX, PX, w - 2 * PX, h - 2 * PX, cut, c.H);
  } else {
    steppedPlate(g, 0, 0, w, h, cut + PX, 4, c.k);
    steppedPlate(g, PX, PX, w - 2 * PX, h - 2 * PX, cut, 4, c.H);
  }
  g.rect(PX + cut, PX + 2, w - 2 * PX - 2 * cut, 4).fill(c.h);
  g.rect(PX + cut, h - PX - 6, w - 2 * PX - 2 * cut, 4).fill(c.D);
  const rim = skyLight(styleId);
  if (rim !== undefined) {
    g.rect(PX + cut, 0, w - 2 * PX - 2 * cut, PX).fill({ color: rim, alpha: 0.35 });
    g.rect(w - PX, PX + cut, PX, h - 2 * PX - 2 * cut).fill({ color: rim, alpha: 0.35 });
  }
  // The room (inside its walls).
  const rx = HULL_PAD.side, ry = HULL_PAD.top, rw = w - 2 * HULL_PAD.side, rh = h - HULL_PAD.top - HULL_PAD.bottom;
  // Ribs across the bands above and below the room.
  for (let x = rx + 48; x < rx + rw - 8; x += 96) {
    g.rect(x, PX + 8, 2, ry - WALL - PX - 12).fill(c.D);
    g.rect(x, ry + rh + WALL + 4, 2, h - ry - rh - WALL - 12).fill(c.D);
  }
  // Viewports along the top band, dark with a glint, or lit while the widget is live.
  const glass = lit ? style.light ?? c.w : c.b;
  const band = ry - WALL - PX;
  if (silhouette === "ftl") {
    const wy = PX + Math.round((band - 6) / 4) * 2 + 2;
    for (let x = rx + 36; x + 28 < rx + rw - 36; x += 40) {
      g.rect(x, wy - 2, 28, 6).fill(c.k);
      g.rect(x + 2, wy, 24, 2).fill(glass);
    }
  } else if (silhouette === "soft") {
    const wy = PX + Math.round((band - 8) / 4) * 2;
    for (let x = rx + 40; x + 10 < rx + rw - 40; x += 36) {
      roundedPlate(g, x - 2, wy - 2, 12, 12, 4, c.k);
      roundedPlate(g, x, wy, 8, 8, 2, glass);
    }
  } else {
    const wy = PX + Math.round((band - 6) / 4) * 2 + 2;
    for (let x = rx + 40; x + 10 < rx + rw - 40; x += 40) {
      g.rect(x, wy - 2, 10, 6).fill(c.k);
      g.rect(x + 2, wy, 6, 2).fill(glass);
      if (!lit) g.rect(x + 2, wy, 2, 2).fill(c.h);
    }
  }
  // The port plate on the left, where the station's supply lines would come in, in its team colour.
  const plateH = Math.min(40, Math.round((rh - 8) / 4) * 4);
  if (plateH >= 16) {
    const py = Math.round((ry + rh / 2 - plateH / 2) / 2) * 2;
    g.rect(0, py, 12, plateH).fill(c.k);
    g.rect(2, py + 2, 8, plateH - 4).fill(c.D);
    g.rect(4, py + 6, 4, plateH - 12).fill(team);
  }
  // The room's walls; the page sits inside them.
  pixelFrame(g, rx - WALL, ry - WALL, rw + 2 * WALL, rh + 2 * WALL, style.wall, 1, WALL);
}
