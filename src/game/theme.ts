// Fleet-command palette. Status colors mean the same thing everywhere (map, HUD, minimap);
// team colors only identify which station (T3 environment) something belongs to.

import type { UnitState } from "../t3/derive";

export const STATUS: Record<UnitState, number> = {
  alert: 0xff4655,
  question: 0xffd23f,
  working: 0x59e1ff,
  error: 0xff7a3d,
  done: 0x5dff9a,
  idle: 0x9aa7bd,
  sleeping: 0x4a5266,
};

export const HUD = {
  amber: 0xf0a33a,
  amberDim: 0x7a5420,
  cyan: 0x59e1ff,
  hull: 0x1b222c,
  hullLight: 0x2a3340,
  hullEdge: 0x0c1016,
  floor: 0x11161d,
  floorTile: 0x161c25,
  space: 0x04060a,
  text: 0xe6edf3,
  muted: 0x8a96a8,
};

/** Distinct station colors, chosen to stay clear of the status colors above. */
const TEAM_COLORS = [0xf0a33a, 0x9b7bff, 0x3ec7b3, 0xe45fbf, 0x5b8cff, 0xa8d65a, 0xff8a5c, 0x49b6ff];

export function teamColor(index: number): number {
  return TEAM_COLORS[index % TEAM_COLORS.length];
}

export const PROVIDER_VISOR: Record<string, number> = {
  claudeAgent: 0xe2884f,
  codex: 0x46d6c2,
  cursor: 0x8f8fe8,
  grok: 0xd0d0d0,
  opencode: 0xd8c25a,
};

// ---- Crew classes ----------------------------------------------------------------------

/** How big and well-equipped a crew member looks, from its model. */
export type Tier = "light" | "standard" | "heavy" | "reviewer";

/**
 * Model slug → tier. First match wins; anything unmatched is "standard". The Codex names are a
 * best guess from their naming (Sol > Astra/Terra > Luna); adjust here if that's wrong.
 */
const TIER_RULES: Array<[RegExp, Tier]> = [
  [/review/i, "reviewer"],
  [/haiku|luna|mini|nano|flash|lite/i, "light"],
  [/opus|fable|(^|[-.])sol($|[-.])|ultra|max|pro/i, "heavy"],
];

export function modelTier(model: string): Tier {
  return TIER_RULES.find(([re]) => re.test(model))?.[1] ?? "standard";
}

export const TIER_LABEL: Record<Tier, string> = {
  light: "Scout",
  standard: "Specialist",
  heavy: "Heavy",
  reviewer: "Inspector",
};

/** Suit silhouette by provider: Claude crew are rounded, Codex crew are angular. */
export type Silhouette = "round" | "angular";

export function providerSilhouette(instanceId: string): Silhouette {
  return instanceId === "codex" || instanceId === "cursor" || instanceId === "opencode" ? "angular" : "round";
}

export function css(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}
