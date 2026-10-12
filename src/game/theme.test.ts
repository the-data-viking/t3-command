import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GAUGE, hudTokens, STATUS } from "./theme";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stylesheet = fs.readFileSync(path.join(src, "index.css"), "utf8");
const components = fs.readdirSync(path.join(src, "ui")).filter((f) => f.endsWith(".tsx"))
  .map((f) => fs.readFileSync(path.join(src, "ui", f), "utf8")).join("\n");
/** Set per element at runtime: team/visor/bot colors, portrait size, measured top bar height. */
const RUNTIME = new Set(["--team", "--visor", "--size", "--bot", "--topbar-bottom"]);
const LIVE_STYLES = ["flightdeck-nightshift", "flightdeck"] as const;

test("every CSS variable the HUD reads is generated from the theme or derived in the stylesheet", () => {
  const declared = new Set([...stylesheet.matchAll(/(--[a-z-]+)\s*:/g)].map((m) => m[1]));
  for (const style of LIVE_STYLES) {
    const generated = new Set(Object.keys(hudTokens(style)));
    const used = new Set([...(stylesheet + components).matchAll(/var\((--[a-z-]+)/g)].map((m) => m[1]).filter((name) => !name.endsWith("-")));
    // Template-built names such as var(--gauge-${level}).
    for (const level of ["ok", "high", "critical"]) used.add(`--gauge-${level}`);
    for (const name of used) assert.ok(generated.has(name) || declared.has(name) || RUNTIME.has(name), `${name} is undefined in ${style}`);
  }
  // Colors live in theme.ts, not as hand-typed CSS declarations.
  for (const name of Object.keys(hudTokens("flightdeck-nightshift"))) assert.ok(!declared.has(name), `${name} is redeclared in CSS`);
});

test("live styles change HUD materials but never the meaning of status or gauge colors", () => {
  const night = hudTokens("flightdeck-nightshift");
  const warm = hudTokens("flightdeck");
  assert.deepEqual(Object.keys(warm).sort(), Object.keys(night).sort());
  assert.notEqual(warm["--frame"], night["--frame"]);
  assert.notEqual(warm["--surface"], night["--surface"]);
  for (const state of Object.keys(STATUS)) assert.equal(warm[`--${state}`], night[`--${state}`]);
  for (const level of ["ok", "high", "critical"]) assert.equal(warm[`--gauge-${level}`], night[`--gauge-${level}`]);
  // Night Shift keeps its established chrome.
  assert.equal(night["--frame"], "#aeb7be");
  assert.equal(night["--slot"], "#11161a");
});

test("gauges share the one healthy green and never borrow approval or question colors", () => {
  assert.equal(GAUGE.ok, STATUS.done);
  for (const color of [GAUGE.high, GAUGE.critical]) {
    assert.ok(![STATUS.alert, STATUS.question, STATUS.error].includes(color));
  }
});
