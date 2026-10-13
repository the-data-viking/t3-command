// Candidate art styles. Each is a palette for the shared sprite codes (see sprites.ts) plus a few
// scene colors. Team (T/t), visor (V/v) and screen (S/x) colors are filled in per sprite.

export type StyleId = "kestrel" | "nightshift" | "pastel" | "signal" | "flightdeck" | "flightdeck-nightshift" | "highcontrast";

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
}

const BASE_STYLES: Record<Exclude<StyleId, "flightdeck-nightshift">, Style> = {
  flightdeck: {
    id: "flightdeck", name: "Flight Deck",
    blurb: "FTL-inspired ship interiors: compact suited crew, broad wraparound consoles, inset displays and clearly separated system stations. Warm plating and restrained copper details.",
    space: 0x080d16, wall: 0x1a212a,
    // Warm plating frames and charcoal wells, echoing the deck's ivory and copper.
    hud: {
      frame: 0xc9c1aa, ink: 0x14110d, surface: 0x1e1b17, deep: 0x100e0b, slot: 0x15130f,
      edge: 0x3a352c, edgeStrong: 0x4c4639, control: 0x2a261f, meter: 0x35302a, bright: 0xf6eedc,
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
    name: "Signal Workshop",
    blurb: "An orbital repair atelier: ceramic pods, copper service spines, ink-blue decks and goggled technicians. New silhouettes and fixtures, not just a palette swap.",
    space: 0x0b1423,
    wall: 0x101c2a,
    // Ceramic frames around ink-blue wells.
    hud: {
      frame: 0xe1d5b9, ink: 0x101c2a, surface: 0x112032, deep: 0x0a1422, slot: 0x0e1a2a,
      edge: 0x2a3d52, edgeStrong: 0x3a5068, control: 0x1a2b3f, meter: 0x2a3a4c, bright: 0xf9edcd,
    },
    colors: {
      k: 0x101c2a, w: 0xf9edcd, W: 0xe1d5b9, s: 0x9daba9,
      G: 0x33485b, g: 0x627d8b, h: 0xf0dfb9, H: 0xc3bfa7, D: 0x788c92,
      m: 0xd4a07a, M: 0x956e59, f: 0x647985, F: 0x526573,
      p: 0x2d4659, P: 0x23384a, q: 0x958474, Q: 0x7b6a5f,
      a: 0xf0a33a, r: 0xff4655, n: 0x5dff9a, c: 0x59e1ff, b: 0x486986,
    },
  },
  kestrel: {
    id: "kestrel",
    name: "Kestrel",
    blurb: "Closest to FTL: warm gray hulls, beige deck plating, chunky dark outlines.",
    space: 0x07090e,
    wall: 0x1a1c20,
    // Gunmetal frames around charcoal wells.
    hud: {
      frame: 0xb3bbc2, ink: 0x16181b, surface: 0x1c1f23, deep: 0x0e1013, slot: 0x15171a,
      edge: 0x33383e, edgeStrong: 0x454b52, control: 0x262a2f, meter: 0x30353b, bright: 0xf4f6f8,
    },
    colors: {
      k: 0x16181b,
      w: 0xf4f6f8,
      W: 0xd9dee4,
      s: 0xa3acb6,
      G: 0x4d5560,
      g: 0x6f7984,
      h: 0xb3bbc2,
      H: 0x86909a,
      D: 0x58616b,
      m: 0xa3acb5,
      M: 0x606a75,
      f: 0xcbc5b5,
      F: 0xaba592,
      p: 0x9daab2,
      P: 0x82929c,
      q: 0xd3c3a5,
      Q: 0xb8a88a,
      a: 0xf0a33a,
      r: 0xe8473f,
      n: 0x5fe06a,
      c: 0x7fd8f0,
      b: 0x4a78a8,
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
    space: 0x1b1530,
    wall: 0x4a3a52,
    // Cream frames around plum wells.
    hud: {
      frame: 0xe8d4c1, ink: 0x3a2e3f, surface: 0x241c38, deep: 0x150f24, slot: 0x1d1630,
      edge: 0x43365a, edgeStrong: 0x56466f, control: 0x2e2445, meter: 0x3a2f52, bright: 0xffffff,
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
    blurb: "Flight Deck crew and wraparound workstations in Night Shift’s dark industrial palette, with amber and cyan accents.",
  },
};
