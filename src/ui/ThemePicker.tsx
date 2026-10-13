import { useEffect, useRef, useState } from "react";
import { STYLES } from "../art/palettes";
import { css, hudMaterials } from "../game/theme";
import { ART_STYLES, setArtStyle, useGame } from "../store";
import { PixelIcon } from "./PixelArt";
import { THEME_NAMES } from "./themes";

/** Map and HUD theme: a menu of every live style, each with a swatch of its materials. */
export function ThemePicker() {
  const artStyle = useGame((s) => s.artStyle);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);

  return (
    <div className="theme-menu" ref={root}>
      <button className="icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`Theme: ${THEME_NAMES[artStyle]}`}
        title={`Theme: ${THEME_NAMES[artStyle]}`} onClick={() => setOpen(!open)}>
        <PixelIcon name={artStyle === "flightdeck" ? "sun" : "moon"} /><span className="phone-label">Theme · {THEME_NAMES[artStyle]}</span>
      </button>
      {open && (
        <div className="theme-list hud-frame" role="menu" aria-label="Theme">
          {ART_STYLES.map((id) => {
            const style = STYLES[id];
            const m = hudMaterials(id);
            return (
              <button key={id} role="menuitemradio" aria-checked={artStyle === id} className={`theme-option ${artStyle === id ? "active" : ""}`}
                onClick={() => { setArtStyle(id); setOpen(false); }}>
                <span className="theme-swatch" aria-hidden>
                  {[style.space, m.frame, style.colors.H, style.colors.f].map((c, i) => <i key={i} style={{ background: css(c) }} />)}
                </span>
                <span>{THEME_NAMES[id]}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
