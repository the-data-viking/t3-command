import { useMemo, useState } from "react";
import { useGame } from "../store";
import { usableProviders } from "../t3/model-defaults";
import { patchPrefs } from "../t3/prefs";
import type { ModelSelection, Provider } from "../t3/types";

/** Every provider any connected machine offers, by instance id: the copy with the most models. */
function fleetProviders(providers: Provider[][]): Provider[] {
  const byId = new Map<string, Provider>();
  for (const p of providers.flatMap(usableProviders)) {
    const seen = byId.get(p.instanceId);
    if (!seen || p.models.length > seen.models.length) byId.set(p.instanceId, p);
  }
  return [...byId.values()].sort((a, b) => (a.displayName ?? a.instanceId).localeCompare(b.displayName ?? b.instanceId));
}

/**
 * The model each provider starts new crew on, and which provider new requests start with, for
 * every machine and device. Unset, a machine uses its own T3 default, then T3's built-in one.
 */
export function DefaultModels() {
  const envs = useGame((s) => s.envs);
  const prefs = useGame((s) => s.prefs);
  const providers = useMemo(() => fleetProviders(Object.values(envs).filter((e) => e.summary.kind !== "hermes").map((e) => e.providers)), [envs]);
  // What an unset provider falls back to: the machines' own T3 default, if they agree on one.
  const t3Default = useMemo(() => {
    const models = Object.values(envs).map((e) => e.t3Defaults?.model).filter((m): m is ModelSelection => !!m);
    return new Set(models.map((m) => `${m.instanceId}:${m.model}`)).size === 1 ? models[0] : undefined;
  }, [envs]);
  const [error, setError] = useState<string>();
  const save = (patch: Parameters<typeof patchPrefs>[0]) => { setError(undefined); patchPrefs(patch).catch((err: Error) => setError(err.message)); };

  if (!providers.length) return null;
  const name = (p: Provider, slug: string) => p.models.find((m) => m.slug === slug)?.name ?? slug;
  return (
    <section className="default-models">
      <h3>Default models</h3>
      <p className="muted small">
        What new requests start on, on every machine and device. Change it for one request in its form; ☆ Make default there saves it here.
      </p>
      {providers.map((p) => {
        const mine = prefs.models[p.instanceId];
        const machine = t3Default?.instanceId === p.instanceId ? t3Default : undefined;
        const fallback = machine?.model ?? (p.models.find((m) => m.isDefault) ?? p.models[0]).slug;
        // A model picked here starts with the machines' own options for it (reasoning effort, …).
        const choose = (slug: string): ModelSelection => ({ instanceId: p.instanceId, model: slug, ...(machine?.model === slug && machine.options ? { options: machine.options } : {}) });
        const model = p.models.find((m) => m.slug === (mine?.model ?? fallback));
        const selects = (model?.capabilities?.optionDescriptors ?? []).filter((d) => d.type === "select" && d.options?.length);
        const setModel = (sel: ModelSelection | null) => save({ models: { [p.instanceId]: sel } });
        return (
          <div className="default-model-row" key={p.instanceId}>
            <label className="small" title="New requests start on this provider when the machine has it">
              <input type="radio" name="default-provider" checked={prefs.provider === p.instanceId}
                onChange={() => save({ provider: p.instanceId, ...(mine ? {} : { models: { [p.instanceId]: choose(fallback) } }) })} />
              {" "}{p.displayName ?? p.instanceId}
            </label>
            <select value={mine?.model ?? ""} aria-label={`${p.displayName ?? p.instanceId} default model`}
              onChange={(e) => setModel(e.target.value ? choose(e.target.value) : null)}>
              <option value="">Machine default ({name(p, fallback)})</option>
              {p.models.map((m) => <option key={m.slug} value={m.slug}>{m.name}</option>)}
            </select>
            {mine && selects.map((d) => (
              <select key={d.id} title={d.label} value={String(mine.options?.find((o) => o.id === d.id)?.value ?? d.options!.find((o) => o.isDefault)?.id ?? d.options![0].id)}
                onChange={(e) => setModel({ ...mine, options: [...(mine.options ?? []).filter((o) => o.id !== d.id), { id: d.id, value: e.target.value }] })}>
                {d.options!.map((o) => <option key={o.id} value={o.id}>{d.label}: {o.label}</option>)}
              </select>
            ))}
          </div>
        );
      })}
      {prefs.provider && <button className="btn small" onClick={() => save({ provider: null })}>Start on each machine's own default provider</button>}
      {error && <p className="orange small" role="alert">{error}</p>}
    </section>
  );
}
