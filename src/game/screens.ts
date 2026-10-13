// What the screens show: the console of a crew member writing scrolls typed lines with a
// cursor, a terminal in use runs a prompt and scrolling output, and a console waiting on you or
// reporting back shows its status shape (▲ ◆ ✓ ✕, dark on the lit screen) — the same shapes as the badges. Each is a
// variant of the fixture's grid with its screen cells redrawn, cached so textures memoize.

import { FLIGHT_KIT } from "../art/flightdeck";
import type { Grid } from "../art/sprites";
import type { UnitState } from "../t3/derive";

interface Area { x: number; y: number; w: number; h: number }

/** The screen rectangles of the flight-kit console and terminal (see flightdeck.ts). */
const CONSOLE_AREA: Area = { x: 6, y: 4, w: 16, h: 4 };
const TERMINAL_AREA: Area = { x: 6, y: 5, w: 12, h: 5 };

const cache = new Map<string, Grid>();

/** The base grid with its screen cleared to S and the given cells set to `ink` (the highlight x by default). */
function paint(base: Grid, area: Area, key: string, cells: Array<[number, number]>, ink = "x"): Grid {
  const hit = cache.get(key);
  if (hit) return hit;
  const rows = base.map((r) => r.split(""));
  for (let y = 0; y < area.h; y++) for (let x = 0; x < area.w; x++) rows[area.y + y][area.x + x] = "S";
  for (const [x, y] of cells) if (x >= 0 && y >= 0 && x < area.w && y < area.h) rows[area.y + y][area.x + x] = ink;
  const grid = rows.map((r) => r.join(""));
  cache.set(key, grid);
  return grid;
}

/** A line of "text": runs of cells with word gaps, seeded by the line number. */
function textCells(line: number, length: number, y: number, x0 = 0): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  for (let x = 0; x < length; x++) if ((x * 7 + line * 3) % 5 !== 2) cells.push([x0 + x, y]);
  return cells;
}

const LINE_LENGTHS = [11, 7, 14, 9, 5, 12, 8, 13, 6, 10];
const len = (line: number, max: number) => Math.min(max, LINE_LENGTHS[line % LINE_LENGTHS.length]);

/** Writing: lines type out four frames each and scroll up, with a blinking cursor. */
function typing(frame: number): Grid {
  const step = frame % 40;
  const line = Math.floor(step / 4), progress = (step % 4) + 1;
  const cells: Array<[number, number]> = [];
  const first = Math.max(0, line - (CONSOLE_AREA.h - 1));
  for (let l = first; l <= line; l++) {
    const y = l - first;
    const full = len(l, CONSOLE_AREA.w - 2);
    const shown = l === line ? Math.ceil((full * progress) / 4) : full;
    cells.push(...textCells(l, shown, y));
    if (l === line && frame % 2 === 0) cells.push([shown + 1, y]);
  }
  return paint(FLIGHT_KIT.CONSOLE, CONSOLE_AREA, `type:${step}:${frame % 2}`, cells);
}

/** A terminal in use: output scrolling under a prompt (">") line every few lines. */
export function terminalScreen(frame: number): Grid {
  const step = frame % 20;
  const cells: Array<[number, number]> = [];
  for (let y = 0; y < TERMINAL_AREA.h; y++) {
    const line = step + y;
    if (line % 5 === 0) {
      cells.push([0, y], ...textCells(line, len(line, 8), y, 2));
    } else cells.push(...textCells(line, len(line, TERMINAL_AREA.w - 1), y));
  }
  return paint(FLIGHT_KIT.TERMINAL, TERMINAL_AREA, `term:${step}`, cells);
}

/** Status shapes, 4 rows tall, as in the badges. */
const SHAPES: Partial<Record<UnitState, string[]>> = {
  alert: ["...x...", "..x.x..", ".x...x.", "xxxxxxx"],
  question: ["..x..", ".x.x.", ".x.x.", "..x.."],
  done: ["....x", "...x.", "x.x..", ".x..."],
  error: ["x..x", ".xx.", ".xx.", "x..x"],
};

function shape(state: UnitState): Grid | undefined {
  const rows = SHAPES[state];
  if (!rows) return undefined;
  const x0 = Math.floor((CONSOLE_AREA.w - rows[0].length) / 2);
  const cells: Array<[number, number]> = [];
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === "x") cells.push([x0 + x, y]); }));
  // Dark on the lit screen, like an LCD: the shape reads at a glance whatever the status colour.
  return paint(FLIGHT_KIT.CONSOLE, CONSOLE_AREA, `shape:${state}`, cells, "k");
}

/** The console grid for its crew member's state; the plain console when there's nothing to show. */
export function consoleScreen(state: UnitState, frame: number, atConsole: boolean): Grid {
  if (state === "working" && atConsole) return typing(frame);
  return shape(state) ?? FLIGHT_KIT.CONSOLE;
}
