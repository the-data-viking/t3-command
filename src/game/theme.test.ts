import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GAUGE, hudMaterials, hudTokens, STATUS, TEAM_COLORS } from "./theme";
import { BADGES } from "./map-common";
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

test("no CSS variable is defined in terms of itself", () => {
  for (const m of stylesheet.matchAll(/(--[a-z-]+)\s*:([^;]*);/g)) assert.ok(!m[2].includes(`var(${m[1]})`), `${m[1]} refers to itself`);
});

test("live styles change HUD materials but never the meaning of status or gauge colors", () => {
  const night = hudTokens("flightdeck-nightshift");
  for (const style of LIVE_STYLES.filter((s) => s !== "flightdeck-nightshift")) {
    const other = hudTokens(style);
    assert.deepEqual(Object.keys(other).sort(), Object.keys(night).sort());
    assert.notEqual(other["--frame"], night["--frame"], `${style} has its own frame`);
    assert.notEqual(other["--surface"], night["--surface"], `${style} has its own surface`);
    // A light HUD deepens the same hues so they read on pale panels; dark HUDs share them exactly.
    if (hudMaterials(style).light) {
      const statusTokens = [...Object.keys(STATUS).map((s) => `--${s}`), "--gauge-ok", "--gauge-high", "--gauge-critical"];
      for (const name of statusTokens) {
        for (const panel of ["--surface", "--deep", "--slot"]) {
          assert.ok(contrast(other[name], other[panel]) >= 4.5, `${style} ${name} readable on ${panel}`);
        }
      }
      // Still one colour per meaning: no two states blur together on cream.
      const states = ["--alert", "--question", "--working", "--monitoring", "--error", "--done"];
      for (const [i, a] of states.entries()) for (const b of states.slice(i + 1)) {
        assert.ok(deltaE(hex(other[a]), hex(other[b])) >= 15, `${style} ${a} vs ${b}`);
      }
      continue;
    }
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

test("each theme sets its own frame chrome", () => {
  const corners = new Set(LIVE_STYLES.map((s) => `${hudTokens(s)["--corner-shape"]}/${hudTokens(s)["--frame-radius"]}/${hudTokens(s)["--frame-width"]}`));
  assert.equal(corners.size, LIVE_STYLES.length, "no two themes share the same frame");
  assert.equal(hudTokens("highcontrast")["--frame-radius"], "0px");
});

/** CIE76 colour difference: ~2 is just noticeable, 20+ reads as a different colour. */
function deltaE(a: number, b: number): number {
  const lab = (c: number) => {
    const [r, g, bl] = [16, 8, 0].map((s) => ((c >> s) & 255) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const x = f((0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047), y = f(0.2126 * r + 0.7152 * g + 0.0722 * bl), z = f((0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
const hex = (s: string) => parseInt(s.slice(1), 16);

test("station colours stay clear of every status and gauge colour, and of each other", () => {
  const meanings = { ...STATUS, "gauge-high": GAUGE.high, "gauge-critical": GAUGE.critical };
  for (const team of TEAM_COLORS) {
    for (const [name, color] of Object.entries(meanings)) {
      if (name === "idle" || name === "sleeping") continue; // greys, not hues
      assert.ok(deltaE(team, color) >= 20, `team #${team.toString(16)} vs ${name}`);
    }
  }
  for (const [i, a] of TEAM_COLORS.entries()) for (const b of TEAM_COLORS.slice(i + 1)) assert.ok(deltaE(a, b) >= 20, `teams #${a.toString(16)} / #${b.toString(16)}`);
  // The failing gauge is magenta, nowhere near the approval red.
  assert.ok(deltaE(GAUGE.critical, STATUS.alert) >= 40);
});

test("status badges are drawn only in outline, white and their status colour (V)", () => {
  for (const [state, grid] of Object.entries(BADGES)) {
    const codes = new Set(grid!.join(""));
    for (const code of codes) assert.ok(".kwV".includes(code), `${state} badge uses palette code ${code}`);
    assert.ok(codes.has("V"), `${state} badge has a status fill`);
  }
});
