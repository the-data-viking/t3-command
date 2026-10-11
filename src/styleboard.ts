// Style board: renders the same scene in every candidate palette so the art direction can be
// picked by eye. Uses the real sprite data and renderer the game will use.

import { STYLES, type Style } from "./art/palettes";
import { crewGrid, rasterize, type Arms, type Legs, type Silhouette, type Tier } from "./art/render";
import * as S from "./art/sprites";

const SCALE = 3;
const T = 16; // tile size in sprite pixels
const COLS = 15;
const W = COLS * T + 40; // scene width in sprite pixels
const H = 262;

const TEAM = { amber: 0xf0a33a, violet: 0x9b7bff, teal: 0x3ec7b3, pink: 0xe45fbf, blue: 0x5b8cff, lime: 0xa8d65a };
const VISOR = { claude: 0xe2884f, codex: 0x46d6c2 };
const SCREEN = { working: 0x59e1ff, alert: 0xff4655, done: 0x5dff9a, monitoring: 0xb48cff };

type Ctx = CanvasRenderingContext2D;

function blit(ctx: Ctx, canvas: HTMLCanvasElement, x: number, y: number): void {
  ctx.drawImage(canvas, Math.round(x), Math.round(y));
}

function rect(ctx: Ctx, color: number, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  ctx.fillRect(x, y, w, h);
}

interface Crew {
  silhouette: Silhouette;
  tier: Tier;
  team: number;
  x: number;
  y: number;
  legs?: Legs;
  arms?: Arms;
  mirror?: boolean;
}

function drawCrew(ctx: Ctx, style: Style, c: Crew): void {
  const grid = crewGrid(c.silhouette, c.tier, c.legs, c.arms);
  const visor = c.silhouette === "round" ? VISOR.claude : VISOR.codex;
  // Feet at (x, y).
  blit(ctx, rasterize(grid, style, { team: c.team, visor }, c.mirror), c.x - S.CREW_W / 2, c.y - S.CREW_H);
}

