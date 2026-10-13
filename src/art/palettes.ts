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
    blurb: "FTL's warm hull: ivory and stone plating with copper details, a brass-and-leather HUD, over warm space.",
    // Warm space: a brown-black void, so the ivory hull reads warm against it.
    space: 0x110d0b, wall: 0x1f1813,
    // Leather and brass: brass frames, oiled-leather panels and wells, cream text.
    hud: {
      frame: 0xd9b77a, ink: 0x1a120b, surface: 0x2a2018, deep: 0x18120d, slot: 0x211912,
      edge: 0x4a3a2a, edgeStrong: 0x6a5238, control: 0x3a2c1f, meter: 0x4a3a2a, bright: 0xfbf0d8,
      text: 0xf1e6d0, muted: 0xb9a88c,
      chrome: { corner: "bevel", radius: 6, width: 3 },
    },
    colors: {
      k: 0x19212a, w: 0xf6eedc, W: 0xd7d3c4, s: 0x919c9b,
      G: 0x44515c, g: 0x73818b, h: 0xd7d3bc, H: 0xadb3ad, D: 0x6c7b80,
      m: 0xb99a75, M: 0x756c61, f: 0xbcb8a5, F: 0x9f9d8b,
      p: 0x85999f, P: 0x6d838d, q: 0xb6a690, Q: 0x988875,
      a: 0xf0a33a, r: 0xff4655, n: 0x5dff9a, c: 0x59e1ff, b: 0x527589,
    },
  },
  signal: {
    id: "signal",
    name: "Signal",
    blurb: "A palette on the Flight Deck kit: ink-blue decks, ceramic plating and copper trim.",
    space: 0x0b1423,
    wall: 0x101c2a,
    // Ceramic frames around ink-blue wells.
    hud: {
      frame: 0xe1d5b9, ink: 0x101c2a, surface: 0x112032, deep: 0x0a1422, slot: 0x0e1a2a,
      edge: 0x2a3d52, edgeStrong: 0x3a5068, control: 0x1a2b3f, meter: 0x2a3a4c, bright: 0xf9edcd,
      chrome: { corner: "round", radius: 12, width: 2 },
    },
    colors: {
      k: 0x101c2a, w: 0xf9edcd, W: 0xe1d5b9, s: 0x9daba9,
      G: 0x33485b, g: 0x627d8b, h: 0xf0dfb9, H: 0xc3bfa7, D: 0x788c92,
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
    name: "Pastel Ops",
    blurb: "A cozier, brighter take: cream decks, soft plum outlines, candy accents.",
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
        cyan: 0x0d6890, amber: 0x8e3f86, hermes: 0x7a5a2e,
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
      f: 0xeee7d8,
      F: 0xd7ccb7,
      p: 0xc8dadd,
      P: 0xaabfc6,
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
    name: "High Contrast",
    blurb: "Black space and wells, white frames and text, light hulls with black outlines, dark floors so crew stand out.",
    space: 0x000000,
    wall: 0x000000,
    hud: {
      frame: 0xffffff, ink: 0x000000, surface: 0x000000, deep: 0x000000, slot: 0x0a0a0a,
      edge: 0x8a8a8a, edgeStrong: 0xd0d0d0, control: 0x1a1a1a, meter: 0x4a4a4a, bright: 0xffffff,
      text: 0xffffff, muted: 0xc8ced6,
      chrome: { corner: "square", radius: 0, width: 2 },
    },
    colors: {
      k: 0x000000, w: 0xffffff, W: 0xe8e8e8, s: 0xa8a8a8,
      G: 0x3c3c3c, g: 0x9a9a9a, h: 0xf0f0f0, H: 0xc8c8c8, D: 0x6a6a6a,
      m: 0xd8d8d8, M: 0x7a7a7a, f: 0x262a30, F: 0x101317,
      p: 0x1e2a36, P: 0x0e151c, q: 0x2e2620, Q: 0x16110d,
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
    name: "Flight Deck · Night Shift",
    blurb: "The default: dark industrial decks lit amber and cyan, in the spirit of StarNet.",
  },
};
