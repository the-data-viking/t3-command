import { useEffect, useRef, useState } from "react";
import { STYLES } from "../art/palettes";
import { applyHudTheme, css, hudMaterials } from "../game/theme";
import { setArtStyle, setHighContrast, useGame, type ArtStyle } from "../store";
import { themeThumbnail } from "./theme-thumbnail";
import { THEME_NAMES, WORLDS } from "./themes";

/**
 * The world the fleet lives in: three worlds, each with its own station, sky and light (Night
 * Shift also by day), and High Contrast as an accessibility mode over them. Hovering previews the HUD.
 */
export function ThemePicker() {
  const artStyle = useGame((s) => s.artStyle);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Hovering or focusing a theme previews its HUD; leaving the menu puts the chosen one back.
  useEffect(() => {
    if (!open) applyHudTheme(artStyle);
  }, [open, artStyle]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);

  const choose = (style: ArtStyle) => { setArtStyle(style); setOpen(false); };
  const highContrast = artStyle === "highcontrast";

  return (
    <div className="theme-menu" ref={root}>
      <button className="icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`Theme: ${THEME_NAMES[artStyle]}`}
        title={`Theme: ${THEME_NAMES[artStyle]}`} onClick={() => setOpen(!open)}>
        <img className="theme-icon" src={themeThumbnail(artStyle)} alt="" width={26} height={15} draggable={false} /><span className="phone-label">{THEME_NAMES[artStyle]}</span>
      </button>
      {open && (
        <div className="theme-list hud-frame" role="menu" aria-label="World" onPointerLeave={() => applyHudTheme(artStyle)}>
          <div className="theme-head">World</div>
          {WORLDS.map((world) => {
            const current = world.variants.find((v) => v.style === artStyle);
            const shown = current?.style ?? world.variants[0].style;
            const m = hudMaterials(shown);
            return (
              <div key={world.id} className={`theme-world ${current ? "active" : ""}`}>
                <button role="menuitemradio" aria-checked={!!current} className="theme-option"
                  onPointerEnter={() => applyHudTheme(shown)} onFocus={() => applyHudTheme(shown)} onClick={() => choose(shown)}>
                  <img className="theme-thumb" src={themeThumbnail(shown)} alt="" width={104} height={60} draggable={false} style={{ outline: `2px solid ${css(m.frame)}` }} />
                  <span className="theme-option-text"><span>{world.name}{current && world.variants.length > 1 ? ` · ${current.label}` : ""}</span><span className="muted small">{STYLES[shown].blurb}</span></span>
                </button>
                {world.variants.length > 1 && (
                  <div className="theme-variants" role="group" aria-label={`${world.name}: time of day`}>
                    {world.variants.map((v) => (
                      <button key={v.style} className={`btn small ${artStyle === v.style ? "active" : ""}`} aria-pressed={artStyle === v.style}
                        onPointerEnter={() => applyHudTheme(v.style)} onFocus={() => applyHudTheme(v.style)} onClick={() => choose(v.style)}>
                        {v.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <label className="theme-hc" onPointerEnter={() => applyHudTheme("highcontrast")}>
            <input type="checkbox" checked={highContrast} onChange={(e) => { setHighContrast(e.target.checked); setOpen(false); }} />
            <span className="theme-option-text"><span>High contrast</span><span className="muted small">Accessibility: black wells, white frames, the brightest status colours. Turn off to return to your world.</span></span>
          </label>
        </div>
      )}
    </div>
  );
}
