// Signal Workshop concept kit. Pixel geometry, not baked images: team, provider and
// activity colors remain replaceable. Kept on the review board until the direction is chosen.
import * as S from './sprites';
import { compose, crewGrid, type Arms, type Legs, type Silhouette, type Tier } from './render';
import type { Grid } from './sprites';

import { panel } from "./grid";

// A tug built around a copper service spine: offset ceramic cargo pods, blunt cockpit,
// radiator fins and a dorsal aerial. Its silhouette stays recognizable without color.
const SHIP = panel(54, 24, [
  [8, 10, 39, 8, 'k'], [9, 11, 37, 6, 'M'], [11, 12, 33, 2, 'm'],
  [1, 10, 8, 8, 'k'], [2, 11, 5, 6, 'D'], [6, 11, 2, 6, 'H'],
  [12, 4, 16, 8, 'k'], [13, 5, 14, 6, 'H'], [13, 5, 14, 2, 'h'], [15, 8, 10, 2, 'T'],
  [20, 16, 16, 8, 'k'], [21, 17, 14, 6, 'H'], [21, 17, 14, 2, 'h'], [23, 20, 10, 2, 'T'],
  [39, 7, 12, 12, 'k'], [40, 8, 10, 10, 'H'], [40, 8, 10, 2, 'h'],
  [43, 11, 9, 5, 'k'], [44, 12, 7, 3, 'c'], [44, 12, 2, 1, 'w'],
  [31, 5, 5, 5, 'k'], [32, 6, 1, 3, 'm'], [34, 6, 1, 3, 'm'],
  [32, 0, 1, 5, 'k'], [28, 0, 9, 1, 'm'],
]);
const CONSOLE = panel(24, 14, [
  [0, 5, 24, 7, 'k'], [1, 6, 22, 5, 'H'], [1, 6, 22, 1, 'h'],
  [2, 0, 12, 7, 'k'], [3, 1, 10, 5, 'S'], [4, 2, 5, 1, 'x'], [4, 4, 7, 1, 'x'],
  [16, 1, 6, 5, 'k'], [17, 2, 4, 3, 'M'], [18, 3, 2, 1, 'm'],
  [3, 9, 9, 1, 'M'], [14, 9, 2, 1, 'm'], [18, 9, 2, 1, 'm'],
  [3, 12, 3, 2, 'k'], [18, 12, 3, 2, 'k'],
]);
const TERMINAL = panel(16, 18, [
  [2, 0, 12, 12, 'k'], [3, 1, 10, 10, 'H'], [3, 1, 10, 2, 'h'],
  [4, 4, 8, 5, 'k'], [5, 5, 6, 3, 'S'], [6, 6, 3, 1, 'x'],
  [0, 11, 16, 4, 'k'], [1, 12, 14, 2, 'm'], [3, 12, 6, 1, 'M'],
  [2, 15, 2, 3, 'k'], [12, 15, 2, 3, 'k'], [6, 15, 4, 2, 'M'],
]);
const FILES = panel(14, 18, [
  [0, 0, 14, 18, 'k'], [1, 1, 12, 16, 'M'], [1, 1, 12, 2, 'm'],
  [3, 4, 8, 3, 'H'], [3, 8, 8, 3, 'H'], [3, 12, 8, 3, 'H'],
  [4, 4, 6, 1, 'h'], [4, 8, 6, 1, 'h'], [4, 12, 6, 1, 'h'],
  [6, 5, 3, 1, 'k'], [6, 9, 3, 1, 'k'], [6, 13, 3, 1, 'k'],
]);
const COMMS = panel(16, 18, [
  [0, 14, 16, 4, 'k'], [1, 15, 14, 2, 'M'], [3, 15, 5, 1, 'm'],
  [10, 6, 3, 8, 'k'], [11, 6, 1, 8, 'm'],
  [4, 0, 11, 8, 'k'], [5, 1, 9, 6, 'H'], [6, 2, 7, 4, 'h'],
  [8, 3, 3, 2, 'k'], [9, 3, 1, 2, 'M'], [2, 3, 3, 1, 'm'],
]);
const DOOR_H = panel(16, 4, [[0, 0, 16, 4, 'k'], [1, 1, 14, 2, 'M'], [2, 1, 5, 1, 'h'], [9, 1, 5, 1, 'h'], [7, 1, 2, 2, 'k']]);

export const SIGNAL_KIT = { ...S, SHIP, CONSOLE, TERMINAL, FILES, COMMS, DOOR_H };

/** Smaller headgear, dark workwear, ceramic shoulders and an exposed copper tool belt. */
export function signalCrew(silhouette: Silhouette, tier: Tier, legs: Legs = 'idle', arms: Arms = 'idle'): Grid {
  const base = crewGrid(silhouette, tier, legs, arms).map((row, y) =>
    y < 12 ? '.'.repeat(S.CREW_W) : row.replace(/W/g, 'G').replace(/w/g, 'g').replace(/s/g, 'G'),
  );
  const head = silhouette === 'round'
    ? panel(16, 22, [[4, 3, 8, 8, 'k'], [5, 4, 6, 6, 'H'], [4, 4, 8, 2, 'h'], [7, 6, 7, 4, 'k'], [8, 7, 5, 2, 'V'], [11, 7, 1, 1, 'v'], [3, 7, 2, 3, 'M'], [6, 11, 5, 1, 'T']])
    : panel(16, 22, [[3, 3, 10, 8, 'k'], [4, 4, 8, 6, 'H'], [4, 4, 8, 2, 'h'], [6, 6, 9, 3, 'k'], [7, 7, 7, 1, 'V'], [12, 7, 1, 1, 'v'], [3, 10, 3, 1, 'M'], [6, 11, 5, 1, 'T']]);
  const belt = panel(16, 22, [[4, 16, 8, 1, 'M'], [9, 15, 2, 2, 'm']]);
  return compose(base, head, belt, ...(tier === 'reviewer' ? [S.SCANNER] : []));
}
