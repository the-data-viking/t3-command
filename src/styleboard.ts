// Style board: renders the same scene in every candidate palette so the art direction can be
// picked by eye. Uses the real sprite data and renderer the game will use.

import { STYLES, type Style } from "./art/palettes";
import { rasterize, type Arms, type Legs, type Silhouette, type Tier } from "./art/render";
import * as S from "./art/sprites";
import { PROVIDER_VISOR, STATUS } from "./game/theme";
import { FLIGHT_KIT, flightCrew } from "./art/flightdeck";

let scale = 2;
let paused = false;
let elapsed = 0;
let previousTime = 0;
const T = 16; // tile size in sprite pixels
const COLS = 15;
const W = COLS * T + 40; // scene width in sprite pixels
const H = 262;

const TEAM = { amber: 0xf0a33a, violet: 0x9b7bff, teal: 0x3ec7b3, pink: 0xe45fbf, blue: 0x5b8cff, lime: 0xa8d65a };
const VISOR = { claude: PROVIDER_VISOR.claudeAgent, codex: PROVIDER_VISOR.codex };
const SCREEN = { working: STATUS.working, alert: STATUS.alert, done: STATUS.done, monitoring: STATUS.monitoring };
/** Each status badge is filled with its status colour, as on the map. */
const BADGE_COLOR = new Map<S.Grid, number>([
  [S.BADGE_ALERT, STATUS.alert], [S.BADGE_QUESTION, STATUS.question], [S.BADGE_DONE, STATUS.done],
  [S.BADGE_ERROR, STATUS.error], [S.BADGE_MONITOR, STATUS.monitoring],
]);

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
  const grid = flightCrew(c.silhouette, c.tier, c.legs, c.arms);
  const visor = c.silhouette === "round" ? VISOR.claude : VISOR.codex;
  // Feet at (x, y).
  blit(ctx, rasterize(grid, style, { team: c.team, visor }, c.mirror), c.x - S.CREW_W / 2, c.y - S.CREW_H);
}

function drawScene(ctx: Ctx, style: Style, frame: number, t: number): void {
  const kit = FLIGHT_KIT;
  rect(ctx, style.space, 0, 0, W, H);
  // A few stars.
  for (let i = 0; i < 60; i++) rect(ctx, 0xffffff, (i * 97) % W, (i * 53) % 60, 1, 1);

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

  const bridgeFloor = rasterize(S.FLOOR_BRIDGE, style);
  const quartersFloor = rasterize(S.FLOOR_QUARTERS, style);
  for (let y = 2; y < 5; y++) for (let x = 0; x < COLS; x++) blit(ctx, bridgeFloor, ox + x * T, oy + y * T);
  for (let y = 5; y < 7; y++) for (let x = 0; x < 11; x++) blit(ctx, quartersFloor, ox + x * T, oy + y * T);

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
  const door = rasterize(kit.DOOR_H, style);
  for (const dx of [2.5, 7.5, 12.5]) blit(ctx, door, ox + dx * T - 8, oy + 2 * T - 2);
  blit(ctx, door, ox + 5.5 * T - 8, oy + 5 * T - 2);
  blit(ctx, door, ox + 13 * T - 8, oy + 5 * T - 2);

  // Systems.
  blit(ctx, rasterize(kit.TERMINAL, style), ox + 2.5 * T - kit.TERMINAL[0].length / 2, oy + 6);
  blit(ctx, rasterize(kit.FILES, style), ox + 7.5 * T - kit.FILES[0].length / 2, oy + 6);
  blit(ctx, rasterize(kit.COMMS, style), ox + 12.5 * T - kit.COMMS[0].length / 2, oy + 6);

  // Bridge consoles and crew.
  const consoles: Array<{ x: number; screen: number; crew?: Crew; badge?: S.Grid }> = [
    { x: 3, screen: SCREEN.working, crew: { silhouette: "round", tier: "standard", team: TEAM.amber, x: 0, y: 0, arms: frame % 2 ? "typeA" : "typeB" } },
    { x: 7.5, screen: frame % 2 ? SCREEN.alert : 0x7a1820, crew: { silhouette: "angular", tier: "heavy", team: TEAM.blue, x: 0, y: 0 }, badge: S.BADGE_ALERT },
    { x: 12, screen: SCREEN.done, crew: { silhouette: "round", tier: "light", team: TEAM.pink, x: 0, y: 0 }, badge: S.BADGE_DONE },
  ];
  for (const c of consoles) {
    const cx = ox + c.x * T;
    const cy = oy + 2 * T + 3;
    blit(ctx, rasterize(kit.CONSOLE, style, { screen: c.screen }), cx - kit.CONSOLE[0].length / 2, cy);
    blit(ctx, rasterize(kit.CHAIR, style), cx - 5, cy + 26);
    if (c.crew) drawCrew(ctx, style, { ...c.crew, x: cx, y: cy + (style.id.startsWith("flightdeck") ? 27 : 30) });
    // Badge floats beside the helmet, clear of the console.
    if (c.badge) blit(ctx, rasterize(c.badge, style, { visor: BADGE_COLOR.get(c.badge) }), cx + 9, cy + 6 - (c.badge === S.BADGE_ALERT ? frame % 2 : 0));
  }
  // Someone walking through quarters toward the door.
  const walkX = ox + 7 * T + ((t * 14) % (3 * T));
  drawCrew(ctx, style, { silhouette: "angular", tier: "standard", team: TEAM.violet, x: walkX, y: oy + 7 * T - 3, legs: (["walkA", "walkB", "walkC", "walkB"] as const)[frame % 4] });

  // Inspector monitoring at comms.
  drawCrew(ctx, style, { silhouette: "angular", tier: "reviewer", team: TEAM.teal, x: ox + 13.5 * T, y: oy + 2 * T - 3 });
  blit(ctx, rasterize(S.BADGE_MONITOR, style, { visor: SCREEN.monitoring }), ox + 13.5 * T + 9, oy + 6);

  // Quarters: two settled crew in stasis and an empty cryo pod; archive shelves.
  blit(ctx, rasterize(S.CRYO_SLEEPER, style, { team: TEAM.lime, visor: VISOR.codex }), ox + 1 * T, oy + 6 * T - 4);
  blit(ctx, rasterize(S.CRYO_SLEEPER, style, { team: TEAM.amber, visor: VISOR.claude }), ox + 3 * T, oy + 6 * T - 4);
  blit(ctx, rasterize(S.CRYO_EMPTY, style), ox + 5 * T, oy + 6 * T - 4);
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
    blit(ctx, rasterize(b, style, { visor: BADGE_COLOR.get(b) }), 30 + 8 * 22 + 6 + i * 13, lineY - 14),
  );
}

