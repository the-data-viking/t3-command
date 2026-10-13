import { STYLES } from "../art/palettes";
import { ART_STYLES, type ArtStyle } from "../store";

/** Theme names as shown in the picker and the command palette (from the palettes, one source). */
export const THEME_NAMES = Object.fromEntries(ART_STYLES.map((id) => [id, STYLES[id].name])) as Record<ArtStyle, string>;
