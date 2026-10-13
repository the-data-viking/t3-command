// Candidate art styles. Each is a palette for the shared sprite codes (see sprites.ts) plus a few
// scene colors. Team (T/t), visor (V/v) and screen (S/x) colors are filled in per sprite.

export type StyleId = "nightshift" | "pastel" | "signal" | "flightdeck" | "flightdeck-nightshift" | "highcontrast";

export interface Style {
  id: StyleId;
  name: string;
  blurb: string;
  colors: Record<string, number>;
  /** Space behind everything. */
  space: number;
  /** Interior walls between rooms. */
  wall: number;
  /** Materials for the HUD chrome around the map; styles without one use Night Shift's. */
  hud?: HudMaterials;
  /** Map label text and lines (drawn over space or dark plating); defaults are the HUD's dark-theme text. */
  mapInk?: { text: number; muted: number; line?: number };
}

/**
 * FTL-style chrome: bevelled frames with title tabs around dark inset wells. These are
 * materials only — status, accent and gauge colors keep their meaning across styles.
 */
export interface HudMaterials {
  /** Bevelled frame, title tabs and secondary headings. */
  frame: number;
  /** Outline around frames, and text on frame-colored tabs. */
  ink: number;
  /** Panel body (drawn slightly translucent). */
  surface: number;
  /** Deepest backgrounds: modals, dropdown lists. */
  deep: number;
  /** Inset wells: transcripts, chips, roster rows. */
  slot: number;
  /** Well borders. */
  edge: number;
  /** Chip borders and dividers that need more contrast. */
  edgeStrong: number;
  /** Button face and portrait backdrops. */
  control: number;
  /** Empty meter segments. */
  meter: number;
  /** Brightest text: button labels, logo, selected tabs. */
  bright: number;
  /** Body and secondary text, where a style needs more contrast than the shared defaults. */
  text?: number;
  muted?: number;
  /** A light HUD (dark text on pale panels). Status colours are deepened to stay readable. */
  light?: boolean;
  /** Frame shape: bevelled (FTL), rounded (ceramic, soft) or square; corner size and frame weight. */
  chrome?: { corner: "bevel" | "round" | "square"; radius: number; width: number };
  /** Dark plating for map structures drawn from HUD materials (Hermes hall, operations hub). */
  plating?: { surface: number; slot: number; edge: number; edgeStrong: number; control: number };
  /**
   * Hand-tuned HUD colours (status, gauges, accents) by token name, replacing the computed ones.
   * Light HUDs set these so status reads as itself on cream, not as a muddied version.
   */
  tokens?: Record<string, number>;
}

