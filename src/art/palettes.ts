// Candidate art styles. Each is a palette for the shared sprite codes (see sprites.ts) plus a few
// scene colors. Team (T/t), visor (V/v) and screen (S/x) colors are filled in per sprite.

export type StyleId = "kestrel" | "nightshift" | "pastel";

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

export const STYLES: Record<StyleId, Style> = {
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
      a: 0xffb35c,
      r: 0xff6b7a,
      n: 0x7ee0a1,
      c: 0x8fe6ff,
      b: 0x7d8fd9,
    },
  },
};
