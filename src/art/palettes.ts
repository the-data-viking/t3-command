// Candidate art styles. Each is a palette for the shared sprite codes (see sprites.ts) plus a few
// scene colors. Team (T/t), visor (V/v) and screen (S/x) colors are filled in per sprite.

export type StyleId = "kestrel" | "nightshift" | "pastel" | "signal" | "flightdeck" | "flightdeck-nightshift";

export interface Style {
  id: StyleId;
  name: string;
  blurb: string;
  colors: Record<string, number>;
  /** Space behind everything. */
  space: number;
  /** Interior walls between rooms. */
  wall: number;
}

const BASE_STYLES: Record<Exclude<StyleId, "flightdeck-nightshift">, Style> = {
  flightdeck: {
    id: "flightdeck", name: "Flight Deck",
    blurb: "FTL-inspired ship interiors: compact suited crew, broad wraparound consoles, inset displays and clearly separated system stations. Warm plating and restrained copper details.",
    space: 0x080d16, wall: 0x1a212a,
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
