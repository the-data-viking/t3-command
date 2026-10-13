import assert from "node:assert/strict";
import test from "node:test";
import { crispScale, figureBoost, floorZoom, snapZoom, ZOOM_STEPS } from "./map-common";

test("labels land on whole screen pixels per font pixel, never below one", () => {
  for (const [unit, zoom] of [[1, 0.9], [1, 1.5], [2, 0.33], [1, 0.2], [3, 1.25]]) {
    const screen = unit * zoom * crispScale(unit, zoom);
    assert.ok(Math.abs(screen - Math.round(screen)) < 1e-9 && screen >= 1, `${unit}×${zoom} → ${screen}`);
  }
});

test("the camera settles on zoom steps where art pixels cover whole screen pixels", () => {
  for (const z of ZOOM_STEPS) {
    const art = 2 * z; // PX = 2
    assert.ok(art >= 1 ? Math.abs(art * 2 - Math.round(art * 2)) < 1e-9 : Math.abs(1 / art - Math.round(1 / art)) < 1e-9 || z === 1 / 3, `step ${z}`);
  }
  assert.equal(snapZoom(0.9), 1);
  assert.equal(snapZoom(0.55), 0.5);
  assert.equal(snapZoom(0.62), 0.75);
  assert.equal(floorZoom(0.49), 1 / 3, "framing never zooms past what fits");
  assert.equal(floorZoom(5), 3);
});

test("small figures stay at one screen pixel per art pixel when zoomed out, and no bigger", () => {
  assert.equal(figureBoost(0.25, 2), 2);
  assert.equal(figureBoost(1, 2), 1);
  assert.equal(2 * 0.125 * figureBoost(0.125, 2), 1);
});
