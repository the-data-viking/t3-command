// Flight Deck: compact suited crew and broad, inset ship-system workstations.
// Original pixel geometry; provider, tier, team and activity remain independent.
import * as S from './sprites';
import { compose, type Arms, type Head, type Legs, type Silhouette, type Tier } from './render';
import { panel, type PixelBox } from './grid';
import type { Grid } from './sprites';

const CONSOLE = panel(28, 18, [
  [3, 0, 22, 12, 'k'], [4, 1, 20, 10, 'H'], [4, 1, 20, 2, 'h'],
  [23, 3, 1, 8, 'D'], [4, 10, 20, 1, 'D'],
  [5, 3, 18, 6, 'k'], [6, 4, 16, 4, 'S'], [7, 5, 5, 1, 'x'], [15, 6, 5, 1, 'x'],
  [0, 8, 9, 10, 'k'], [1, 9, 7, 8, 'H'], [1, 9, 7, 2, 'h'], [2, 12, 5, 2, 'M'],
  [19, 8, 9, 10, 'k'], [20, 9, 7, 8, 'H'], [20, 9, 7, 2, 'h'], [21, 12, 5, 2, 'M'],
  [3, 15, 2, 1, 'm'], [23, 15, 2, 1, 'm'], [9, 10, 10, 2, 'D'],
]);
const TERMINAL = panel(24, 20, [
  [3, 0, 18, 15, 'k'], [4, 1, 16, 13, 'H'], [4, 1, 16, 2, 'h'],
  [19, 3, 1, 11, 'D'], [4, 13, 16, 1, 'D'],
  [5, 4, 14, 7, 'k'], [6, 5, 12, 5, 'S'], [7, 6, 5, 1, 'x'], [7, 8, 8, 1, 'x'],
  [0, 11, 7, 9, 'k'], [1, 12, 5, 7, 'H'], [1, 12, 5, 2, 'h'], [2, 16, 3, 1, 'M'],
  [17, 11, 7, 9, 'k'], [18, 12, 5, 7, 'H'], [18, 12, 5, 2, 'h'], [19, 16, 3, 1, 'M'],
]);
const FILES = panel(24, 20, [
  [1, 0, 22, 20, 'k'], [2, 1, 20, 18, 'H'], [2, 1, 20, 2, 'h'], [21, 3, 1, 16, 'D'], [2, 18, 20, 1, 'D'],
  [4, 4, 7, 13, 'k'], [13, 4, 7, 13, 'k'],
  [5, 5, 5, 3, 'M'], [5, 9, 5, 3, 'M'], [5, 13, 5, 3, 'M'],
  [14, 5, 5, 3, 'M'], [14, 9, 5, 3, 'M'], [14, 13, 5, 3, 'M'],
  // Drawer lamps are screen cells: dark until crew pull files, then lit like the other systems.
  [6, 6, 2, 1, 'S'], [6, 10, 2, 1, 'S'], [6, 14, 2, 1, 'S'],
  [15, 6, 2, 1, 'S'], [15, 10, 2, 1, 'S'], [15, 14, 2, 1, 'S'],
]);
// The comms console carries a dish on a short mast, so the room reads apart from the terminal
// even with its screen dark.
const COMMS = panel(24, 28, [
  [5, 0, 14, 1, 'k'], [6, 1, 12, 1, 'k'], [7, 1, 10, 1, 'h'], [8, 2, 8, 1, 'k'], [9, 2, 6, 1, 'm'], [10, 3, 4, 1, 'k'],
  [11, 4, 2, 4, 'k'], [12, 4, 1, 4, 'M'],
  [3, 8, 18, 14, 'k'], [4, 9, 16, 12, 'H'], [4, 9, 16, 2, 'h'], [19, 11, 1, 10, 'D'], [4, 20, 16, 1, 'D'], [6, 12, 12, 8, 'k'], [7, 13, 10, 6, 'S'], [11, 13, 1, 6, 'x'], [7, 16, 10, 1, 'x'], [9, 14, 6, 1, 'x'], [9, 18, 6, 1, 'x'], [0, 19, 7, 9, 'k'], [1, 20, 5, 7, 'H'], [2, 22, 3, 1, 'M'], [17, 19, 7, 9, 'k'], [18, 20, 5, 7, 'H'], [19, 22, 3, 1, 'M'],
]);
const CHAIR = panel(10, 8, [[1, 0, 8, 7, 'k'], [2, 1, 6, 5, 'G'], [2, 1, 6, 1, 'g'], [0, 3, 2, 4, 'k'], [8, 3, 2, 4, 'k']]);

