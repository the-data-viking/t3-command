import assert from 'node:assert/strict';
import test from 'node:test';
import { ENGINEERING_SPOTS, FLIGHT_KIT } from '../art/flightdeck';
import { computeFleetLayout, ENV_BAY, ENV_NODE_H, ENV_NODE_W } from './layout';
import type { GameState } from '../store';

const PX = 2; // textures.ts; importing it would pull in Pixi.
const deck = FLIGHT_KIT.ENGINEERING_DECK;
const at = (x: number, y: number) => deck[y]?.[x];
const cells = (s: { x: number; y: number; w: number; h: number }) =>
  Array.from({ length: s.w * s.h }, (_, i) => at(s.x + (i % s.w), s.y + Math.floor(i / s.w)));

test('the engineering deck fills its node footprint exactly', () => {
  assert.equal(deck.length * PX, ENV_NODE_H);
  assert.ok(deck.every((row) => row.length * PX === ENV_NODE_W));
});

test('every light sits on a dark socket, so lit and unlit states read on both palettes', () => {
  const sockets = new Set(['k', 'D']);
  for (const spot of [...ENGINEERING_SPOTS.leds, ...ENGINEERING_SPOTS.cells, ENGINEERING_SPOTS.coolant, ENGINEERING_SPOTS.bayScreen]) {
    assert.ok(cells(spot).every((code) => sockets.has(code!)), `light at ${spot.x},${spot.y} is not on a socket`);
  }
  // Ten LEDs make a 10% CPU scale, filling bottom-up across both racks.
  assert.equal(ENGINEERING_SPOTS.leds.length, 10);
  const ys = ENGINEERING_SPOTS.leds.map((l) => l.y);
  assert.deepEqual(ys, [...ys].sort((a, b) => b - a));
});

test('the art is materials only: no status or accent light codes are baked in', () => {
  // r/n/c/a/S/x would light the deck regardless of observed state.
  for (const row of deck) assert.doesNotMatch(row, /[rncaSx]/);
  assert.ok(deck.some((row) => row.includes('T')), 'the environment stripe identifies the deck');
});

test('the status plate matches the layout plate the map draws pips into', () => {
  const state = { envs: { a: { summary: { id: 'a', addedAt: '2026-01-01' }, projects: {}, threads: {} } } } as unknown as GameState;
  const node = computeFleetLayout(state).environmentNodes.get('a')!;
  const p = ENGINEERING_SPOTS.plate;
  assert.deepEqual(node.plate, { x: node.hull.x + p.x * PX, y: node.hull.y + p.y * PX, w: p.w * PX, h: p.h * PX });
});

test('the bay crew stand in matches the sprite bay, inside the hull and above the plate', () => {
  const b = ENGINEERING_SPOTS.bay;
  assert.deepEqual(ENV_BAY, { x: b.x * PX, y: b.y * PX, w: b.w * PX, h: b.h * PX });
  assert.ok(b.y + b.h <= ENGINEERING_SPOTS.plate.y && b.x + b.w < deck[0].length);
});
