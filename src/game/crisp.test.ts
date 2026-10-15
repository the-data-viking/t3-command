import assert from "node:assert/strict";
import test from "node:test";
import { crispScale, figureBoost, FLEET_VIEW_ZOOM, floorZoom, settleZoom, snapZoom, ZOOM_STEPS } from "./map-common";

test("labels land on whole screen pixels per font pixel, never below one", () => {
  for (const [unit, zoom] of [[1, 0.9], [1, 1.5], [2, 0.33], [1, 0.2], [3, 1.25]]) {
    const screen = unit * zoom * crispScale(unit, zoom);
    assert.ok(Math.abs(screen - Math.round(screen)) < 1e-9 && screen >= 1, `${unit}×${zoom} → ${screen}`);
  }
});

test("the camera settles on zoom steps where art pixels cover whole screen pixels (or, in the fleet view, glyph cells do)", () => {
  for (const z of ZOOM_STEPS) {
    const art = 2 * z; // PX = 2
    // Below FLEET_VIEW_ZOOM the map is flat glyphs and blocks: whole-pixel glyph cells are what count.
    const crisp = z < FLEET_VIEW_ZOOM ? Number.isInteger(3 / z)
      : art >= 1 ? Math.abs(art * 2 - Math.round(art * 2)) < 1e-9 : Math.abs(1 / art - Math.round(1 / art)) < 1e-9;
    assert.ok(crisp, `step ${z}`);
  }
  assert.equal(snapZoom(0.9), 1);
  assert.equal(snapZoom(0.55), 0.5);
  assert.equal(snapZoom(1.3), 1);
  assert.equal(floorZoom(0.49), 3 / 7, "framing never zooms past what fits");
  assert.equal(floorZoom(5), 3);
});

test("at every zoom step from 1 up, art pixels and font pixels (1–3 world px) land on whole screen pixels", () => {
  for (const z of ZOOM_STEPS.filter((s) => s >= 1)) {
    for (const unit of [1, 2, 3, 2 /* PX */]) assert.ok(Number.isInteger(unit * z), `unit ${unit} at zoom ${z}`);
  }
});

test("in the fleet view every zoom step draws glyph cells three whole screen pixels wide", () => {
  for (const z of ZOOM_STEPS.filter((s) => s < FLEET_VIEW_ZOOM)) assert.ok(Number.isInteger(3 / z), `zoom ${z}`);
});

test("small figures stay at one screen pixel per art pixel when zoomed out, and no bigger", () => {
  assert.equal(figureBoost(0.25, 2), 2);
  assert.equal(figureBoost(1, 2), 1);
  assert.equal(2 * 0.125 * figureBoost(0.125, 2), 1);
});

test("supply lines stay about two screen pixels wide at every zoom step", async () => {
  const { linkWidth } = await import("./world");
  const { ZOOM_STEPS } = await import("./map-common");
  for (const z of ZOOM_STEPS) {
    const screen = linkWidth(z) * z;
    assert.ok(screen >= 1.5, `zoom ${z}: ${screen} screen px`);
    assert.equal(linkWidth(z) % 2, 0, "whole art pixels");
  }
  assert.equal(linkWidth(1), 2);
});

test("a wheel or pinch zoom rests on a step, at least one step the way it went", () => {
  // One notch in from 0.5 reaches ~0.57: nearest is still 0.5, so it goes on to 1.
  assert.equal(settleZoom(0.5, 0.57), 1);
  assert.equal(settleZoom(1, 0.86), 0.5);
  // Far enough, the nearest step wins.
  assert.equal(settleZoom(0.5, 1.9), 2);
  assert.equal(settleZoom(1, 0.3), 1 / 3);
  // A gesture that barely moved stays put, and the ends hold.
  assert.equal(settleZoom(1, 1.01), 1);
  assert.equal(settleZoom(3, 3.5), 3);
  assert.equal(settleZoom(0.125, 0.11), 0.125);
});
