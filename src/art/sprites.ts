// Hand-authored pixel art. Every sprite is a grid of palette codes; `render.ts` turns grids into
// textures and fills in per-crew colors (team, visor) at runtime, so one design covers every
// machine × provider × tier combination.
//
// Palette codes (resolved by the active style, see palettes.ts):
//   .  transparent          k  outline
//   w  suit highlight       W  suit            s  suit shadow
//   G  gear dark            g  gear mid
//   T  team color           t  team shade      (per crew member)
//   V  visor                v  visor glint     (per provider)
//   S  screen               x  screen text     (per state)
//   h  hull light   H  hull   D  hull dark
//   m  metal light  M  metal dark
//   f  floor        F  floor seam
//   p/P bridge deck/seam   q/Q quarters deck/seam
//   a  amber light  r  red light   n  green light   c  cyan glow
//   b  book/data blue

export type Grid = readonly string[];

/** Crew are composed from layers on a shared 16×22 canvas, facing right. */
export const CREW_W = 16;
export const CREW_H = 22;

const _ = "................";
const rows = (top: number, lines: string[], total = CREW_H): Grid => {
  const out = Array.from({ length: total }, () => _);
  lines.forEach((line, i) => (out[top + i] = line));
  return out;
};

// ---- Helmets (by provider silhouette) --------------------------------------------------

// ---- Bodies (by model tier) ------------------------------------------------------------

// ---- Packs and tier extras --------------------------------------------------------------

/** On the back, below the shoulder pad: a 2×3 block, lit on top. */
export const PACK_STANDARD = rows(12, [
  ".kkk............",
  ".kgk............",
  ".kGk............",
  ".kGk............",
  ".kkk............",
]);

export const PACK_HEAVY = rows(4, [
  ".m..............",
  ".k..............",
  ".k..............",
  ".k..............",
  ".k..............",
  ".k..............",
  ".k..............",
  "kkkk............",
  "kGGk............",
  "kGgk............",
  "kGGk............",
  "kkkk............",
]);

export const PACK_LIGHT = rows(13, ["..kk............", "..km............"]);

/** Inspector (review model) scanner, held up to the visor. */
export const SCANNER = rows(9, [
  "..............kk",
  ".............kmk",
  "..............kk",
]);

// ---- Legs (animation) ------------------------------------------------------------------

export const LEGS_IDLE = rows(17, [
  "....kssk.kssk...",
  "....kssk.kssk...",
  "....kkkk.kkkk...",
]);

/** Seated at a console: thighs forward, shins down to the chair's footrest. */
export const LEGS_SIT = rows(17, [
  "....kssssssk....",
  "....kkkkkssk....",
  ".........kkk....",
]);

/** Stride, left leg forward: the far (right) leg is in shadow, so the two strides read apart. */
export const LEGS_WALK_A = rows(17, [
  "...kssk...kGGk..",
  "..kssk.....kGGk.",
  "..kkkk.....kkkk.",
]);

/** Stride, right leg forward (the walk's third frame). */
export const LEGS_WALK_C = rows(17, [
  "...kGGk...kssk..",
  "..kGGk.....kssk.",
  "..kkkk.....kkkk.",
]);

export const LEGS_WALK_B = rows(17, [
  ".....ksskssk....",
  ".....ksskssk....",
  ".....kkkkkkk....",
]);

// ---- Arms (animation) ------------------------------------------------------------------

export const ARMS_IDLE = rows(13, [
  "............kwk.",
  "............kWk.",
  "............ksk.",
  "............kk..",
]);

export const ARMS_TYPE_A = rows(13, [
  "............kWWk",
  "............kkwk",
  "..............k.",
]);

export const ARMS_TYPE_B = rows(13, [
  "............kWk.",
  "............kWWk",
  "............kkk.",
]);

// ---- Furniture and fixtures ------------------------------------------------------------

/** Console desk; S/x are the screen, colored by what its crew member is doing. */
export const CONSOLE: Grid = [
  "...kkkkkkkkkkkkkkkkkk...",
  "...kSSSSSSSSSSSSSSSSk...",
  "...kSxxxSxxSSxxxxSSSk...",
  "...kSSSSSSSSSSSSSSSSk...",
  "...kSxxSSxxxxSSxxSSSk...",
  "...kkkkkkkkkkkkkkkkkk...",
  "kkkkkkkkkkkkkkkkkkkkkkkk",
  "khhhhhhhhhhhhhhhhhhhhhhk",
  "kHHHHHHHHHHHHHHHHHHHHHHk",
  "kHHaHHrHHHHHHHHHHHHnHHHk",
  "kDDDDDDDDDDDDDDDDDDDDDDk",
  "kkkkkkkkkkkkkkkkkkkkkkkk",
];