const BASE_STYLES: Record<Exclude<StyleId, "flightdeck-nightshift">, Style> = {
  flightdeck: {
    id: "flightdeck", name: "Kestrel",
    mapInk: { text: 0xf1e6d0, muted: 0xb9a88c },
    blurb: "FTL's warm hull over an amber desert world: ivory plating, walnut decks, a ringed giant overhead.",
    // Warm space: a brown-black void, so the ivory hull reads warm against it.
    space: 0x110d0b, wall: 0x1f1813,
    // Leather and bronze: bronze frames (well clear of Hermes tan), oiled-leather panels, cream text.
    hud: {
      frame: 0xc28e52, ink: 0x1a120b, surface: 0x2a2018, deep: 0x18120d, slot: 0x211912,
      edge: 0x4a3a2a, edgeStrong: 0x6a5238, control: 0x3a2c1f, meter: 0x4a3a2a, bright: 0xfbf0d8,
      text: 0xf1e6d0, muted: 0xb9a88c,
      chrome: { corner: "bevel", radius: 6, width: 3 },
    },
    colors: {
      k: 0x19212a, w: 0xf6eedc, W: 0xd7d3c4, s: 0x919c9b,
      G: 0x44515c, g: 0x73818b, h: 0xd7d3bc, H: 0xadb3ad, D: 0x6c7b80,
      // Walnut decks: dark enough that status lights and white suits read on them (the old pale
      // decks held statuses at 1–2:1 and made Kestrel look like Pastel).
      m: 0xb99a75, M: 0x756c61, f: 0x3b342c, F: 0x2f2a24,
      p: 0x313c41, P: 0x283135, q: 0x4a3d32, Q: 0x3b3128,
      a: 0xf0a33a, r: 0xff4655, n: 0x5dff9a, c: 0x59e1ff, b: 0x527589,
    },
  },
  signal: {
    id: "signal",
    name: "Day Shift",
    blurb: "Night Shift by day: the same station in sunlight, porcelain hulls under a cool slate-and-white HUD.",
    space: 0x0b1423,
    wall: 0x101c2a,
    // The cool light HUD, counterpart to Pastel's warm one: slate frames on pale panels.
    hud: {
      frame: 0x2a3540, ink: 0xf3f6f8, surface: 0xe9eef1, deep: 0xdde4e9, slot: 0xf7f9fa,
      edge: 0xc3ced6, edgeStrong: 0x9aabb8, control: 0xdfe6eb, meter: 0xcfd8df, bright: 0x0f1d2a,
      text: 0x1d2b38, muted: 0x4f6070, light: true,
      chrome: { corner: "round", radius: 12, width: 2 },
      plating: { surface: 0x112032, slot: 0x0e1a2a, edge: 0x2a3d52, edgeStrong: 0x3a5068, control: 0x1a2b3f },
      // Status on pale slate, each at least 4.5:1 on every panel and well apart from each other.
      tokens: {
        alert: 0xb3243a, question: 0x765300, working: 0x0b6589, monitoring: 0x6a43b8, error: 0x9a3e0b,
        done: 0x166b3d, idle: 0x56606d, sleeping: 0x5a6272,
        "gauge-ok": 0x166b3d, "gauge-high": 0x855300, "gauge-critical": 0x9c2486, hermes: 0x6e5a48,
      },
    },
    colors: {
      k: 0x101c2a, w: 0xf9edcd, W: 0xe1d5b9, s: 0x9daba9,
      // Porcelain hull (cool white-blue), well clear of Hermes tan.
      G: 0x33485b, g: 0x627d8b, h: 0xe3ebf0, H: 0xc6d4dc, D: 0x8a9ba6,
      m: 0xd4a07a, M: 0x956e59, f: 0x3a4b5a, F: 0x2f3e4b,
      p: 0x2d4659, P: 0x23384a, q: 0x958474, Q: 0x7b6a5f,
      a: 0xf0a33a, r: 0xff4655, n: 0x5dff9a, c: 0x59e1ff, b: 0x486986,
    },
  },
  nightshift: {
    id: "nightshift",
    name: "Night Shift",
    blurb: "Dark industrial decks with amber and cyan light, in the spirit of StarNet.",
    space: 0x040508,
    wall: 0x08090c,
    // Cool gray FTL frames around near-black wells.
    hud: {
      frame: 0xaeb7be, ink: 0x0d1114, surface: 0x161b20, deep: 0x080b10, slot: 0x11161a,
      edge: 0x2c343b, edgeStrong: 0x3a444d, control: 0x20272d, meter: 0x2a3036, bright: 0xeef2f5,
      chrome: { corner: "bevel", radius: 8, width: 3 },
    },
    colors: {
      k: 0x0a0c0f,
      w: 0xe9edf1,
      W: 0xc6ced7,
      s: 0x8c97a3,
      G: 0x3a414a,
      g: 0x59626d,
      h: 0x5b646f,
      H: 0x3d454f,
      D: 0x272d34,
      m: 0x56606b,
      M: 0x323941,
      f: 0x2c323a,
      F: 0x20252b,
      p: 0x303e49,
      P: 0x25313b,
      q: 0x403a35,
      Q: 0x2e2926,
      a: 0xf0a33a,
      r: 0xff4655,
      n: 0x3dff8a,
      c: 0x59e1ff,
      b: 0x2f6f9f,
    },
  },
  pastel: {
    id: "pastel",
    mapInk: { text: 0xf6efe4, muted: 0xc9b8d4 },
    name: "Pastel Ops",
    blurb: "Cozy candy ops at dusk: a cream HUD, soft plum outlines, a big pale moon.",
    space: 0x2a2140,
    wall: 0x4a3a52,
    // A light HUD to match the cream decks: plum frames around cream panels, plum ink.
    hud: {
      frame: 0x5a4566, ink: 0xfaf3e8, surface: 0xf6efe4, deep: 0xeee4d6, slot: 0xfffaf2,
      edge: 0xd9c9b8, edgeStrong: 0xb7a392, control: 0xefe3d4, meter: 0xe2d4c4, bright: 0x2b2034,
      text: 0x3a2e3f, muted: 0x6b5d73, light: true,
      chrome: { corner: "round", radius: 14, width: 3 },
      plating: { surface: 0x3a2a48, slot: 0x2f2240, edge: 0x5a4470, edgeStrong: 0x6e5788, control: 0x44325a },
      // Status on cream, each at least 4.5:1 on every panel; a plum accent instead of a muddied amber.
      tokens: {
        alert: 0xb8263a, question: 0x7a5600, working: 0x0d6890, monitoring: 0x7046c0, error: 0xa0420c,
        done: 0x1a7240, idle: 0x5f6675, sleeping: 0x635a74,
        "gauge-ok": 0x1a7240, "gauge-high": 0x8a5600, "gauge-critical": 0xa8288f,
        hermes: 0x6e5a48,
      },
    },
    colors: {
      k: 0x3a2e3f,
      w: 0xffffff,
      W: 0xf1ece6,
      s: 0xcdc3ba,
      G: 0x8a7f96,
      g: 0xb1a6bc,
      h: 0xf6ecdf,
      H: 0xdcc8b4,
      D: 0xae957f,
      m: 0xcad7db,
      M: 0x92a7ae,
      f: 0xd8cdbd,
      F: 0xc3b6a2,
      p: 0xb0c3c9,
      P: 0x97abb3,
      q: 0xe8d4c1,
      Q: 0xcdb5a4,
      a: 0xffb35c,
      r: 0xff6b7a,
      n: 0x7ee0a1,
      c: 0x8fe6ff,
      b: 0x7d8fd9,
    },
  },
  highcontrast: {
    id: "highcontrast",
    mapInk: { text: 0xffffff, muted: 0xc8ced6, line: 0xd0d0d0 },
    name: "High Contrast",
    blurb: "Maximum legibility: black wells, white frames and text, light hulls on the darkest decks.",
    space: 0x000000,
    wall: 0x000000,
    hud: {
      frame: 0xffffff, ink: 0x000000, surface: 0x000000, deep: 0x000000, slot: 0x0a0a0a,
      edge: 0x8a8a8a, edgeStrong: 0xd0d0d0, control: 0x1a1a1a, meter: 0x4a4a4a, bright: 0xffffff,
      text: 0xffffff, muted: 0xc8ced6,
      chrome: { corner: "square", radius: 0, width: 2 },
      // "Asleep" lifted to 5.7:1 on black (the shared slate is 2.7:1); a grey RAM line beside white CPU.
      tokens: { sleeping: 0x7d8597, "chart-ram": 0x8a8a8a },
    },
    colors: {
      k: 0x000000, w: 0xffffff, W: 0xe8e8e8, s: 0xa8a8a8,
      G: 0x3c3c3c, g: 0x9a9a9a, h: 0xf0f0f0, H: 0xc8c8c8, D: 0x6a6a6a,
      m: 0xd8d8d8, M: 0x7a7a7a, f: 0x1a1d22, F: 0x101317,
      p: 0x141c25, P: 0x0e151c, q: 0x2e2620, Q: 0x16110d,
      a: 0xffb000, r: 0xff3b4d, n: 0x3dff8a, c: 0x40e0ff, b: 0x3f8fff,
    },
  },
};

// Reuse Night Shift's exact materials with Flight Deck's geometry on the review board.
export const STYLES: Record<StyleId, Style> = {
  ...BASE_STYLES,
  "flightdeck-nightshift": {
    ...BASE_STYLES.nightshift,
    id: "flightdeck-nightshift",
    name: "Night Shift",
    blurb: "The default: a graveyard-shift engineering bay under a crescent moon, graphite decks, cool grey frames.",
  },
};