// ---- Engineering deck: one per environment, docked to its projects ----
// A compute bay (storage racks) beside an engine bay (core, coolant tank, cooling fins).
// Drawn only in materials plus the environment's stripe (T/t): every light is an overlay the
// map draws from measured host load and observed crew, so the art never implies activity.

const RACK_X = [7, 26];
const RACK_ROWS = 5;
const CELL_X = [58, 64, 70, 76];

function rack(x: number): PixelBox[] {
  const rows: PixelBox[] = [];
  for (let i = 0; i < RACK_ROWS; i++) {
    const y = 21 + i * 5;
    rows.push([x + 2, y, 12, 3, 'M'], [x + 3, y + 1, 5, 1, 'm'], [x + 10, y + 1, 2, 1, 'k']);
  }
  return [
    [x, 17, 16, 30, 'k'], [x + 1, 18, 14, 28, 'G'], [x + 1, 18, 14, 2, 'g'],
    ...rows,
    [x + 2, 47, 3, 2, 'k'], [x + 11, 47, 3, 2, 'k'],
  ];
}

const ENGINEERING_DECK = panel(144, 76, [
  // Chamfered hull: outline, plating, top highlight, bottom shadow.
  [6, 0, 132, 76, 'k'], [4, 2, 136, 72, 'k'], [2, 4, 140, 68, 'k'], [0, 6, 144, 64, 'k'],
  [7, 2, 130, 72, 'H'], [5, 4, 134, 68, 'H'], [3, 6, 138, 64, 'H'], [2, 8, 140, 60, 'H'],
  [7, 2, 130, 1, 'h'], [7, 73, 130, 1, 'D'],
  // Nameplate recess and the environment's identity stripe.
  [5, 5, 70, 8, 'k'], [78, 7, 60, 1, 'T'], [78, 8, 60, 1, 't'],
  // Compute bay: two storage racks.
  [4, 14, 42, 46, 'k'], [5, 15, 40, 44, 'F'], [6, 56, 38, 2, 'D'],
  ...rack(RACK_X[0]), ...rack(RACK_X[1]),
  [5, 49, 40, 7, 'k'], // Readout strip, legible on light and dark decks.
  // Engine bay: core housing with four cell windows.
  [49, 14, 59, 46, 'k'], [50, 15, 57, 44, 'F'], [51, 56, 55, 2, 'D'],
  [52, 17, 32, 30, 'k'], [53, 18, 30, 28, 'H'], [53, 18, 30, 2, 'h'],
  [56, 21, 24, 20, 'k'], [57, 22, 22, 1, 'M'], [57, 39, 22, 1, 'M'],
  ...CELL_X.map((x): PixelBox => [x, 24, 4, 14, 'D']),
  [54, 20, 1, 1, 'g'], [81, 20, 1, 1, 'g'], [54, 43, 1, 1, 'g'], [81, 43, 1, 1, 'g'],
  // Coolant tank, fed from the core, and cooling fins.
  [84, 30, 3, 2, 'm'], [86, 16, 12, 2, 'M'], [87, 17, 10, 30, 'k'], [88, 18, 8, 28, 'G'], [89, 19, 6, 26, 'k'], [86, 46, 12, 2, 'M'],
  [97, 30, 2, 2, 'm'], [99, 18, 7, 29, 'D'],
  [50, 49, 57, 7, 'k'],
  ...[0, 1, 2, 3, 4, 5, 6].map((i): PixelBox => [99, 19 + i * 4, 7, 2, 'g']),
  // Engineering bay: open standing room for scratch crew, with a wall terminal and tool board.
  [110, 14, 30, 46, 'k'], [111, 15, 28, 44, 'F'], [111, 15, 28, 2, 'D'],
  [114, 19, 14, 11, 'k'], [115, 20, 12, 8, 'D'], [120, 30, 2, 3, 'M'],
  [131, 23, 6, 13, 'k'], [132, 24, 4, 11, 'G'], [133, 26, 2, 1, 'g'], [133, 30, 2, 1, 'g'],
  [111, 56, 28, 3, 'D'], ...[0, 1, 2, 3, 4, 5].map((i): PixelBox => [113 + i * 4, 57, 2, 1, 'k']),
  // Status plate along the bottom edge.
  [4, 63, 136, 10, 'k'], [5, 64, 134, 8, 'D'],
]);