export const CHAIR: Grid = [
  "..kkkkkk..",
  ".kMMMMMMk.",
  ".kMmmmmMk.",
  "kkkkkkkkkk",
  "...kMMk...",
  "..kkkkkk..",
];

export const TERMINAL: Grid = [
  "kkkkkkkkkkkkkkkk",
  "khhhhhhhhhhhhhhk",
  "khkkkkkkkkkkkkHk",
  "khknnnnnnnnnnkHk",
  "khknkkknnnnnnkHk",
  "khknnnkknnnnnkHk",
  "khknkkknnkkknkHk",
  "khknnnnnnnnnnkHk",
  "khkkkkkkkkkkkkHk",
  "kHHHHHHHHHHHHHHk",
  "kHmkmkmkmkmkmHHk",
  "kHkmkmkmkmkmkHHk",
  "kHHHHHHHHHHHHHHk",
  "kDDDDDDDDDDDDDDk",
  "kkkkkkkkkkkkkkkk",
];

export const FILES: Grid = [
  "kkkkkkkkkkkkkk",
  "khhhhhhhhhhhhk",
  "khkkkkkkkkkkHk",
  "khkmmmmmmmmkHk",
  "khkmmmkkmmmkHk",
  "khkkkkkkkkkkHk",
  "khkmmmmmmmmkHk",
  "khkmmmkkmmmkHk",
  "khkkkkkkkkkkHk",
  "khkmmmmmmmmkHk",
  "khkmmmkkmmmkHk",
  "khkkkkkkkkkkHk",
  "kDDDDDDDDDDDDk",
  "kkkkkkkkkkkkkk",
];

export const COMMS: Grid = [
  "........a.......",
  "...kkk..k..kkk..",
  "..khhhk.k.khhhk.",
  ".khhhhhkkkhhhhHk",
  ".khhhhhhhhhhhHHk",
  "..khhhhhhhhhHHk.",
  "...kkHHHHHHHkk..",
  ".....kkkkkkk....",
  ".......kHk......",
  ".......kHk......",
  "......kkHkk.....",
  ".....kDDDDDk....",
  "....kkkkkkkkk...",
];

export const BUNK_EMPTY: Grid = [
  "........................",
  "........................",
  "........................",
  "........................",
  "........................",
  "kkkk....................",
  "kMMk....................",
  "kMMkkkkkkkkkkkkkkkkkkkkk",
  "kMMkwwwkmmmmmmmmmmmmmmmk",
  "kMMkkkkkkkkkkkkkkkkkkkkk",
  "kMMMMMMMMMMMMMMMMMMMMMMk",
  "kkkkkkkkkkkkkkkkkkkkkkkk",
  ".kk..................kk.",
  "........................",
];

/** A settled crew member asleep, side on: helmet on the pillow, a team-coloured blanket over them. */
export const BUNK_SLEEPER: Grid = [
  "........................",
  "........................",
  "....kkkk................",
  "...kwWWWk...............",
  "...kwWVVk.....kkkkkk....",
  "kkkkWWVVkkkkkkTTTTTTkk..",
  "kMMkkWWkTTTTTTTTtTTTTTk.",
  "kMMkkkkkTtTtTtTtTtTtTtTk",
  "kMMkwwwkTTTTTTTTTTTTTTTk",
  "kMMkkkkkkkkkkkkkkkkkkkkk",
  "kMMMMMMMMMMMMMMMMMMMMMMk",
  "kkkkkkkkkkkkkkkkkkkkkkkk",
  ".kk..................kk.",
  "........................",
];

export const SHELF: Grid = [
  "kkkkkkkkkkkkkk",
  "kbkbkTkbkbkbMk",
  "kbkbkTkbkTkbMk",
  "kbkbkTkbkTkbMk",
  "kkkkkkkkkkkkkk",
  "kTkbkbkbkbkTMk",
  "kTkbkbkbkbkTMk",
  "kTkbkbkbkbkTMk",
  "kkkkkkkkkkkkkk",
];

export const FLOOR: Grid = [
  "FFFFFFFFFFFFFFFF",
  "Ffffffffffffffff",
  "FfFffffffffffFff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
  "FfFffffffffffFff",
  "Ffffffffffffffff",
  "Ffffffffffffffff",
];

