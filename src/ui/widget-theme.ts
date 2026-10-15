// How a widget is dressed where it's shown. In the crew panel it's a module of the station: hull
// plating, a walled room with deck tiles, the map's own materials. Pinned, it's HUD chrome like
// every other window. The page inside gets the matching colours as --t3-* variables.

import { STYLES, type StyleId } from "../art/palettes";
import { contrastRatio, css, GAUGE, mapInk } from "../game/theme";

/** The colours a widget page can use (as var(--t3-<name>)), for where it's shown right now. */
export interface WidgetTheme {
  bg: string;
  surface: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  ok: string;
  warn: string;
  bad: string;
}

/** a toward b by t (0–1), per channel. */
export function mix(a: number, b: number, t: number): number {
  const ch = (shift: number) => Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t) << shift;
  return ch(16) | ch(8) | ch(0);
}

/** Whichever candidate reads best on a background. */
export function readableOn(bg: number, candidates: number[]): number {
  return candidates.reduce((best, c) => contrastRatio(c, bg) > contrastRatio(best, bg) ? c : best);
}

export interface ModuleMaterials {
  /** CSS variables for the module card (see .widget-card in index.css). */
  vars: Record<string, string>;
  theme: WidgetTheme;
  silhouette: "industrial" | "ftl" | "soft";
}

/**
 * A station module's materials in a world: hull plate (H) with its light (h) and shade (D) bands,
 * the one-pixel outline (k), the room's walls and deck (f), and ink that reads on each. Map label
 * ink is made for space and dark plating; pale hulls take the outline colour instead.
 */
export function moduleMaterials(styleId: StyleId, team: number): ModuleMaterials {
  const style = STYLES[styleId];
  const c = style.colors;
  const ink = mapInk(styleId);
  const hullText = readableOn(c.H, [ink.text, c.k]);
  const hullMuted = mix(hullText, c.H, 0.35);
  const floorText = readableOn(c.f, [ink.text, c.k]);
  return {
    silhouette: style.hull ?? "industrial",
    vars: {
      "--module-outline": css(c.k),
      "--module-hull": css(c.H),
      "--module-light": css(c.h),
      "--module-shade": css(c.D),
      "--module-wall": css(style.wall),
      "--module-deck": css(c.f),
      "--module-text": css(hullText),
      "--module-muted": css(hullMuted),
      "--module-team": css(team),
    },
    theme: {
      bg: css(c.f),
      surface: css(c.F),
      line: css(style.wall),
      text: css(floorText),
      muted: css(mix(floorText, c.f, 0.4)),
      accent: css(team),
      ok: css(GAUGE.ok),
      warn: css(GAUGE.high),
      bad: css(GAUGE.critical),
    },
  };
}

/** The HUD's colours, as the stylesheet has them now (see applyHudTheme). */
export function hudWidgetTheme(read: (name: string) => string): WidgetTheme {
  return {
    bg: read("--deep"),
    surface: read("--surface"),
    line: read("--edge-strong"),
    text: read("--text"),
    muted: read("--muted"),
    accent: read("--frame"),
    ok: read("--gauge-ok"),
    warn: read("--gauge-high"),
    bad: read("--gauge-critical"),
  };
}

/** The theme as a stylesheet for the page: its variables, and the page's default colours. */
export function themeCss(theme: WidgetTheme): string {
  const vars = Object.entries(theme).map(([name, value]) => `--t3-${name}:${value.replace(/[;{}<]/g, "")}`).join(";");
  return `:root{${vars};--t3-font:"IBM Plex Mono",ui-monospace,Menlo,monospace}:where(html){background:var(--t3-bg);color:var(--t3-text)}`;
}