function drawScene(ctx: Ctx, style: Style, frame: number, t: number): void {
  rect(ctx, style.space, 0, 0, W, H);
  // A few stars.
  for (let i = 0; i < 60; i++) rect(ctx, 0xffffff, (i * 97) % W, (i * 53) % 60, 1, 1);

  // Ship above the station.
  const ship = rasterize(S.SHIP, style, { team: TEAM.amber });
  blit(ctx, ship, 40, 8);
  // Engine glow (the ship's crew are working).
  rect(ctx, 0x59e1ff, 32 - (frame % 2) * 2, 15, 8 + (frame % 2) * 2, 4);
  rect(ctx, 0xffffff, 37, 16, 3, 2);
  // Supply line down to the station.
  for (let y = 24; y < 52; y += 3) rect(ctx, TEAM.amber, 64, y, 1, 2);

  // Station hull.
  const ox = 20;
  const oy = 56;
  const iw = COLS * T;
  const ih = 7 * T;
  rect(ctx, style.colors.k, ox - 8, oy - 8, iw + 16, ih + 16);
  rect(ctx, style.colors.H, ox - 6, oy - 6, iw + 12, ih + 12);
  rect(ctx, style.colors.h, ox - 6, oy - 6, iw + 12, 2);
  rect(ctx, style.colors.D, ox - 6, oy + ih + 4, iw + 12, 2);
  rect(ctx, style.colors.D, 58, oy - 10, 12, 4); // supply port

  // Floor.
  const floor = rasterize(S.FLOOR, style);
  for (let y = 0; y < 7; y++) for (let x = 0; x < COLS; x++) blit(ctx, floor, ox + x * T, oy + y * T);

  // Walls: systems row (3 rooms × 5 tiles), bridge (3 tiles), quarters (11) + archive (4).
  const wall = (x: number, y: number, w: number, h: number) => rect(ctx, style.wall, x, y, w, h);
  wall(ox, oy, iw, 2);
  wall(ox, oy + ih - 2, iw, 2);
  wall(ox, oy, 2, ih);
  wall(ox + iw - 2, oy, 2, ih);
  wall(ox, oy + 2 * T - 1, iw, 2);
  wall(ox + 5 * T - 1, oy, 2, 2 * T);
  wall(ox + 10 * T - 1, oy, 2, 2 * T);
  wall(ox, oy + 5 * T - 1, iw, 2);
  wall(ox + 11 * T - 1, oy + 5 * T, 2, 2 * T);
  const door = rasterize(S.DOOR_H, style);
  for (const dx of [2.5, 7.5, 12.5]) blit(ctx, door, ox + dx * T - 8, oy + 2 * T - 2);
  blit(ctx, door, ox + 5.5 * T - 8, oy + 5 * T - 2);
  blit(ctx, door, ox + 13 * T - 8, oy + 5 * T - 2);

  // Systems.
  blit(ctx, rasterize(S.TERMINAL, style), ox + 2.5 * T - 8, oy + 6);
  blit(ctx, rasterize(S.FILES, style), ox + 7.5 * T - 7, oy + 6);
  blit(ctx, rasterize(S.COMMS, style), ox + 12.5 * T - 8, oy + 8);

  // Bridge consoles and crew.
  const consoles: Array<{ x: number; screen: number; crew?: Crew; badge?: S.Grid }> = [
    { x: 3, screen: frame % 2 ? SCREEN.working : 0x9ff0ff, crew: { silhouette: "round", tier: "standard", team: TEAM.amber, x: 0, y: 0, arms: frame % 2 ? "typeA" : "typeB" } },
    { x: 7.5, screen: frame % 2 ? SCREEN.alert : 0x7a1820, crew: { silhouette: "angular", tier: "heavy", team: TEAM.blue, x: 0, y: 0 }, badge: S.BADGE_ALERT },
    { x: 12, screen: SCREEN.done, crew: { silhouette: "round", tier: "light", team: TEAM.pink, x: 0, y: 0 }, badge: S.BADGE_DONE },
  ];
  for (const c of consoles) {
    const cx = ox + c.x * T;
    const cy = oy + 2 * T + 3;
    blit(ctx, rasterize(S.CONSOLE, style, { screen: c.screen }), cx - 12, cy);
    blit(ctx, rasterize(S.CHAIR, style), cx - 5, cy + 26);
    if (c.crew) drawCrew(ctx, style, { ...c.crew, x: cx, y: cy + 30 });
    // Badge floats beside the helmet, clear of the console.
    if (c.badge) blit(ctx, rasterize(c.badge, style, { visor: SCREEN.monitoring }), cx + 9, cy + 6 - (c.badge === S.BADGE_ALERT ? frame % 2 : 0));
  }
  // Someone walking through quarters toward the door.
  const walkX = ox + 7 * T + ((t * 14) % (3 * T));
  drawCrew(ctx, style, { silhouette: "angular", tier: "standard", team: TEAM.violet, x: walkX, y: oy + 7 * T - 3, legs: frame % 2 ? "walkA" : "walkB" });

  // Inspector monitoring at comms.
  drawCrew(ctx, style, { silhouette: "angular", tier: "reviewer", team: TEAM.teal, x: ox + 13.5 * T, y: oy + 2 * T - 3 });
  blit(ctx, rasterize(S.BADGE_MONITOR, style, { visor: SCREEN.monitoring }), ox + 13.5 * T + 9, oy + 6);

  // Quarters: two settled crew and an empty bunk; archive shelves.
  blit(ctx, rasterize(S.BUNK_SLEEPER, style, { team: TEAM.lime, visor: VISOR.codex }), ox + 1 * T, oy + 6 * T - 4);
  blit(ctx, rasterize(S.BUNK_SLEEPER, style, { team: TEAM.amber, visor: VISOR.claude }), ox + 3 * T, oy + 6 * T - 4);
  blit(ctx, rasterize(S.BUNK_EMPTY, style), ox + 5 * T, oy + 6 * T - 4);
  blit(ctx, rasterize(S.SHELF, style, { team: TEAM.amber }), ox + 11.5 * T, oy + 5 * T + 6);
  blit(ctx, rasterize(S.SHELF, style, { team: TEAM.teal }), ox + 13 * T + 4, oy + 5 * T + 6);

  // Lineup: every crew variant.
  const lineY = oy + ih + 42;
  const variants: Array<[Silhouette, Tier]> = [
    ["round", "light"],
    ["round", "standard"],
    ["round", "heavy"],
    ["round", "reviewer"],
    ["angular", "light"],
    ["angular", "standard"],
    ["angular", "heavy"],
    ["angular", "reviewer"],
  ];
  const teams = Object.values(TEAM);
  variants.forEach(([sil, tier], i) => drawCrew(ctx, style, { silhouette: sil, tier, team: teams[i % teams.length], x: 30 + i * 22, y: lineY }));
  // Badges.
  [S.BADGE_ALERT, S.BADGE_QUESTION, S.BADGE_DONE, S.BADGE_ERROR, S.BADGE_MONITOR].forEach((b, i) =>
    blit(ctx, rasterize(b, style, { visor: SCREEN.monitoring }), 30 + 8 * 22 + 6 + i * 13, lineY - 14),
  );
}

const board = document.getElementById("board")!;
const scenes: Array<{ ctx: Ctx; style: Style }> = [];
for (const style of Object.values(STYLES)) {
  const section = document.createElement("section");
  section.className = "style";
  section.innerHTML = `<div><h2>${style.name.toUpperCase()}</h2><p>${style.blurb}</p><p class="legend">Lineup, left to right: Claude scout · specialist · heavy · inspector, then the same for Codex. Badges: approval · question · report ready · failed · monitoring.</p></div>`;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.style.width = `${W * SCALE}px`;
  canvas.style.height = `${H * SCALE}px`;
  section.appendChild(canvas);
  board.appendChild(section);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  scenes.push({ ctx, style });
}

const start = performance.now();
function loop(now: number): void {
  const t = (now - start) / 1000;
  const frame = Math.floor(t * 4);
  for (const s of scenes) drawScene(s.ctx, s.style, frame, t);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
