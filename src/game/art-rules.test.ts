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
      if (/\.(ellipse|circle|roundRect|arc|arcTo|bezierCurveTo|quadraticCurveTo)\(/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});
