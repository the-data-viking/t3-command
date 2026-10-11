import { useEffect, useRef } from "react";
import { css, HUD } from "../game/theme";
import { worldRef } from "../game/world";

const W = 220;
const H = 140;
const FPS = 6;

/** Tactical overview of the whole fleet. Click or drag to move the camera. */
export function Minimap() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const mapping = useRef<{ scale: number; ox: number; oy: number }>({ scale: 1, ox: 0, oy: 0 });

  useEffect(() => {
    const el = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    el.width = W * dpr;
    el.height = H * dpr;
    const ctx = el.getContext("2d")!;
    ctx.scale(dpr, dpr);
    let frame = 0;

    const draw = () => {
      frame++;
      const data = worldRef.current?.minimap();
      ctx.clearRect(0, 0, W, H);
      if (!data || data.bounds.w === 0) return;
      const pad = 10;
      const b = data.bounds;
      const scale = Math.min((W - pad * 2) / b.w, (H - pad * 2) / b.h);
      const ox = pad + (W - pad * 2 - b.w * scale) / 2 - b.x * scale;
      const oy = pad + (H - pad * 2 - b.h * scale) / 2 - b.y * scale;
      mapping.current = { scale, ox, oy };

      for (const s of data.stations) {
        ctx.fillStyle = s.live ? `${css(s.color)}33` : "#3a425022";
        ctx.strokeStyle = s.live ? css(s.color) : "#3a4250";
        ctx.lineWidth = 1;
        ctx.fillRect(ox + s.rect.x * scale, oy + s.rect.y * scale, s.rect.w * scale, s.rect.h * scale);
        ctx.strokeRect(ox + s.rect.x * scale + 0.5, oy + s.rect.y * scale + 0.5, s.rect.w * scale, s.rect.h * scale);
      }
      const blink = frame % 4 < 2;
      for (const d of data.dots) {
        const size = d.big ? (blink ? 5 : 3) : 2;
        ctx.fillStyle = css(d.color);
        ctx.fillRect(ox + d.x * scale - size / 2, oy + d.y * scale - size / 2, size, size);
      }
      const v = data.view;
      ctx.strokeStyle = css(HUD.amber);
      ctx.lineWidth = 1;
      ctx.strokeRect(ox + v.x * scale + 0.5, oy + v.y * scale + 0.5, v.w * scale, v.h * scale);
    };
    const id = setInterval(draw, 1000 / FPS);
    draw();
    return () => clearInterval(id);
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
