// Command-wide preferences, kept on the Command server so every device agrees: the model each
// provider starts new crew on, and how much each machine is wanted when a request is routed.

/** A provider's model and its options, as T3 takes them (mirrors src/t3/types ModelSelection). */
export interface ModelChoice {
  instanceId: string;
  model: string;
  options?: Array<{ id: string; value: string | boolean }>;
}

/**
 * How eagerly auto-routing sends new requests to a machine. The same four levels as T3 Code's own
 * load-balancing preference (Prefer 100, Normal 50, Less often 25, Manual only 0).
 */
export type RoutingLevel = "prefer" | "normal" | "less" | "manual";

export const ROUTING_LEVELS: ReadonlyArray<{ id: RoutingLevel; label: string; weight: number }> = [
  { id: "prefer", label: "Prefer", weight: 100 },
  { id: "normal", label: "Normal", weight: 50 },
  { id: "less", label: "Less often", weight: 25 },
  { id: "manual", label: "Manual only", weight: 0 },
];

export interface CommandPrefs {
  /** The provider new requests start on, when that machine has it. */
  provider?: string;
  /** Each provider's default model, by provider instance id ("codex", "claudeAgent", …). */
  models: Record<string, ModelChoice>;
  /** Machines not at Normal, by environment id. */
  routing: Record<string, RoutingLevel>;
}

export const EMPTY_PREFS: CommandPrefs = { models: {}, routing: {} };

const LEVELS = new Set<string>(ROUTING_LEVELS.map((l) => l.id));
const short = (v: unknown, max = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

function sanitizeChoice(input: unknown): ModelChoice | undefined {
  if (!input || typeof input !== "object") return undefined;
  const c = input as Record<string, unknown>;
  if (!short(c.instanceId) || !short(c.model)) return undefined;
  const options = Array.isArray(c.options)
    ? c.options.filter((o): o is { id: string; value: string | boolean } =>
      !!o && typeof o === "object" && short((o as { id?: unknown }).id) && (typeof (o as { value?: unknown }).value === "boolean" || short((o as { value?: unknown }).value)))
      .slice(0, 20).map((o) => ({ id: o.id, value: o.value }))
    : undefined;
  return { instanceId: c.instanceId, model: c.model, ...(options?.length ? { options } : {}) };
}

/** Prefs from untrusted JSON; unknown or malformed parts are dropped. */
export function sanitizePrefs(input: unknown): CommandPrefs {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { models: {}, routing: {} };
  const raw = input as Record<string, unknown>;
  const models: Record<string, ModelChoice> = {};
  if (raw.models && typeof raw.models === "object") {
    for (const [id, value] of Object.entries(raw.models as Record<string, unknown>).slice(0, 50)) {
      const choice = sanitizeChoice(value);
      if (choice && choice.instanceId === id) models[id] = choice;
    }
  }
  const routing: Record<string, RoutingLevel> = {};
  if (raw.routing && typeof raw.routing === "object") {
    for (const [id, level] of Object.entries(raw.routing as Record<string, unknown>).slice(0, 200)) {
      if (short(id) && typeof level === "string" && LEVELS.has(level) && level !== "normal") routing[id] = level as RoutingLevel;
    }
  }
  return { ...(short(raw.provider) ? { provider: raw.provider } : {}), models, routing };
}