const board = document.getElementById("board")!;
const scenes: Array<{ ctx: Ctx; style: Style }> = [];
for (const style of Object.values(STYLES).filter((s) => s.id !== "nightshift")) { // Night Shift ships as flightdeck-nightshift.
  const section = document.createElement("section");
  section.className = "style";
  section.dataset.style = style.id;
  section.innerHTML = `<div><h2>${style.name.toUpperCase()}</h2><p>${style.blurb}</p><p class="legend">Lineup, left to right: Claude scout · specialist · heavy · inspector, then the same for Codex. Badges: approval · question · report ready · failed · monitoring.</p></div>`;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.style.width = `${W * scale}px`;
  canvas.style.height = `${H * scale}px`;
  section.appendChild(canvas);
  board.appendChild(section);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  scenes.push({ ctx, style });
  const download = document.createElement("button");
  download.textContent = "Save scene PNG";
  download.addEventListener("click", () => {
    const link = document.createElement("a");
    link.download = `t3-command-${style.id}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  });
  section.firstElementChild!.appendChild(download);
  const gallery = document.createElement("div");
  gallery.className = "assets";
  const kit = FLIGHT_KIT;
  const assets: Array<[string, S.Grid]> = [
    ["Utility deck", S.FLOOR], ["Bridge alloy", S.FLOOR_BRIDGE], ["Quarters panels", S.FLOOR_QUARTERS],
    ["Console", kit.CONSOLE], ["Terminal", kit.TERMINAL], ["File bank", kit.FILES], ["Comms", kit.COMMS],
    ["Cryo pod", S.CRYO_EMPTY], ["Archive", S.SHELF], ["Engineering deck", kit.ENGINEERING_DECK],
    ["Approval", S.BADGE_ALERT], ["Question", S.BADGE_QUESTION], ["Report ready", S.BADGE_DONE],
    ["Failed", S.BADGE_ERROR], ["Monitoring", S.BADGE_MONITOR],
  ];
  for (const silhouette of ["round", "angular"] as const) for (const tier of ["light", "standard", "heavy", "reviewer"] as const) {
    assets.push([`${silhouette === "round" ? "Claude" : "Codex"} ${tier}`, flightCrew(silhouette, tier)]);
    assets.push([`${silhouette === "round" ? "Claude" : "Codex"} ${tier} seated`, flightCrew(silhouette, tier, "behind")]);
  }
  for (const [name, grid] of assets) {
    const figure = document.createElement("figure");
    const asset = document.createElement("canvas");
    const source = rasterize(grid, style, { team: TEAM.amber, screen: SCREEN.working, visor: BADGE_COLOR.get(grid) ?? (name.startsWith("Claude") ? VISOR.claude : name.startsWith("Codex") ? VISOR.codex : SCREEN.monitoring) });
    asset.width = source.width;
    asset.height = source.height;
    asset.getContext("2d")!.drawImage(source, 0, 0);
    asset.style.width = `${source.width * 3}px`;
    asset.style.height = `${source.height * 3}px`;
    const caption = document.createElement("figcaption");
    caption.textContent = name;
    figure.append(asset, caption);
    gallery.appendChild(figure);
  }
  section.appendChild(gallery);
}

const zoom = document.getElementById("zoom") as HTMLSelectElement;
zoom.addEventListener("change", () => {
  scale = Number(zoom.value);
  for (const scene of scenes) {
    scene.ctx.canvas.style.width = `${W * scale}px`;
    scene.ctx.canvas.style.height = `${H * scale}px`;
  }
});
const pause = document.getElementById("pause") as HTMLButtonElement;
pause.addEventListener("click", () => {
  paused = !paused;
  pause.textContent = paused ? "Play animation" : "Pause animation";
  pause.setAttribute("aria-pressed", String(paused));
});
const palette = document.getElementById("palette") as HTMLSelectElement;
palette.addEventListener("change", () => {
  for (const section of board.querySelectorAll<HTMLElement>("section")) {
    section.hidden = palette.value !== "all" && section.dataset.style !== palette.value;
  }
});
const requestedPalette = new URLSearchParams(location.search).get("palette");
if (requestedPalette && [...palette.options].some(option => option.value === requestedPalette)) {
  palette.value = requestedPalette;
  palette.dispatchEvent(new Event("change"));
}
paused = matchMedia("(prefers-reduced-motion: reduce)").matches;
pause.textContent = paused ? "Play animation" : "Pause animation";
pause.setAttribute("aria-pressed", String(paused));
function loop(now: number): void {
  if (previousTime && !paused) elapsed += Math.min(now - previousTime, 100);
  previousTime = now;
  const t = elapsed / 1000;
  const frame = Math.floor(t * 4);
  for (const scene of scenes) drawScene(scene.ctx, scene.style, frame, t);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
