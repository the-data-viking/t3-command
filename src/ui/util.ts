import type { EnvWorld } from "../store";
import { isHistory, unitState, type UnitState } from "../t3/derive";
import type { ThreadShell } from "../t3/types";

export const STATE_LABELS: Record<UnitState, string> = {
  alert: "Needs approval",
  question: "Has a question",
  working: "Working",
  error: "Hurt",
  done: "Report ready",
  idle: "Idle",
  sleeping: "In camp",
};

export function modelName(env: EnvWorld | undefined, thread: ThreadShell): string {
  const provider = env?.providers.find((p) => p.instanceId === thread.modelSelection.instanceId);
  const model = provider?.models.find((m) => m.slug === thread.modelSelection.model);
  return model?.name ?? thread.modelSelection.model;
}

export function providerName(env: EnvWorld | undefined, instanceId: string): string {
  const provider = env?.providers.find((p) => p.instanceId === instanceId);
  return provider?.displayName ?? instanceId;
}

export interface UnitRef {
  envId: string;
  thread: ThreadShell;
  state: UnitState;
}

export function allUnits(envs: Record<string, EnvWorld>): UnitRef[] {
  const units: UnitRef[] = [];
  for (const env of Object.values(envs)) {
    for (const thread of Object.values(env.threads)) {
      if (isHistory(thread)) continue;
      units.push({ envId: env.summary.id, thread, state: unitState(thread) });
    }
  }
  return units;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
