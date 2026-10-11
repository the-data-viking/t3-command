import type { Grid } from './sprites';
export type PixelBox = [number, number, number, number, string];

/** Layer rectangular pixel marks, keeping the canvas bounds explicit. */
export function panel(w: number, h: number, boxes: PixelBox[]): Grid {
  const pixels = Array.from({ length: h }, () => Array<string>(w).fill('.'));
  for (const [x, y, width, height, code] of boxes) {
    if (x < 0 || y < 0 || x + width > w || y + height > h) throw new Error('Pixel mark exceeds sprite bounds');
    for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) pixels[yy][xx] = code;
  }
  return pixels.map(row => row.join(''));
}
