// Map labels in the 5×7 pixel font. One atlas holds every glyph in white with a one-pixel black
// outline; a label is a row of glyph sprites tinted to its color, scaled in whole font pixels.

import { Container, Rectangle, Sprite, Texture } from "pixi.js";
import { ADVANCE, cells, GLYPH_H, GLYPH_W, GLYPHS, glyphFor } from "../art/pixelfont";

const CELL_W = GLYPH_W + 2;
const CELL_H = GLYPH_H + 2;
let atlas: Map<string, Texture> | undefined;

function glyphTexture(rows: string[]): Texture {
  if (!atlas) {
    const keys = Object.keys(GLYPHS);
    const canvas = document.createElement("canvas");
    canvas.width = CELL_W * keys.length;
    canvas.height = CELL_H;
    const ctx = canvas.getContext("2d")!;
    keys.forEach((key, i) => {
      const filled = cells(GLYPHS[key]);
      ctx.fillStyle = "#000";
      for (const [x, y] of filled) ctx.fillRect(i * CELL_W + x, y, 3, 3); // outline: the 3×3 around each pixel
      ctx.fillStyle = "#fff";
      for (const [x, y] of filled) ctx.fillRect(i * CELL_W + x + 1, y + 1, 1, 1);
    });
    const source = Texture.from(canvas).source;
    source.scaleMode = "nearest";
    atlas = new Map(keys.map((key, i) => [GLYPHS[key].join("/"), new Texture({ source, frame: new Rectangle(i * CELL_W, 0, CELL_W, CELL_H) })]));
  }
  return atlas.get(rows.join("/"))!;
}

/** Font pixels per world pixel for a nominal size, so sizes roughly match the old vector labels. */
export function fontScale(size: number): number {
  return Math.max(1, Math.round(size * 0.72 / GLYPH_H));
}

export class PixelText extends Container {
  /** Every live label, so the map can snap them to whole screen pixels each frame. */
  static readonly live = new Set<PixelText>();
  private value = "";
  /** Anchor pivot in local units; `snapToPixels` nudges the real pivot from it. */
  private basePivot = { x: 0, y: 0 };
  private color: number;
  /** World pixels per font pixel at scale 1. */
  readonly unit: number;
  private ax = 0;
  private ay = 0;
  /** Same shape as Pixi's ObservablePoint setter, so call sites read like Text. */
  readonly anchor = { set: (x: number, y = x) => { this.ax = x; this.ay = y; this.layout(); } };

  constructor(size: number, color: number) {
    super();
    this.unit = fontScale(size);
    this.color = color;
    PixelText.live.add(this);
  }

  override destroy(options?: Parameters<Container["destroy"]>[0]): void {
    PixelText.live.delete(this);
    super.destroy(options);
  }

  /**
   * Put the label's origin on a whole screen pixel. A half-pixel origin makes pixel rounding
   * drop or double a row or column of the font ("E" losing its bar). Call once per frame after
   * the camera has moved.
   */
  snapToPixels(): void {
    if (!this.parent || !this.visible) return;
    const g = this.toGlobal({ x: this.basePivot.x, y: this.basePivot.y });
    const s = this.worldTransform.a;
    if (!s) return;
    this.pivot.set(this.basePivot.x - (Math.round(g.x) - g.x) / s, this.basePivot.y - (Math.round(g.y) - g.y) / s);
  }

  get text(): string { return this.value; }
  set text(next: string) {
    if (next === this.value) return;
    this.value = next;
    for (const child of this.removeChildren()) child.destroy();
    [...next].forEach((ch, i) => {
      const glyph = new Sprite(glyphTexture(glyphFor(ch)));
      glyph.scale.set(this.unit);
      glyph.position.set((i * ADVANCE - 1) * this.unit, -this.unit);
      glyph.tint = this.color;
      this.addChild(glyph);
    });
    this.layout();
  }

  get fill(): number { return this.color; }
  set fill(color: number) {
    if (color === this.color) return;
    this.color = color;
    for (const child of this.children) (child as Sprite).tint = color;
  }

  /** Unscaled width of the text, for fitting labels to their facility. */
  get naturalWidth(): number { return Math.max(0, [...this.value].length * ADVANCE - 1) * this.unit; }

  private layout(): void {
    // Whole font pixels, so centred text doesn't start halfway through a font pixel.
    this.basePivot = { x: Math.round((this.naturalWidth * this.ax) / this.unit) * this.unit, y: Math.round(GLYPH_H * this.ay) * this.unit };
    this.pivot.set(this.basePivot.x, this.basePivot.y);
  }
}
