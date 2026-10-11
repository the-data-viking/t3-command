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

export const HELMET_ROUND = rows(2, [
  "......kkkk......",
  "....kkwwwwkk....",
  "...kwwwwwwwwk...",
  "..kwwwwwkkkkkk..",
  "..kwwwwkVVVVvVk.",
  "..kwwwwkVVVVVVk.",
  "..kswwwkVVVVVVk.",
  "..kswwwwkkkkkkk.",
  "...ksswwwwwwsk..",
  "....kkkTTkkkk...",
]);

export const HELMET_ANGULAR = rows(2, [
  "...kkkkkkkkkk...",
  "...kwwwwwwwwwk..",
  "...kwwwwwwwwwkk.",
  "...kkkkkkkkkkkk.",
  "...kVVVVVVVvVVk.",
  "...kVVVVVVVVVVk.",
  "...kkkkkkkkkkkk.",
  "...kswwwwwwwwsk.",
  "...ksssssssssk..",
  "....kkkTTkkkk...",
]);

// ---- Bodies (by model tier) ------------------------------------------------------------

export const BODY_STANDARD = rows(12, [
  "...kTTTTTTTTk...",
  "...kWWWWWWWWk...",
  "...kwWWWWWWsk...",
  "...kwWWWWWWsk...",
  "...kkkkkkkkkk...",
]);

export const BODY_HEAVY = rows(11, [
  "..kkkk....kkkk..",
  ".kTTTkkkkkkTTTk.",
  ".kTttkWWWWkttTk.",
  "..kkkwWWWWskkk..",
  "...kwWWWWWWsk...",
  "...kkkkkkkkkk...",
]);

export const BODY_LIGHT = rows(12, [
  "....kTTTTTTk....",
  "....kWWWWWWk....",
  "....kwWWWWsk....",
  "....kkkkkkkk....",
]);

// ---- Packs and tier extras --------------------------------------------------------------

export const PACK_STANDARD = rows(12, [
  ".kkk............",
  ".kGk............",
  ".kgk............",
  ".kkk............",
]);

