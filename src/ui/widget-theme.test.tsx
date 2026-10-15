import assert from "node:assert/strict";
import test from "node:test";
import { STYLES, type StyleId } from "../art/palettes";
import { contrastRatio, css, hudTokens } from "../game/theme";
import { hudWidgetTheme, mix, moduleMaterials, readableOn, themeCss } from "./widget-theme";

const hex = (s: string) => parseInt(s.slice(1), 16);

test("a module is drawn in its world's hull, wall and deck, with the station's team colour", () => {
  const m = moduleMaterials("nightshift", 0x3ec7b3);
  const c = STYLES.nightshift.colors;
  assert.equal(m.vars["--module-hull"], css(c.H));
  assert.equal(m.vars["--module-outline"], css(c.k));
  assert.equal(m.vars["--module-wall"], css(STYLES.nightshift.wall));
  assert.equal(m.vars["--module-team"], "#3ec7b3");
  assert.equal(m.theme.bg, css(c.f));
  assert.equal(m.theme.accent, "#3ec7b3");
  assert.equal(moduleMaterials("flightdeck", 0).silhouette, "ftl");
  assert.equal(moduleMaterials("pastel", 0).silhouette, "soft");
  assert.equal(moduleMaterials("signal", 0).silhouette, "industrial");
});

test("module text reads on every world's hull and deck, pale ones included", () => {
  for (const id of Object.keys(STYLES) as StyleId[]) {
    const m = moduleMaterials(id, 0x5b7cff);
    const c = STYLES[id].colors;
    assert.ok(contrastRatio(hex(m.vars["--module-text"]), c.H) >= 4.5, `${id} hull text`);
    assert.ok(contrastRatio(hex(m.theme.text), c.f) >= 4.5, `${id} deck text`);
  }
});

test("pinned, a page takes the HUD's colours", () => {
  const tokens = hudTokens("flightdeck");
  const theme = hudWidgetTheme((name) => tokens[name]);
  assert.equal(theme.bg, tokens["--deep"]);
  assert.equal(theme.accent, tokens["--frame"]);
  assert.equal(theme.bad, tokens["--gauge-critical"]);
});

test("the page's stylesheet sets every --t3- variable and can't be broken out of", () => {
  const sheet = themeCss({ ...moduleMaterials("nightshift", 0).theme, text: "red;}</style><script>x</script>" });
  assert.match(sheet, /--t3-bg:#[0-9a-f]{6}/);
  assert.match(sheet, /--t3-font:/);
  assert.doesNotMatch(sheet, /<|red;}/);
});

test("colour helpers", () => {
  assert.equal(mix(0x000000, 0xffffff, 0.5), 0x808080);
  assert.equal(readableOn(0xffffff, [0xeeeeee, 0x111111]), 0x111111);
});
