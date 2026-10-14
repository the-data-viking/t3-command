import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_VISOR, GAUGE, HERMES_COLOR, hudAccent, hudMaterials, hudTokens, PROVIDER_VISOR, STATUS, TEAM_COLORS } from "./theme";
import { BOT_COLORS } from "../t3/bots";
import { BADGES } from "./map-common";
import { ART_STYLES } from "../store";
import { STYLES } from "../art/palettes";

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
    // Dark HUDs share them exactly, except where a theme hand-tunes one for its own panels.
    const tuned = hudMaterials(style).tokens ?? {};
    for (const state of Object.keys(STATUS)) if (!(state in tuned)) assert.equal(other[`--${state}`], night[`--${state}`]);
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
  // Control and chip borders show where a control is, on its panel.
  for (const style of LIVE_STYLES) assert.ok(contrast(hudTokens(style)["--edge-strong"], hudTokens(style)["--surface"]) >= 2.7, `${style}: control borders`);
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

test("bot colours stay clear of Hermes tan, which means the hall", () => {
  for (const bot of BOT_COLORS) assert.ok(deltaE(bot, HERMES_COLOR) >= 15, `bot #${bot.toString(16)} vs Hermes tan`);
});

test("status badges are drawn only in outline, white and their status colour (V)", () => {
  for (const [state, grid] of Object.entries(BADGES)) {
    const codes = new Set(grid!.join(""));
    for (const code of codes) assert.ok(".kwV".includes(code), `${state} badge uses palette code ${code}`);
    assert.ok(codes.has("V"), `${state} badge has a status fill`);
  }
});

test("text on every status fill reads at 4.5:1 or better, in every theme", () => {
  for (const style of LIVE_STYLES) {
    const t = hudTokens(style);
    for (const state of Object.keys(STATUS)) assert.ok(contrast(t[`--on-${state}`], t[`--${state}`]) >= 4.5, `${style} ${state} pill`);
  }
});

test("interface colours never borrow a status: no accent tokens, charts and frames clear of status hues", () => {
  const hues = ["alert", "question", "working", "monitoring", "error", "done"];
  for (const style of LIVE_STYLES) {
    const t = hudTokens(style);
    assert.ok(!("--cyan" in t) && !("--amber" in t), `${style} still generates an accent that doubles as a status`);
    // The two host-chart series are told apart from each other.
    assert.ok(deltaE(hex(t["--chart-cpu"]), hex(t["--chart-ram"])) >= 20, `${style} CPU vs RAM series`);
    for (const name of ["--frame", "--chart-cpu", "--chart-ram"]) {
      for (const state of hues) assert.ok(deltaE(hex(t[name]), hex(t[`--${state}`])) >= 15, `${style} ${name} vs ${state}`);
    }
  }
});

test("visor glass stays clear of every status hue", () => {
  const hues = { alert: STATUS.alert, question: STATUS.question, working: STATUS.working, monitoring: STATUS.monitoring, error: STATUS.error, done: STATUS.done, high: GAUGE.high, critical: GAUGE.critical };
  for (const [provider, visor] of Object.entries({ ...PROVIDER_VISOR, default: DEFAULT_VISOR })) {
    for (const [name, color] of Object.entries(hues)) assert.ok(deltaE(visor, color) >= 20, `${provider} visor vs ${name}`);
  }
});

test("each status badge has its own silhouette, matching its fleet-view glyph", () => {
  const mask = (grid: readonly string[]): number[][] => grid.map((row) => [...row].map((c) => (c === "." ? 0 : 1)));
  const entries = Object.entries(BADGES).map(([state, grid]) => [state, mask(grid!)] as const);
  for (const [i, [a, ma]] of entries.entries()) for (const [b, mb] of entries.slice(i + 1)) {
    const differ = ma.flat().filter((v, k) => v !== mb.flat()[k]).length;
    assert.ok(differ >= 6, `${a} and ${b} badges differ by only ${differ} cells`);
  }
  const widths = (state: string) => mask(BADGES[state as keyof typeof BADGES]!).map((row) => row.reduce((n, v) => n + v, 0));
  const alert = widths("alert"), question = widths("question");
  assert.ok(alert[0] < alert[4] && alert[4] < alert[8], "approval is a ▲, widening downward");
  assert.ok(question[4] === Math.max(...question) && question[0] < question[4] && question[8] < question[4], "question is a ◆, widest in the middle");
});