export const PACK_HEAVY = rows(4, [
  ".a..............",
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

export const PACK_LIGHT = rows(13, ["..kk............", "..kc............"]);

/** Inspector (review model) scanner, held up to the visor. */
export const SCANNER = rows(9, [
  "..............kk",
  ".............kak",
  "..............kk",
]);

// ---- Legs (animation) ------------------------------------------------------------------

export const LEGS_IDLE = rows(17, [
  "....kssk.kssk...",
  "....kssk.kssk...",
  "....kkkk.kkkk...",
]);

export const LEGS_WALK_A = rows(17, [
  "...kssk...kssk..",
  "..kssk.....kssk.",
  "..kkkk.....kkkk.",
]);

export const LEGS_WALK_B = rows(17, [
  ".....ksskssk....",
  ".....ksskssk....",
  ".....kkkkkkk....",
]);

// ---- Arms (animation) ------------------------------------------------------------------

export const ARMS_IDLE = rows(13, [
  "............kWk.",
  "............kWk.",
  "............kwk.",
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
  "kkkkkkkkkkkkkkkkkkkkkkkk",
  "kMMMMMMMMMMMMMMMMMMMMMMk",
  "kMkkkkkkkkkkkkkkkkkkkkMk",
  "kMkwwwwkmmmmmmmmmmmmmkMk",
  "kMkwwwwkmmmmmmmmmmmmmkMk",
  "kMkkkkkkkkkkkkkkkkkkkkMk",
  "kMMMMMMMMMMMMMMMMMMMMMMk",
  "kkkkkkkkkkkkkkkkkkkkkkkk",
];

/** A settled crew member asleep: helmet on the pillow, team-colored blanket. */
export const BUNK_SLEEPER: Grid = [
  "kkkkkkkkkkkkkkkkkkkkkkkk",
  "kMMMMMMMMMMMMMMMMMMMMMMk",
  "kMkkkkkkkkkkkkkkkkkkkkMk",
  "kMkwkwwkkTTTTTTTTTTTTkMk",
  "kMkwkVVkkTtTtTtTtTtTtkMk",
  "kMkkkkkkkkkkkkkkkkkkkkMk",
  "kMMMMMMMMMMMMMMMMMMMMMMk",
  "kkkkkkkkkkkkkkkkkkkkkkkk",
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

export const DOOR_H: Grid = ["kkkkkkkkkkkkkkkk", "kaaaaaaakaaaaaak", "kDDDDDDDkDDDDDDk", "kkkkkkkkkkkkkkkk"];

/** One environment's ship: engine left, bow right, team stripe along the hull. */
export const SHIP: Grid = [
  "..........kkkkkkkkkkkkkkkkkkkkkkkkk...................",
  "........kkhhhhhhhhhhhhhhhhhhhhhhhhhkkkk...............",
  "......kkhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhkkkk...........",
  "kkkk.kHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHkkk........",
  "kDDkkHHHHkkkkkHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHkkk.....",
  "kDDDkHHHkaaaakHHHHHHHHHHHHHHHHHHHHHHHkkkkkkHHHHHHkk...",
  "kDDDkHHHkkkkkkHHHHHHHHHHHHHHHHHHHHHHkccccccckHHHHHHk..",
  "kDDDkTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTkcccccccckHHHHHHk.",
  "kDDDktttttttttttttttttttttttttttttttkcccccccckHHHHHHk.",
  "kDDDkHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHkccccccckHHHHHk..",
  "kDDkkDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDkkkkkkkDDDDkk...",
  "kkkk.kDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDkk.....",
  "......kkDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDkkk.......",
  "........kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk...........",
];

// ---- Status badges (9×9) ---------------------------------------------------------------

export const BADGE_ALERT: Grid = [
  "....k....",
  "...krk...",
  "..krwrk..",
  ".krrwrrk.",
  "krrrwrrrk",
  ".krrrrrk.",
  "..krwrk..",
  "...krk...",
  "....k....",
];

export const BADGE_QUESTION: Grid = [
  "..kkkkk..",
  ".kaaaaak.",
  "kaakkkaak",
  "kaaaakaak",
  "kaaakaaak",
  "kaaakaaak",
  "kaaaaaaak",
  ".kaakaak.",
  "..kkkkk..",
];

export const BADGE_DONE: Grid = [
  "..kkkkk..",
  ".knnnnnk.",
  "knnnnnkkk",
  "knnnnkwkk",
  "kkknkwknk",
  "kkwkwknnk",
  "knkwknnnk",
  ".knnnnnk.",
  "..kkkkk..",
];

export const BADGE_ERROR: Grid = [
  "..kkkkk..",
  ".krrrrrk.",
  "krwkrkwrk",
  "krkwkwkrk",
  "krrkwkrrk",
  "krkwkwkrk",
  "krwkrkwrk",
  ".krrrrrk.",
  "..kkkkk..",
];

export const BADGE_MONITOR: Grid = [
  "..kkkkk..",
  ".kVVVVVk.",
  "kVkkkkkVk",
  "kVkkkVkVk",
  "kVkkVkkVk",
  "kVkkkkkVk",
  "kVVkkkVVk",
  ".kVVVVVk.",
  "..kkkkk..",
];

/** All grids, for validation. */
export const ALL: Record<string, Grid> = {
  HELMET_ROUND,
  HELMET_ANGULAR,
  BODY_STANDARD,
  BODY_HEAVY,
  BODY_LIGHT,
  PACK_STANDARD,
  PACK_HEAVY,
  PACK_LIGHT,
  SCANNER,
  LEGS_IDLE,
  LEGS_WALK_A,
  LEGS_WALK_B,
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
  SHIP,
  BADGE_ALERT,
  BADGE_QUESTION,
  BADGE_DONE,
  BADGE_ERROR,
  BADGE_MONITOR,
};