/** Where the map draws each light, in deck pixels. */
export const ENGINEERING_SPOTS = {
  /** Rack LEDs from the bottom row up, alternating racks so both fill together (CPU load). */
  leds: Array.from({ length: RACK_ROWS * 2 }, (_, k) => ({ x: RACK_X[k % 2] + 10, y: 21 + (RACK_ROWS - 1 - Math.floor(k / 2)) * 5 + 1, w: 2, h: 1 })),
  /** Core cell windows (observed crew activity). */
  cells: CELL_X.map((x) => ({ x: x + 1, y: 25, w: 2, h: 12 })),
  /** Coolant glass, filled bottom-up (RAM used). */
  coolant: { x: 89, y: 19, w: 6, h: 26 },
  /** Readout label anchors: CPU under the racks, RAM under the core. */
  cpuLabel: { x: 7, y: 50 },
  memoryLabel: { x: 52, y: 50 },
  /** Status plate; matches the layout's node plate. */
  plate: { x: 4, y: 63, w: 136, h: 10 },
  /** Engineering bay floor space; matches the layout's bay. */
  bay: { x: 111, y: 15, w: 28, h: 44 },
  /** Above the tool board, where the bay counts scratch crew it has no room for. */
  bayCount: { x: 130, y: 17 },
  /** The bay's wall terminal screen (lit while scratch crew work). */
  bayScreen: { x: 115, y: 20, w: 12, h: 8 },
  /** Inside the core housing's window; static when the machine is unreachable. */
  coreScreen: { x: 57, y: 23, w: 22, h: 16 },
  /** Cooling fins beside the coolant tank (lit in turn, faster with CPU load). */
  fins: { x: 99, y: 19, w: 7, h: 2, pitch: 4, count: 7 },
  /** Plating strip above the status plate; hazard-striped when the disk is nearly full. */
  hazard: { x: 5, y: 60, w: 134, h: 3 },
};

export const FLIGHT_KIT = { ...S, CONSOLE, TERMINAL, FILES, COMMS, CHAIR, ENGINEERING_DECK };

