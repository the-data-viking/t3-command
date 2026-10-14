import { useEffect, useRef } from "react";
import { PixelLabel } from "./PixelArt";
import { css, mapInk } from "../game/theme";
import { STYLES } from "../art/palettes";
import { useGame } from "../store";
import { worldRef } from "../game/world";
import { HERMES_COLOR } from '../t3/bots';
import { cells, STATUS_GLYPHS } from "../art/pixelfont";

const W = 220;
const H = 140;
const FPS = 6;

/** Tactical overview of the whole fleet. Click or drag to move the camera. */
export function Minimap() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const mapping = useRef<{ scale: number; ox: number; oy: number }>({ scale: 1, ox: 0, oy: 0 });

  useEffect(() => {
    const el = canvas.current!;
    el.width = W;
    el.height = H;
    const ctx = el.getContext("2d")!;
    let frame = 0;
    let previous = "";

    const draw = () => {
      frame++;
      const data = worldRef.current?.minimap();
      // Status reads by shape; the attention blink is skipped under reduced motion.
      const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
      const blink = !still && frame % 4 < 2;
      // The world is part of it: switching worlds repaints even when nothing on the map moved.
      const signature = JSON.stringify([useGame.getState().artStyle, data, data?.dots.some((d) => d.big) ? blink : false]);
      if (signature === previous) return;
      previous = signature;
      ctx.clearRect(0, 0, W, H);
      if (!data || data.bounds.w === 0) return;
      const pad = 10;
      const b = data.bounds;
      const scale = Math.min((W - pad * 2) / b.w, (H - pad * 2) / b.h);
      const ox = pad + (W - pad * 2 - b.w * scale) / 2 - b.x * scale;
      const oy = pad + (H - pad * 2 - b.h * scale) / 2 - b.y * scale;
      mapping.current = { scale, ox, oy };

      // Stations in the theme's own hull colour; the view box in its frame colour.
      const style = useGame.getState().artStyle;
      // The view box is drawn over map space, so it takes map ink (the HUD frame vanishes on light HUDs).
      const hull = css(STYLES[style].colors.H), frameColor = css(mapInk(style).text), offline = css(mapInk(style).line);
      ctx.fillStyle = `${hull}33`;
      ctx.strokeStyle = `${hull}aa`;
      for (const r of data.hubs) {
        ctx.fillRect(ox + r.x * scale, oy + r.y * scale, Math.max(2, r.w * scale), Math.max(2, r.h * scale));
        ctx.strokeRect(ox + r.x * scale + 0.5, oy + r.y * scale + 0.5, Math.max(2, r.w * scale), Math.max(2, r.h * scale));
      }
      for (const s of data.stations) {
        // Fills strong enough to tell the machines' colours apart; an unreachable one is a dashed
        // outline in the map's line ink, which reads against this world's space.
        ctx.fillStyle = s.live ? `${css(s.color)}66` : `${offline}22`;
        ctx.strokeStyle = s.live ? css(s.color) : offline;
        ctx.lineWidth = 1;
        ctx.setLineDash(s.live ? [] : [2, 2]);
        ctx.fillRect(ox + s.rect.x * scale, oy + s.rect.y * scale, s.rect.w * scale, s.rect.h * scale);
        ctx.strokeRect(ox + s.rect.x * scale + 0.5, oy + s.rect.y * scale + 0.5, s.rect.w * scale, s.rect.h * scale);
        ctx.setLineDash([]);
      }
      // Each crew dot is its status glyph (▲ approval, ◆ question, ● working…), not just a color.
      for (const d of data.dots) {
        const px = d.big && (blink || still) ? 2 : 1;
        const x = Math.round(ox + d.x * scale - 2.5 * px), y = Math.round(oy + d.y * scale - 2.5 * px);
        ctx.fillStyle = css(d.color);
        for (const [cx, cy] of cells(STATUS_GLYPHS[d.state])) ctx.fillRect(x + cx * px, y + cy * px, px, px);
      }
      if (data.controlCenter) {
        const r = data.controlCenter;
        const x = ox + (r.x + r.w / 2) * scale, y = oy + (r.y + r.h / 2) * scale;
        const rx = Math.max(7, r.w * scale / 2), ry = Math.max(5, r.h * scale / 2);
        ctx.fillStyle = `${css(HERMES_COLOR)}33`; ctx.strokeStyle = css(HERMES_COLOR);
        ctx.beginPath(); ctx.moveTo(x, y - ry); ctx.lineTo(x + rx, y); ctx.lineTo(x, y + ry); ctx.lineTo(x - rx, y); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      const v = data.view;
      ctx.strokeStyle = frameColor;
      ctx.lineWidth = 1;
      // Clamp the view box to the canvas, so all four sides show even when the view runs off the fleet.
      const cw = ctx.canvas.width, ch = ctx.canvas.height;
      const x0 = Math.max(0.5, ox + v.x * scale + 0.5), y0 = Math.max(0.5, oy + v.y * scale + 0.5);
      const x1 = Math.min(cw - 0.5, ox + (v.x + v.w) * scale + 0.5), y1 = Math.min(ch - 0.5, oy + (v.y + v.h) * scale + 0.5);
      if (x1 > x0 && y1 > y0) ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    };
    let id: ReturnType<typeof setInterval> | undefined;
    const visibility = () => {
      clearInterval(id);
      if (document.hidden) return;
      draw();
      id = setInterval(draw, 1000 / FPS);
    };
    document.addEventListener("visibilitychange", visibility);
    visibility();
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  const moveTo = (e: React.PointerEvent<HTMLCanvasElement>, animate: boolean) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const { scale, ox, oy } = mapping.current;
    worldRef.current?.centerOn((e.clientX - rect.left - ox) / scale, (e.clientY - rect.top - oy) / scale, animate);
  };

  return (
    <div className="minimap hud-frame">
      <div className="hud-label"><PixelLabel text="Sector map" /></div>
      <canvas
        ref={canvas}
        style={{ width: W, height: H }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          moveTo(e, true);
        }}
        onPointerMove={(e) => {
          if (e.buttons) moveTo(e, false);
        }}
      />
    </div>
  );
}
