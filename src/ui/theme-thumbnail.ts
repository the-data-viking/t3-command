// Theme previews for the picker: a tiny scene rendered from the real sprites in each palette,
// beside a corner of the theme's own HUD chrome (the biggest visible difference between themes).

import { FLIGHT_KIT, flightCrew } from "../art/flightdeck";
import { STYLES, type StyleId } from "../art/palettes";
import { rasterize } from "../art/render";
import { hudMaterials, hudTokens, PROVIDER_VISOR, STATUS, TEAM_COLORS } from "../game/theme";

const thumbs = new Map<string, string>();

/**
 * A small scene in a theme's palette (a slice of hull, a lit console and a crew member on deck)
 * with one of its HUD panels docked at the right: frame colour, weight and corner shape, title
 * tab, a line of text and a status pill.
 */
export function themeThumbnail(id: StyleId): string {
  const hit = thumbs.get(id);
  if (hit) return hit;
  const style = STYLES[id];
  const W = 52, H = 30;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
  const rect = (color: number, x: number, y: number, w: number, h: number) => { ctx.fillStyle = hex(color); ctx.fillRect(x, y, w, h); };
  const col = style.colors;
  rect(style.space, 0, 0, W, H);
  // The map: hull, deck and crew, on the left.
  rect(col.k, 1, 1, 33, H - 2);
  rect(col.H, 2, 2, 31, 3);
  rect(col.h, 2, 2, 31, 1);
  rect(col.p, 2, 6, 31, H - 8);
  for (let x = 2; x < 33; x += 8) rect(col.P, x, 6, 1, H - 8);
  ctx.drawImage(rasterize(FLIGHT_KIT.CONSOLE, style, { screen: STATUS.working }), 2, 8);
  ctx.drawImage(rasterize(flightCrew("round", "standard"), style, { team: TEAM_COLORS[0], visor: PROVIDER_VISOR.claudeAgent }), 18, 6);
  // The HUD: a panel corner in the theme's chrome.
  const m = hudMaterials(id);
  const chrome = m.chrome ?? { corner: "round", radius: 7, width: 3 };
  const x0 = 35, y0 = 3, pw = W - x0, ph = H - y0;
  const edge = chrome.width >= 3 ? 2 : 1;
  rect(m.frame, x0, y0, pw, ph);
  rect(m.surface, x0 + edge, y0 + edge, pw - edge, ph - edge);
  // Corner: cut on a bevel, a stepped curve when rounded, nothing when square.
  const cut = chrome.corner === "bevel" ? [3, 2, 1] : chrome.corner === "round" ? (chrome.radius >= 12 ? [2, 1] : [1]) : [];
  cut.forEach((n, row) => rect(style.space, x0, y0 + row, n, 1));
  // Title tab, a line of text and a status pill.
  const tokens = hudTokens(id);
  const token = (name: string) => parseInt(tokens[name].slice(1), 16);
  rect(m.frame, x0 + 4, y0 - 2, 9, 3);
  rect(m.ink, x0 + 5, y0 - 1, 7, 1);
  rect(token("--text"), x0 + 4, y0 + 6, 11, 1);
  rect(token("--muted"), x0 + 4, y0 + 9, 8, 1);
  rect(token("--alert"), x0 + 4, y0 + 13, 9, 3);
  rect(m.slot, x0 + 4, y0 + 19, pw - 6, 6);
  rect(m.edge, x0 + 4, y0 + 19, pw - 6, 1);
  const url = canvas.toDataURL();
  thumbs.set(id, url);
  return url;
}
