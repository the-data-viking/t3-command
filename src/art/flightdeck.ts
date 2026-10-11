// Flight Deck: compact suited crew and broad, inset ship-system workstations.
// Original pixel geometry; provider, tier, team and activity remain independent.
import * as S from './sprites';
import { compose, type Arms, type Legs, type Silhouette, type Tier } from './render';
import { panel } from './grid';
import type { Grid } from './sprites';

const CONSOLE = panel(28, 18, [
  [3, 0, 22, 12, 'k'], [4, 1, 20, 10, 'H'], [4, 1, 20, 2, 'h'],
  [5, 3, 18, 6, 'k'], [6, 4, 16, 4, 'S'], [7, 5, 5, 1, 'x'], [15, 6, 5, 1, 'x'],
  [0, 8, 9, 10, 'k'], [1, 9, 7, 8, 'H'], [1, 9, 7, 2, 'h'], [2, 12, 5, 2, 'M'],
  [19, 8, 9, 10, 'k'], [20, 9, 7, 8, 'H'], [20, 9, 7, 2, 'h'], [21, 12, 5, 2, 'M'],
  [3, 15, 2, 1, 'm'], [23, 15, 2, 1, 'm'], [9, 10, 10, 2, 'D'],
]);
const TERMINAL = panel(24, 20, [
  [3, 0, 18, 15, 'k'], [4, 1, 16, 13, 'H'], [4, 1, 16, 2, 'h'],
  [5, 4, 14, 7, 'k'], [6, 5, 12, 5, 'S'], [7, 6, 5, 1, 'x'], [7, 8, 8, 1, 'x'],
  [0, 11, 7, 9, 'k'], [1, 12, 5, 7, 'H'], [1, 12, 5, 2, 'h'], [2, 16, 3, 1, 'M'],
  [17, 11, 7, 9, 'k'], [18, 12, 5, 7, 'H'], [18, 12, 5, 2, 'h'], [19, 16, 3, 1, 'M'],
]);
const FILES = panel(24, 20, [
  [1, 0, 22, 20, 'k'], [2, 1, 20, 18, 'H'], [2, 1, 20, 2, 'h'],
  [4, 4, 7, 13, 'k'], [13, 4, 7, 13, 'k'],
  [5, 5, 5, 3, 'M'], [5, 9, 5, 3, 'M'], [5, 13, 5, 3, 'M'],
  [14, 5, 5, 3, 'M'], [14, 9, 5, 3, 'M'], [14, 13, 5, 3, 'M'],
  [6, 6, 2, 1, 'm'], [6, 10, 2, 1, 'm'], [6, 14, 2, 1, 'm'],
  [15, 6, 2, 1, 'm'], [15, 10, 2, 1, 'm'], [15, 14, 2, 1, 'm'],
]);
const COMMS = panel(24, 20, [
  [3, 0, 18, 14, 'k'], [4, 1, 16, 12, 'H'], [4, 1, 16, 2, 'h'],
  [6, 4, 12, 8, 'k'], [7, 5, 10, 6, 'S'], [11, 5, 1, 6, 'x'], [7, 8, 10, 1, 'x'],
  [9, 6, 6, 1, 'x'], [9, 10, 6, 1, 'x'],
  [0, 11, 7, 9, 'k'], [1, 12, 5, 7, 'H'], [2, 14, 3, 1, 'M'],
  [17, 11, 7, 9, 'k'], [18, 12, 5, 7, 'H'], [19, 14, 3, 1, 'M'],
]);
const CHAIR = panel(10, 8, [[1, 0, 8, 7, 'k'], [2, 1, 6, 5, 'G'], [2, 1, 6, 1, 'g'], [0, 3, 2, 4, 'k'], [8, 3, 2, 4, 'k']]);
export const FLIGHT_KIT = { ...S, CONSOLE, TERMINAL, FILES, COMMS, CHAIR };

/** Suit mass is in the torso; headgear is compact, shoulders carry the team patch. */
export function flightCrew(silhouette: Silhouette, tier: Tier, legs: Legs = 'idle', arms: Arms = 'idle'): Grid {
  const head = silhouette === 'round'
    ? panel(16, 22, [[5, 3, 6, 1, 'k'], [4, 4, 8, 6, 'k'], [5, 4, 6, 5, 'W'], [5, 4, 6, 1, 'w'], [7, 6, 6, 3, 'k'], [8, 7, 4, 1, 'V'], [11, 7, 1, 1, 'v'], [6, 10, 5, 1, 'k']])
    : panel(16, 22, [[4, 3, 8, 7, 'k'], [5, 4, 6, 5, 'W'], [5, 4, 6, 1, 'w'], [6, 6, 8, 3, 'k'], [7, 7, 6, 1, 'V'], [11, 7, 1, 1, 'v'], [6, 10, 5, 1, 'k']]);
  const body = panel(16, 22, [[3, 11, 10, 6, 'k'], [4, 12, 8, 4, 'W'], [4, 12, 2, 3, 'w'], [10, 12, 2, 4, 's'], [6, 14, 4, 2, 'G'], [6, 14, 4, 1, 'g'], [4, 12, 2, 1, 'T']]);
  const shoulders = tier === 'heavy'
    ? panel(16, 22, [[1, 10, 5, 4, 'k'], [2, 11, 3, 2, 'T'], [10, 10, 5, 4, 'k'], [11, 11, 3, 2, 'T']])
    : tier === 'light'
      ? panel(16, 22, [[3, 11, 2, 4, 'k'], [11, 11, 2, 4, 'k'], [5, 12, 2, 1, 'T']])
      : panel(16, 22, [[3, 11, 3, 2, 'T'], [10, 11, 3, 2, 't']]);
  const pack = tier === 'heavy' ? S.PACK_HEAVY : tier === 'light' ? S.PACK_LIGHT : S.PACK_STANDARD;
  const feet = legs === 'walkA' ? S.LEGS_WALK_A : legs === 'walkB' ? S.LEGS_WALK_B : S.LEGS_IDLE;
  const hands = arms === 'typeA' ? S.ARMS_TYPE_A : arms === 'typeB' ? S.ARMS_TYPE_B : S.ARMS_IDLE;
  return compose(pack, feet, body, shoulders, head, hands, ...(tier === 'reviewer' ? [S.SCANNER] : []));
}
