import { useEffect, useRef, useState } from "react";
import { previewVolume } from "../game/sfx";
import { setMuted, setVolume, useGame } from "../store";
import { PixelIcon } from "./PixelArt";

/** Mute and master volume; the slider previews the new level as you set it. */
export function SoundMenu() {
  const muted = useGame((s) => s.muted);
  const volume = useGame((s) => s.volume);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const silent = muted || volume === 0;

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);

  return (
    <div className="theme-menu sound-menu" ref={root}>
      <button className="icon-btn" aria-haspopup="dialog" aria-expanded={open} title={silent ? "Sound off" : `Sound ${Math.round(volume * 100)}%`}
        aria-label={silent ? "Sound off. Open sound settings" : `Sound ${Math.round(volume * 100)}%. Open sound settings`} onClick={() => setOpen(!open)}>
        <PixelIcon name={silent ? "muted" : "sound"} /><span className="phone-label">{silent ? "Sound off" : `Sound ${Math.round(volume * 100)}%`}</span>
      </button>
      {open && (
        <div className="theme-list sound-panel hud-frame" role="dialog" aria-label="Sound">
          <label className="sound-row">
            <input type="checkbox" checked={!muted} onChange={(e) => setMuted(!e.target.checked)} /> Sound effects
          </label>
          <label className="sound-row">
            <span>Volume</span>
            <input type="range" min={0} max={100} step={5} value={Math.round(volume * 100)} disabled={muted}
              aria-valuetext={`${Math.round(volume * 100)}%`}
              onChange={(e) => setVolume(Number(e.target.value) / 100)} onPointerUp={() => previewVolume()} onKeyUp={() => previewVolume()} />
            <span className="sound-value">{Math.round(volume * 100)}%</span>
          </label>
          <p className="muted small">Approvals sound a klaxon, questions a rising tone. Bursts are thinned so alerts never pile up.</p>
        </div>
      )}
    </div>
  );
}
