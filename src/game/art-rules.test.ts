import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
/** The backdrop bakes soft nebulae into a texture: the one sanctioned non-pixel shape. */
const EXEMPT = new Set(["backdrop.ts"]);

test("map code draws on the art grid: no smooth vector shapes (art bible rule 1)", () => {
  const offenders: string[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !EXEMPT.has(f))) {
    fs.readFileSync(path.join(dir, file), "utf8").split("\n").forEach((line, i) => {
      // Centred strokes and free polygons land between pixels too: lines are runs of cells (pixelPath),
      // outlines are cells inside the edge (pixelFrame, pixelBox).
      if (/\.(ellipse|circle|roundRect|arc|arcTo|bezierCurveTo|quadraticCurveTo|stroke|poly|lineTo)\(/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test("sprite art never paints with a status colour code (a, c, r, n); only badges carry status (rule 6)", async () => {
  const S = await import("../art/sprites");
  const { FLIGHT_KIT, flightCrew } = await import("../art/flightdeck");
  // The bridge-era fixtures are swapped for the Flight Deck kit when drawn (textures.ts).
  const swapped = new Set<unknown>([S.CONSOLE, S.TERMINAL, S.FILES, S.COMMS, S.CHAIR]);
  const grids: Array<[string, readonly string[]]> = [
    ...Object.entries(S.ALL).filter(([name, grid]) => !name.startsWith("BADGE_") && !swapped.has(grid)),
    ...Object.entries(FLIGHT_KIT).filter(([name, grid]) => Array.isArray(grid) && !name.startsWith("BADGE_") && !swapped.has(grid)) as Array<[string, readonly string[]]>,
  ];
  for (const silhouette of ["round", "angular"] as const) for (const tier of ["light", "standard", "heavy", "reviewer"] as const) {
    grids.push([`crew ${silhouette} ${tier}`, flightCrew(silhouette, tier)]);
  }
  const offenders = grids.filter(([, grid]) => /[acrn]/.test(grid.join(""))).map(([name]) => name);
  assert.deepEqual(offenders, []);
});
