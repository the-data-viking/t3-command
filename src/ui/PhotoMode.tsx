import { useEffect, useState } from "react";
import { ADVANCE, cells, GLYPH_H, glyphFor } from "../art/pixelfont";
import { worldRef } from "../game/world";
import { useGame } from "../store";
import { PixelLabel } from "./PixelArt";
import { allUnits } from "./util";

/** The photo title: fleet, local time, crew on duty. */
function titleLine(now: Date): string {
  const onDuty = allUnits(useGame.getState().envs).filter((u) => u.state !== "sleeping").length;
  const time = now.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `T3 COMMAND · ${time} · ${onDuty} ON DUTY`;
}

/** Draw text in the map's 5×7 pixel font onto a canvas, `px` canvas pixels per font pixel. */
function drawPixelText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, px: number, color: string): number {
  ctx.fillStyle = color;
  [...text.toUpperCase()].forEach((ch, i) => {
    for (const [cx, cy] of cells(glyphFor(ch))) ctx.fillRect(x + (i * ADVANCE + cx) * px, y + cy * px, px, px);
  });
  return text.length * ADVANCE * px;
}

/** Save the map as a PNG at twice its screen size, with the title card drawn in, in pixel type. */
async function savePng(title: string): Promise<void> {
  const canvas = await worldRef.current?.snapshot(2);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  const px = 4;
  const pad = 12 * px;
  const width = title.length * ADVANCE * px;
  const y = canvas.height - pad - GLYPH_H * px;
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fillRect(pad - 3 * px, y - 3 * px, width + 6 * px, GLYPH_H * px + 6 * px);
  drawPixelText(ctx, title, pad, y, px, "#eef2f5");
  const url = canvas.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url;
  a.download = `t3-command-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.png`;
  a.click();
}

/**
 * Photo mode (P): the HUD goes away and the map stands alone with a small pixel-type title card.
 * Save PNG renders the map at twice its size with the title drawn in. Esc or P comes back.
 */
export function PhotoMode() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    // With the HUD gone the whole screen is map: frame the fleet in it.
    const frame = requestAnimationFrame(() => worldRef.current?.fitAll(true));
    return () => { clearInterval(timer); cancelAnimationFrame(frame); };
  }, []);
  const title = titleLine(now);
  return (
    <div className="photo-card">
      <span className="photo-title"><PixelLabel text={title} scale={2} /></span>
      <span className="photo-actions">
        <button className="btn small" onClick={() => void savePng(title)}>Save PNG</button>
        <button className="btn small" onClick={() => useGame.setState({ photo: false })}>Exit · Esc</button>
      </span>
    </div>
  );
}
