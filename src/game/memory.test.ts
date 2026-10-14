import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PODS, podSpot, tallyBand, tallyMark } from "./memory";

const interior = { x: 22, y: 70, w: 480, h: 256 };
const hullBottom = 348;

test("tally marks run in groups of five from the left of the band; the fifth crosses its group", () => {
  const band = tallyBand(interior, hullBottom)!;
  assert.deepEqual(tallyMark(interior, hullBottom, 1), { x: 32, y: band.y });
  assert.deepEqual(tallyMark(interior, hullBottom, 4), { x: 44, y: band.y });
  assert.deepEqual(tallyMark(interior, hullBottom, 5), { x: 38, y: band.y });
  assert.deepEqual(tallyMark(interior, hullBottom, 6), { x: 56, y: band.y });
  assert.equal(tallyMark(interior, hullBottom, 0), undefined);
  assert.equal(tallyMark(interior, interior.y + interior.h + 8, 1), undefined, "too shallow a hull has no band");
});

test("pods hang newest outermost, and the overflow shares the last slot", () => {
  assert.deepEqual(podSpot(interior, hullBottom, 0), { x: 472, y: 358 });
  assert.deepEqual(podSpot(interior, hullBottom, 1), { x: 444, y: 358 });
  assert.deepEqual(podSpot(interior, hullBottom, MAX_PODS + 3), podSpot(interior, hullBottom, MAX_PODS - 1));
});
