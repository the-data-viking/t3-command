import { useEffect, useRef } from "react";
import { css, HUD } from "../game/theme";
import { worldRef } from "../game/world";
import { HERMES_COLOR } from '../t3/bots';

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
      const blink = frame % 4 < 2;
      const signature = JSON.stringify([data, data?.dots.some((d) => d.big) ? blink : false]);
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

      ctx.fillStyle = "#f0a33a22";
      ctx.strokeStyle = "#f0a33a66";
      for (const r of data.hubs) {
        ctx.fillRect(ox + r.x * scale, oy + r.y * scale, Math.max(2, r.w * scale), Math.max(2, r.h * scale));
        ctx.strokeRect(ox + r.x * scale + 0.5, oy + r.y * scale + 0.5, Math.max(2, r.w * scale), Math.max(2, r.h * scale));
      }
      for (const s of data.stations) {
        ctx.fillStyle = s.live ? `${css(s.color)}33` : "#3a425022";
        ctx.strokeStyle = s.live ? css(s.color) : "#3a4250";
        ctx.lineWidth = 1;
        ctx.fillRect(ox + s.rect.x * scale, oy + s.rect.y * scale, s.rect.w * scale, s.rect.h * scale);
        ctx.strokeRect(ox + s.rect.x * scale + 0.5, oy + s.rect.y * scale + 0.5, s.rect.w * scale, s.rect.h * scale);
      }
      for (const d of data.dots) {
        const size = d.big ? (blink ? 5 : 3) : 2;
        ctx.fillStyle = css(d.color);
        ctx.fillRect(ox + d.x * scale - size / 2, oy + d.y * scale - size / 2, size, size);
      }
      if (data.controlCenter) {
        const r = data.controlCenter;
        const x = ox + (r.x + r.w / 2) * scale, y = oy + (r.y + r.h / 2) * scale;
        const rx = Math.max(7, r.w * scale / 2), ry = Math.max(5, r.h * scale / 2);
        ctx.fillStyle = `${css(HERMES_COLOR)}33`; ctx.strokeStyle = css(HERMES_COLOR);
        ctx.beginPath(); ctx.moveTo(x, y - ry); ctx.lineTo(x + rx, y); ctx.lineTo(x, y + ry); ctx.lineTo(x - rx, y); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      const v = data.view;
      ctx.strokeStyle = css(HUD.amber);
      ctx.lineWidth = 1;
      ctx.strokeRect(ox + v.x * scale + 0.5, oy + v.y * scale + 0.5, v.w * scale, v.h * scale);
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

  const moveTo = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const { scale, ox, oy } = mapping.current;
    worldRef.current?.centerOn((e.clientX - rect.left - ox) / scale, (e.clientY - rect.top - oy) / scale);
  };

  return (
    <div className="minimap hud-frame">
      <div className="hud-label">SECTOR MAP</div>
      <canvas
        ref={canvas}
        style={{ width: W, height: H }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          moveTo(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons) moveTo(e);
        }}
      />
    </div>
  );
}
