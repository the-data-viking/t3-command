// Theme previews for the picker: a tiny scene rendered from the real sprites in each palette.

import { FLIGHT_KIT, flightCrew } from "../art/flightdeck";
import { STYLES, type StyleId } from "../art/palettes";
import { rasterize } from "../art/render";

const thumbs = new Map<string, string>();

/** A small scene in a theme's palette: a slice of hull, a lit console and a crew member on deck. */
export function themeThumbnail(id: StyleId): string {
  const hit = thumbs.get(id);
  if (hit) return hit;
  const style = STYLES[id];
  const W = 52, H = 30;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
  const col = style.colors;
  ctx.fillStyle = hex(style.space); ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = hex(col.k); ctx.fillRect(1, 1, W - 2, H - 2);
  ctx.fillStyle = hex(col.H); ctx.fillRect(2, 2, W - 4, 3);
  ctx.fillStyle = hex(col.h); ctx.fillRect(2, 2, W - 4, 1);
  ctx.fillStyle = hex(col.p); ctx.fillRect(2, 6, W - 4, H - 8);
  ctx.fillStyle = hex(col.P);
  for (let x = 2; x < W - 2; x += 8) ctx.fillRect(x, 6, 1, H - 8);
  ctx.drawImage(rasterize(FLIGHT_KIT.CONSOLE, style, { screen: 0x59e1ff }), 4, 8);
  ctx.drawImage(rasterize(flightCrew("round", "standard"), style, { team: 0xf0a33a, visor: 0xe2884f }), 33, 6);
  const url = canvas.toDataURL();
  thumbs.set(id, url);
  return url;
}