test("every theme is its own place: no two share a HUD or a map, and Hermes stands out from each frame", () => {
  const hud = (id: (typeof LIVE_STYLES)[number]) => { const t = hudTokens(id); return ["--surface", "--frame", "--slot"].map((n) => hex(t[n])); };
  const map = (id: (typeof LIVE_STYLES)[number]) => ["H", "f", "p"].map((code) => STYLES[id].colors[code]);
  for (const [i, a] of LIVE_STYLES.entries()) for (const b of LIVE_STYLES.slice(i + 1)) {
    const hudGap = Math.max(...hud(a).map((c, k) => deltaE(c, hud(b)[k])));
    const mapGap = Math.max(...map(a).map((c, k) => deltaE(c, map(b)[k])));
    assert.ok(hudGap >= 20, `${a} and ${b} HUDs are near-duplicates (max ΔE ${hudGap.toFixed(1)})`);
    assert.ok(mapGap >= 20 || a === "flightdeck-nightshift" && b === "highcontrast" || hudGap >= 40, `${a} and ${b} maps are near-duplicates (max ΔE ${mapGap.toFixed(1)})`);
  }
  for (const id of LIVE_STYLES) {
    const t = hudTokens(id);
    assert.ok(deltaE(hex(t["--hermes"]), hex(t["--frame"])) >= 25, `${id}: Hermes tan blends into the frame`);
  }
});

test("in every theme, no status reads as a caution or critical gauge (the risk lens's colours)", () => {
  for (const style of LIVE_STYLES) {
    const t = hudTokens(style);
    for (const state of ["alert", "question", "working", "monitoring", "error", "done"]) {
      for (const gauge of ["--gauge-high", "--gauge-critical"]) {
        assert.ok(deltaE(hex(t[`--${state}`]), hex(t[gauge])) >= 15, `${style} ${state} vs ${gauge}`);
      }
    }
  }
});

test("station colours stay clear of every world's chrome and of Hermes", () => {
  for (const style of LIVE_STYLES) {
    const t = hudTokens(style);
    for (const team of TEAM_COLORS) {
      for (const name of ["--frame", "--hermes"]) assert.ok(deltaE(team, hex(t[name])) >= 15, `${style} team #${team.toString(16)} vs ${name}`);
    }
  }
});

test("idle and asleep are told apart, from each other and from muted text, in every theme", () => {
  for (const style of LIVE_STYLES) {
    const t = hudTokens(style);
    assert.ok(deltaE(hex(t["--idle"]), hex(t["--sleeping"])) >= 15, `${style}: idle vs asleep`);
    for (const state of ["idle", "sleeping"]) {
      assert.ok(deltaE(hex(t[`--${state}`]), hex(t["--muted"])) >= 12, `${style}: ${state} reads as muted text`);
      assert.ok(deltaE(hex(t[`--${state}`]), hex(t["--monitoring"])) >= 25, `${style}: ${state} vs monitoring`);
      for (const panel of ["--surface", "--slot", "--control"]) assert.ok(contrast(t[`--${state}`], t[panel]) >= 4.5, `${style}: ${state} on ${panel}`);
    }
  }
});

test("muted text never reads as a status, and Hermes tan stays Hermes's own", () => {
  for (const style of LIVE_STYLES) {
    const t = hudTokens(style);
    for (const state of ["alert", "question", "working", "monitoring", "error", "done"]) {
      assert.ok(deltaE(hex(t[`--${state}`]), hex(t["--muted"])) >= 15, `${style}: ${state} vs muted`);
    }
    assert.ok(deltaE(hex(t["--hermes"]), hex(t["--muted"])) >= 20, `${style}: muted text reads as Hermes`);
    assert.ok(deltaE(hex(t["--hermes"]), hex(t["--text"])) >= 15, `${style}: body text reads as Hermes`);
    for (const panel of ["--surface", "--control"]) assert.ok(contrast(t["--alert"], t[panel]) >= 4.5, `${style}: approval red on ${panel}`);
  }
});

test("idle never reads as body text, the frame or a visor, in any theme", () => {
  for (const style of LIVE_STYLES) {
    const t = hudTokens(style);
    assert.ok(deltaE(hex(t["--idle"]), hex(t["--text"])) >= 12, `${style}: idle vs body text`);
    assert.ok(deltaE(hex(t["--idle"]), hex(t["--frame"])) >= 10, `${style}: idle vs frame`);
    assert.ok(deltaE(hex(t["--idle"]), DEFAULT_VISOR) >= 8, `${style}: idle vs the default visor`);
  }
});

test("station colours as the HUD draws them stay clear of every status and gauge, light themes included", () => {
  const meanings = ["alert", "question", "working", "monitoring", "error", "done", "gauge-high", "gauge-critical"];
  for (const style of LIVE_STYLES) {
    const t = hudTokens(style);
    for (const team of TEAM_COLORS) {
      const shown = hudAccent(team, style);
      for (const name of meanings) assert.ok(deltaE(shown, hex(t[`--${name}`])) >= 15, `${style} team #${team.toString(16)} (#${shown.toString(16)}) vs ${name}`);
    }
  }
});
