// Theme previews for the picker: a tiny scene of the world itself (its sky, its light, its
// horizon and its hull silhouette with lit windows) beside a corner of its own HUD chrome.

import { STYLES, type StyleId } from "../art/palettes";
import { skyPreview } from "../game/backdrop";
import { hudMaterials, hudTokens } from "../game/theme";

const thumbs = new Map<string, string>();

/** Mix a colour toward another by k (0–1). */
function mix(a: number, b: number, k: number): number {
  const ch = (c: number, s: number) => (c >> s) & 255;
  const m = (s: number) => Math.round(ch(a, s) * (1 - k) + ch(b, s) * k);
  return (m(16) << 16) | (m(8) << 8) | m(0);
}

/**
 * A small scene in a world's own look (its graded sky, its moon, sun or ringed giant, its
 * planet's horizon, and a station in its hull silhouette with a row of lit windows), with one of
 * its HUD panels docked at the right: frame colour, weight and corner shape, title tab, a line of
 * text and a status pill.
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
  const sky = skyPreview(id);
  const lamp = style.light ?? 0xe8f0f8;
  // The sky: space at the top, graded toward the horizon in four bands.
  for (let band = 0; band < 4; band++) rect(sky.grade ? mix(style.space, sky.grade.toward, (sky.grade.strength * band) / 4) : style.space, 0, band * 7, 35, band === 3 ? H - 21 : 7);
  // The world's light, upper right of the scene.
  if (sky.body) {
    const bx = 27, by = 5;
    if (sky.body.kind === "ringed") rect(sky.body.ring ?? sky.body.color, bx - 4, by + 1, 9, 1);
    rect(sky.body.color, bx - 1, by - 2, 3, 5); rect(sky.body.color, bx - 2, by - 1, 5, 3);
    if (sky.body.kind === "moon") { rect(sky.body.shade, bx + 1, by - 1, 2, 3); rect(sky.body.shade, bx + 1, by - 2, 1, 1); }
  }
  // The planet's horizon along the bottom.
  if (sky.planet) { rect(sky.planet[1], 0, H - 3, 35, 3); rect(sky.planet[0], 0, H - 3, 35, 1); }
  // A station in the world's silhouette: outline, plating, a deck, a row of lit windows.
  const hull = style.hull ?? "industrial";
  const hx = 3, hy = 12, hw = 20, hh = 11;
  rect(col.k, hx, hy, hw, hh);
  rect(col.H, hx + 1, hy + 1, hw - 2, hh - 2);
  rect(col.p, hx + 2, hy + 4, hw - 4, hh - 6);
  for (let x = hx + 3; x < hx + hw - 3; x += 3) rect(x < hx + 12 ? lamp : col.k, x, hy + 2, 2, 1);
  const corners = hull === "industrial" ? [[0, 0], [hw - 1, 0], [0, hh - 1], [hw - 1, hh - 1]] : [];
  for (const [cx, cy] of corners) rect(sky.grade ? mix(style.space, sky.grade.toward, sky.grade.strength * 0.5) : style.space, hx + cx, hy + cy, 1, 1);
  if (hull === "ftl") {
    // Kestrel's ship: a nacelle on a strut, its exhaust in the lamp colour.
    rect(col.k, hx + hw, hy + 3, 7, 4); rect(col.H, hx + hw + 1, hy + 4, 5, 2); rect(lamp, hx + hw + 7, hy + 4, 1, 2);
    rect(col.k, hx + 6, hy - 2, 8, 2); rect(col.H, hx + 7, hy - 1, 6, 1);
  } else if (hull === "soft") {
    // Pastel's soft hull: rounded corners and the glass dome.
    for (const [cx, cy] of [[0, 0], [hw - 1, 0], [0, hh - 1], [hw - 1, hh - 1], [1, 0], [0, 1], [hw - 2, 0], [hw - 1, 1]]) rect(mix(style.space, sky.grade?.toward ?? style.space, (sky.grade?.strength ?? 0) * 0.5), hx + cx, hy + cy, 1, 1);
    rect(col.k, hx + 12, hy - 3, 5, 3); rect(col.b, hx + 13, hy - 2, 3, 2); rect(lamp, hx + 13, hy - 2, 1, 1);
  } else {
    // The industrial roof: a mast with its white beacon.
    rect(col.k, hx + hw - 4, hy - 4, 1, 4); rect(col.w, hx + hw - 5, hy - 5, 3, 1);
  }
  // The HUD: a panel corner in the theme's chrome.
  const m = hudMaterials(id);
  const chrome = m.chrome ?? { corner: "round", radius: 7, width: 3 };
  const x0 = 35, y0 = 3, pw = W - x0, ph = H - y0;
  rect(style.space, x0, 0, pw, H);
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
