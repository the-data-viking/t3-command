// Change Command-wide preferences (default models, routing levels). The server merges the patch and
// broadcasts the result to every device; this one takes it straight from the reply.

import { sanitizePrefs, type ModelChoice, type RoutingLevel } from "../../shared/prefs";
import { useGame } from "../store";
import { fetchJson } from "./environment";

export interface PrefsPatch {
  provider?: string | null;
  models?: Record<string, ModelChoice | null>;
  routing?: Record<string, RoutingLevel | null>;
}

export async function patchPrefs(patch: PrefsPatch): Promise<void> {
  const next = await fetchJson<unknown>("/api/prefs", { method: "PATCH", body: JSON.stringify(patch) });
  useGame.setState({ prefs: sanitizePrefs(next) });
}

/** Start new requests on this provider and model (with its options) from now on. */
export function makeDefault(sel: ModelChoice): Promise<void> {
  return patchPrefs({ provider: sel.instanceId, models: { [sel.instanceId]: sel } });
}
