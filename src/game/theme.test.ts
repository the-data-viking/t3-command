import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GAUGE, hudTokens, STATUS } from "./theme";
import { ART_STYLES } from "../store";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stylesheet = fs.readFileSync(path.join(src, "index.css"), "utf8");
const components = fs.readdirSync(path.join(src, "ui")).filter((f) => f.endsWith(".tsx"))
  .map((f) => fs.readFileSync(path.join(src, "ui", f), "utf8")).join("\n");
/** Set per element at runtime: team/visor/bot colors, portrait size, measured top bar height. */
const RUNTIME = new Set(["--team", "--visor", "--size", "--bot", "--topbar-bottom"]);
const LIVE_STYLES = ART_STYLES;

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
  for (const style of LIVE_STYLES.filter((s) => s !== "flightdeck-nightshift")) {
    const other = hudTokens(style);
    assert.deepEqual(Object.keys(other).sort(), Object.keys(night).sort());
    assert.notEqual(other["--frame"], night["--frame"], `${style} has its own frame`);
    assert.notEqual(other["--surface"], night["--surface"], `${style} has its own surface`);
    for (const state of Object.keys(STATUS)) assert.equal(other[`--${state}`], night[`--${state}`]);
    for (const level of ["ok", "high", "critical"]) assert.equal(other[`--gauge-${level}`], night[`--gauge-${level}`]);
  }
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

/** WCAG relative-luminance contrast between two "#rrggbb" colors. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("every theme keeps text readable, and High Contrast goes further", () => {
  for (const style of LIVE_STYLES) {
    const t = hudTokens(style);
    assert.ok(contrast(t["--text"], t["--surface"]) >= 7, `${style}: body text`);
    assert.ok(contrast(t["--muted"], t["--surface"]) >= 4.5, `${style}: muted text`);
    assert.ok(contrast(t["--ink"], t["--frame"]) >= 4.5, `${style}: tab labels`);
  }
  const hc = hudTokens("highcontrast");
  assert.ok(contrast(hc["--text"], hc["--surface"]) >= 18);
  assert.ok(contrast(hc["--muted"], hc["--surface"]) >= 10);
  assert.ok(contrast(hc["--edge-strong"], hc["--surface"]) >= 7, "borders stand out");
});
