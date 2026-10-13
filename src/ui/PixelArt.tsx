// HUD icons and crew portraits drawn from the same pixel world as the map, instead of emoji
// (which render differently on every OS) and CSS-painted helmets.

import { STYLES } from "../art/palettes";
import { ADVANCE, cells, GLYPH_H, glyphFor } from "../art/pixelfont";
import { flightCrew } from "../art/flightdeck";
import { rasterize } from "../art/render";
import { DEFAULT_VISOR, modelTier, PROVIDER_VISOR, providerSilhouette } from "../game/theme";
import { useGame } from "../store";

const ICONS = {
  sun: ["#..#..#", ".#...#.", "..###..", "#.###.#", "..###..", ".#...#.", "#..#..#"],
  moon: ["..###..", ".##....", "##.....", "##.....", "##.....", ".##....", "..###.."],
  sound: ["...#.....", "..##..#..", "####...#.", "####...#.", "####...#.", "..##..#..", "...#....."],
  muted: ["...#.....", "..##.....", "####.#.#.", "####..#..", "####.#.#.", "..##.....", "...#....."],
  fit: ["###.###", "##...##", "#.....#", ".......", "#.....#", "##...##", "###.###"],
  camp: ["...#...", "..#.#..", "..#.#..", ".#.#.#.", ".#.#.#.", "#..#..#", "#######"],
  recruit: ["######.", "######.", "...##..", "...##..", "...##..", "...##..", "...##.."],
  archive: ["#.#.##.", "#.#.##.", "#.#.##.", "#.#.##.", "#.#.##.", "#.#.##.", "#######"],
  bell: ["...#...", "..###..", ".#####.", ".#####.", ".#####.", "#######", "...#..."],
  bellOff: ["#..#...", ".####..", ".##.##.", ".###.#.", ".####..", "#######", "...#..#"],
  menu: ["#######", "#######", ".......", "#######", ".......", "#######", "#######"],
} as const;
export type IconName = keyof typeof ICONS;

/** A crisp pixel icon in the current text color. */
export function PixelIcon({ name, scale = 2 }: { name: IconName; scale?: number }) {
  const rows = ICONS[name] as readonly string[];
  const w = rows[0].length, h = rows.length;
  return (
    <svg className="pixel-icon" width={w * scale} height={h * scale} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      {cells([...rows]).map(([x, y]) => <rect key={`${x},${y}`} x={x} y={y} width={1} height={1} fill="currentColor" />)}
    </svg>
  );
}

const portraits = new Map<string, string>();

/** The crew member's actual map sprite: provider silhouette, model tier, team patch and visor. */
export function CrewPortrait({ instanceId, model, team, scale = 2 }: { instanceId: string; model: string; team: number; scale?: number }) {
  const artStyle = useGame((s) => s.artStyle);
  const silhouette = providerSilhouette(instanceId), tier = modelTier(model);
  const visor = PROVIDER_VISOR[instanceId] ?? DEFAULT_VISOR;
  const key = [artStyle, silhouette, tier, team, visor].join("|");
  let url = portraits.get(key);
  if (!url) {
    url = rasterize(flightCrew(silhouette, tier), STYLES[artStyle], { team, visor }).toDataURL();
    portraits.set(key, url);
  }
  return <img className="crew-portrait" src={url} width={16 * scale} height={22 * scale} alt="" draggable={false} />;
}


/**
 * HUD text in the map's 5×7 pixel font, so frame tabs speak the same type as the map. Drawn as
 * SVG cells (crisp at any scale); the text itself stays available to screen readers.
 */
export function PixelLabel({ text, scale = 2 }: { text: string; scale?: number }) {
  const chars = [...text.toUpperCase()];
  const width = Math.max(1, chars.length * ADVANCE - 1);
  return (
    <span className="pixel-label">
      <svg width={width * scale} height={GLYPH_H * scale} viewBox={`0 0 ${width} ${GLYPH_H}`} aria-hidden shapeRendering="crispEdges">
        {chars.flatMap((ch, i) => cells(glyphFor(ch)).map(([x, y]) => <rect key={`${i}-${x}-${y}`} x={i * ADVANCE + x} y={y} width={1} height={1} />))}
      </svg>
      <span className="visually-hidden">{text}</span>
    </span>
  );
}
