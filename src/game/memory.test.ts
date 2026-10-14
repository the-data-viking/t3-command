import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PODS, podSpot } from "./memory";

const interior = { x: 22, y: 70, w: 480, h: 256 };
const hullBottom = 348;

test("pods hang newest outermost, and the overflow shares the last slot", () => {
  assert.deepEqual(podSpot(interior, hullBottom, 0), { x: 472, y: 358 });
  assert.deepEqual(podSpot(interior, hullBottom, 1), { x: 444, y: 358 });
  assert.deepEqual(podSpot(interior, hullBottom, MAX_PODS + 3), podSpot(interior, hullBottom, MAX_PODS - 1));
});
