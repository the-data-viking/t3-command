import { STYLES } from "../art/palettes";
import { ART_STYLES, type ArtStyle } from "../store";

/** Theme names as shown in the picker and the command palette (from the palettes, one source). */
export const THEME_NAMES = Object.fromEntries(ART_STYLES.map((id) => [id, STYLES[id].name])) as Record<ArtStyle, string>;

/** A world: one station and sky, sometimes in more than one light. High Contrast sits outside them. */
export interface World {
  id: string;
  name: string;
  variants: Array<{ style: ArtStyle; label: string }>;
}

export const WORLDS: World[] = [
  { id: "nightshift", name: "Night Shift", variants: [{ style: "flightdeck-nightshift", label: "Night" }, { style: "signal", label: "Day" }] },
  { id: "kestrel", name: "Kestrel", variants: [{ style: "flightdeck", label: "Kestrel" }] },
  { id: "pastel", name: "Pastel Ops", variants: [{ style: "pastel", label: "Pastel Ops" }] },
];

/** The world a style belongs to; undefined for High Contrast. */
export function worldOf(style: ArtStyle): World | undefined {
  return WORLDS.find((w) => w.variants.some((v) => v.style === style));
}