/** Suit mass is in the torso; headgear is compact, shoulders carry the team patch. */
export function flightCrew(silhouette: Silhouette, tier: Tier, legs: Legs = 'idle', arms: Arms = 'idle', look: Head = ''): Grid {
  // Claude ('round'): a bubble helmet with a wide, curved visor. Codex ('angular'): a squared
  // helmet with a narrow visor slit and a crest. Readable apart at one screen pixel per art pixel.
  // The visor's glint sits at its upper-left end, where the light comes from.
  const head = silhouette === 'round'
    ? panel(16, 22, [[6, 2, 4, 1, 'k'], [4, 3, 8, 1, 'k'], [3, 4, 10, 5, 'k'], [4, 9, 8, 1, 'k'],
      [5, 3, 6, 1, 'W'], [4, 4, 8, 5, 'W'], [5, 3, 3, 1, 'w'], [4, 4, 1, 2, 'w'],
      [6, 5, 7, 3, 'k'], [7, 5, 5, 1, 'V'], [7, 6, 5, 1, 'V'], [7, 5, 1, 1, 'v'], [8, 8, 4, 1, 's'], [11, 4, 1, 1, 's']])
    : panel(16, 22, [[7, 1, 3, 2, 'k'], [8, 1, 1, 1, 'T'], [3, 3, 10, 7, 'k'], [4, 4, 8, 5, 'W'], [4, 4, 8, 1, 'w'],
      [5, 6, 9, 2, 'k'], [6, 6, 7, 1, 'V'], [6, 6, 1, 1, 'v'], [9, 8, 3, 1, 's'], [11, 4, 1, 2, 's']]);
  if (legs === 'behind') return flightCrewBehind(silhouette, tier, arms, look);
  // The torso is suit, not outline: one outline row under the helmet, a 6-px chest lit from the
  // upper left and shaded on the right, and a 1-px team stripe; the team colour's main home is
  // the shoulder patches.
  const body = panel(16, 22, [[3, 10, 10, 7, 'k'], [4, 10, 8, 6, 'W'], [4, 10, 4, 1, 'w'], [4, 11, 1, 3, 'w'],
    [11, 10, 1, 6, 's'], [5, 15, 6, 1, 's'], [6, 13, 4, 1, 'T']]);
  const shoulders = tier === 'heavy'
    ? panel(16, 22, [[0, 9, 5, 5, 'k'], [1, 10, 3, 3, 'T'], [1, 10, 3, 1, 'h'], [11, 9, 5, 5, 'k'], [12, 10, 3, 3, 't']])
    : tier === 'light'
      ? panel(16, 22, [[5, 11, 2, 1, 'T'], [9, 11, 2, 1, 't']])
      : panel(16, 22, [[1, 10, 4, 4, 'k'], [2, 11, 2, 2, 'T'], [11, 10, 4, 4, 'k'], [12, 11, 2, 2, 't']]);
  const pack = tier === 'heavy' ? S.PACK_HEAVY : tier === 'light' ? S.PACK_LIGHT : S.PACK_STANDARD;
  const feet = legs === 'walkA' ? S.LEGS_WALK_A : legs === 'walkB' ? S.LEGS_WALK_B : legs === 'walkC' ? S.LEGS_WALK_C : legs === 'sit' ? S.LEGS_SIT : S.LEGS_IDLE;
  const hands = arms === 'typeA' ? S.ARMS_TYPE_A : arms === 'typeB' ? S.ARMS_TYPE_B : S.ARMS_IDLE;
  return compose(pack, feet, body, shoulders, head, hands, ...(tier === 'reviewer' ? [S.SCANNER] : []));
}

/**
 * Seated at a console, seen from behind: the back of the helmet, shoulder patches, the pack, the
 * arms and the chair back. The console's screen stays in view above the head. Poses: elbows
 * working as they type, a hand raised (waving) while they wait on you, leaning back with hands
 * behind the head, and the head glancing left or right or bowed.
 */