/** Cool alloy bridge decking and warm acoustic quarters panels. No status colors. */
export const FLOOR_BRIDGE: Grid = FLOOR.map((row, y) => {
  const deck = row.replace(/f/g, "p").replace(/F/g, "P");
  return y === 7 || y === 8 ? "P" + "p".repeat(6) + "PP" + "p".repeat(7) : deck;
});
export const FLOOR_QUARTERS: Grid = Array.from({ length: 16 }, (_, y) =>
  y % 8 === 0 ? "Q".repeat(16) : (y < 8 ? "Q" + "q".repeat(15) : "q".repeat(8) + "Q" + "q".repeat(7)),
);

export const DOOR_H: Grid = ["kkkkkkkkkkkkkkkk", "kmmmmmmmkmmmmmmk", "kDDDDDDDkDDDDDDk", "kkkkkkkkkkkkkkkk"];
/** The same door with its panels sliding into the jambs as crew approach. */
export const DOOR_H_HALF: Grid = ["kkkkkffffffkkkkk", "kmmmkffffffkmmmk", "kDDDkffffffkDDDk", "kkkkkffffffkkkkk"];
export const DOOR_H_OPEN: Grid = ["kkffffffffffffkk", "kmffffffffffffmk", "kDffffffffffffDk", "kkffffffffffffkk"];

// ---- Status badges (9×9) ---------------------------------------------------------------
// Drawn in V, filled with the crew member's status colour (STATUS) when rasterized, so a badge is
// always the same colour as the HUD's pill for that state. Glyphs are solid white (or ink on yellow).

/** Approval: a ▲ with a "!", the same shape as its glyph in the fleet view and minimap. */
export const BADGE_ALERT: Grid = [
  "....k....",
  "...kVk...",
  "...kVk...",
  "..kVwVk..",
  "..kVwVk..",
  ".kVVwVVk.",
  ".kVVVVVk.",
  "kVVVwVVVk",
  "kkkkkkkkk",
];

/** Question: a ◆ with a dark "?" (bar, hook, stem; the bottom tip is the dot). */
export const BADGE_QUESTION: Grid = [
  "....k....",
  "...kVk...",
  "..kVVVk..",
  ".kVkkkVk.",
  "kVVVVkVVk",
  ".kVVkVVk.",
  "..kVVVk..",
  "...kkk...",
  "....k....",
];

/** Report ready: a round badge with a solid ✓. */
export const BADGE_DONE: Grid = [
  "...kkk...",
  ".kkVVVkk.",
  ".kVVVVwk.",
  "kVVVVwwVk",
  "kVwVwwVVk",
  "kVwwwVVVk",
  ".kVwVVVk.",
  ".kkVVVkk.",
  "...kkk...",
];

export const BADGE_ERROR: Grid = [
  "..kkkkk..",
  ".kVVVVVk.",
  "kVwVVVwVk",
  "kVVwVwVVk",
  "kVVVwVVVk",
  "kVVwVwVVk",
  "kVwVVVwVk",
  ".kVVVVVk.",
  "..kkkkk..",
];

/** Monitoring: a ring (○), open in the middle. */
export const BADGE_MONITOR: Grid = [
  "...kkk...",
  ".kkVVVkk.",
  ".kVkkkVk.",
  "kVk...kVk",
  "kVk...kVk",
  "kVk...kVk",
  ".kVkkkVk.",
  ".kkVVVkk.",
  "...kkk...",
];

/** All grids, for validation. */
export const ALL: Record<string, Grid> = {
  PACK_STANDARD,
  PACK_HEAVY,
  PACK_LIGHT,
  SCANNER,
  LEGS_IDLE,
  LEGS_WALK_A,
  LEGS_WALK_B,
  LEGS_WALK_C,
  ARMS_IDLE,
  ARMS_TYPE_A,
  ARMS_TYPE_B,
  CONSOLE,
  CHAIR,
  TERMINAL,
  FILES,
  COMMS,
  BUNK_EMPTY,
  BUNK_SLEEPER,
  SHELF,
  FLOOR,
  FLOOR_BRIDGE,
  FLOOR_QUARTERS,
  DOOR_H,
  DOOR_H_HALF,
  DOOR_H_OPEN,
  BADGE_ALERT,
  BADGE_QUESTION,
  BADGE_DONE,
  BADGE_ERROR,
  BADGE_MONITOR,
};
