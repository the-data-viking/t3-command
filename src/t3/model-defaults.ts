// Which model a new crew member starts on. One rule everywhere, so a machine or browser you haven't
// used before starts the same way as the one you have: your Command default first, then that
// machine's own T3 default (per-project override, then server-wide), and T3's built-in default last.

import type { CommandPrefs, ModelChoice } from "../../shared/prefs";
import type { T3ModelDefaults } from "../store";
import type { ModelSelection, Provider, ServerSettings } from "./types";

export function t3Defaults(settings: ServerSettings): T3ModelDefaults {
  const projects: Record<string, ModelSelection> = {};
  for (const [id, o] of Object.entries(settings.projectSettingsOverrides ?? {})) {
    if (o?.defaultModelSelection) projects[id] = o.defaultModelSelection;
  }
  return { model: settings.defaultModelSelection ?? null, projects };
}

/** Providers a new crew member can start on. */
export function usableProviders(providers: Provider[]): Provider[] {
  return providers.filter((p) => p.enabled && p.installed && p.models.length > 0);
}

const offers = (providers: Provider[], sel: ModelSelection | null | undefined): sel is ModelSelection =>
  !!sel && !!providers.find((p) => p.instanceId === sel.instanceId)?.models.some((m) => m.slug === sel.model);

interface Sources {
  prefs: CommandPrefs;
  t3?: T3ModelDefaults;
  projectId?: string;
  /** The project's own default, as T3's project shell carries it. */
  projectDefault?: ModelSelection | null;
}

/** The machine's own T3 defaults, most specific first. */
function machineDefaults({ t3, projectId, projectDefault }: Sources): Array<ModelSelection | null | undefined> {
  return [projectId ? t3?.projects[projectId] : undefined, t3?.model, projectDefault];
}

/** The model a provider starts on: your default for it, else the machine's if it names this provider, else T3's. */
export function providerDefault(provider: Provider, sources: Sources): ModelSelection {
  const ok = (sel: ModelSelection | null | undefined): sel is ModelSelection => offers([provider], sel);
  const mine = sources.prefs.models[provider.instanceId];
  if (ok(mine)) return mine;
  const machine = machineDefaults(sources).find(ok);
  if (machine) return machine;
  const model = provider.models.find((m) => m.isDefault) ?? provider.models[0];
  return { instanceId: provider.instanceId, model: model.slug };
}

/** The selection a new request starts with on this machine. */
export function startingSelection(providers: Provider[], sources: Sources): ModelSelection | undefined {
  const usable = usableProviders(providers);
  const preferred = usable.find((p) => p.instanceId === sources.prefs.provider);
  if (preferred) return providerDefault(preferred, sources);
  const machine = machineDefaults(sources).find((sel) => offers(usable, sel));
  const provider = (machine && usable.find((p) => p.instanceId === machine.instanceId)) ?? usable[0];
  return provider ? providerDefault(provider, sources) : undefined;
}

const sameOptions = (a: ModelChoice["options"], b: ModelChoice["options"]) =>
  JSON.stringify([...(a ?? [])].sort((x, y) => x.id.localeCompare(y.id))) === JSON.stringify([...(b ?? [])].sort((x, y) => x.id.localeCompare(y.id)));

/** Whether this selection is already your default: its provider is the one you start on, with this model and options. */
export function isMyDefault(prefs: CommandPrefs, sel: ModelSelection): boolean {
  const mine = prefs.models[sel.instanceId];
  return prefs.provider === sel.instanceId && !!mine && mine.model === sel.model && sameOptions(mine.options, sel.options);
}