function flightCrewBehind(silhouette: Silhouette, tier: Tier, arms: Arms, head: Head): Grid {
  const dx = head === 'left' ? -1 : head === 'right' ? 1 : 0;
  const dy = head === 'down' ? 1 : 0;
  const shift = (boxes: PixelBox[]): PixelBox[] => boxes.map(([x, y, w, h, c]) => [x + dx, y + dy, w, h, c]);
  const helmet = silhouette === 'round'
    ? panel(16, 22, shift([[6, 2, 4, 1, 'k'], [4, 3, 8, 1, 'k'], [3, 4, 10, 5, 'k'], [4, 9, 8, 1, 'k'],
      [5, 3, 6, 1, 'W'], [4, 4, 8, 5, 'W'], [5, 3, 3, 1, 'w'], [4, 4, 1, 3, 'w'], [11, 4, 1, 5, 's'], [8, 8, 3, 1, 's']]))
    : panel(16, 22, shift([[7, 1, 3, 2, 'k'], [8, 1, 1, 1, 'T'], [3, 3, 10, 7, 'k'], [4, 4, 8, 5, 'W'], [4, 4, 8, 1, 'w'],
      [4, 5, 1, 3, 'w'], [11, 4, 1, 5, 's'], [9, 8, 2, 1, 's']]));
  // Tiers read apart by mass from behind: light crew have a narrow back and a slim pack; heavy
  // crew a deep pack that reaches the chair; standard and reviewer sit between.
  const torso: PixelBox[] = tier === 'light'
    ? [[3, 10, 10, 5, 'k'], [4, 10, 8, 4, 'W'], [4, 10, 3, 1, 'w'], [11, 10, 1, 4, 's'],
      [6, 10, 4, 4, 'k'], [7, 11, 2, 2, 'G'], [7, 11, 2, 1, 'g']]
    : [[2, 10, 12, 5, 'k'], [3, 10, 10, 4, 'W'], [3, 10, 3, 1, 'w'], [12, 10, 1, 4, 's'],
      ...(tier === 'heavy'
        ? [[5, 10, 6, 6, 'k'], [6, 11, 4, 4, 'G'], [6, 11, 4, 1, 'g'], [6, 13, 4, 1, 'k']] as PixelBox[]
        : [[5, 10, 6, 4, 'k'], [6, 11, 4, 2, 'G'], [6, 11, 4, 1, 'g']] as PixelBox[])];
  const back = panel(16, 22, [
    ...torso,
    // Chair back.
    [3, 15, 10, 5, 'k'], [4, 16, 8, 3, 'G'], [4, 16, 8, 1, 'g'],
    ...(tier === 'heavy' ? [[5, 15, 6, 1, 'k'], [6, 15, 4, 1, 'G']] as PixelBox[] : []),
  ]);
  const limbs: PixelBox[] = arms === 'typeA' || arms === 'typeB'
    // Typing: one elbow up while the other is down, swapping each beat.
    ? [[0, arms === 'typeB' ? 11 : 13, 2, 2, 'k'], [1, arms === 'typeB' ? 11 : 13, 1, 1, 'W'], [14, arms === 'typeA' ? 11 : 13, 2, 2, 'k'], [14, arms === 'typeA' ? 11 : 13, 1, 1, 'W']]
    : arms === 'raise' || arms === 'raiseB'
      // A hand up beside the helmet, waving a pixel higher every other beat.
      ? [[0, 13, 2, 2, 'k'], [13, arms === 'raiseB' ? 2 : 3, 3, 10, 'k'], [14, arms === 'raiseB' ? 3 : 4, 1, 8, 'W'], [14, arms === 'raiseB' ? 2 : 3, 1, 1, 'w']]
      : arms === 'relax'
        // Leaning back, hands behind the head: elbows out level with the helmet.
        ? [[0, 6, 4, 2, 'k'], [1, 6, 2, 1, 'W'], [12, 6, 4, 2, 'k'], [13, 6, 2, 1, 'W']]
        : [[0, 13, 2, 2, 'k'], [14, 13, 2, 2, 'k']];
  const patches = tier === 'heavy'
    ? panel(16, 22, [[0, 9, 4, 4, 'k'], [1, 10, 2, 2, 'T'], [12, 9, 4, 4, 'k'], [13, 10, 2, 2, 'T']])
    : tier === 'light'
      ? panel(16, 22, [[4, 11, 1, 1, 'T'], [11, 11, 1, 1, 'T']])
      : panel(16, 22, [[3, 11, 2, 2, 'T'], [11, 11, 2, 2, 'T']]);
  // Reviewers wear a scanner on the helmet's right: a 2×3 housing with a lit lens, above the
  // typing elbow so the hands never cover it.
  const scanner = panel(16, 22, shift([[12, 5, 3, 5, 'k'], [13, 6, 1, 3, 'm'], [13, 6, 1, 1, 'w']]));
  // Light crew's narrower back brings their arms in a pixel each side, so the hands stay attached.
  const arms2: PixelBox[] = tier === 'light' ? limbs.map(([x, y, w, h, c]) => [x < 3 ? x + 1 : x >= 12 ? x - 1 : x, y, w, h, c]) : limbs;
  return compose(back, patches, helmet, panel(16, 22, arms2), ...(tier === 'reviewer' ? [scanner] : []));
}
