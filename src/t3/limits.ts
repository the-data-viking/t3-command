// Provider rate limits across the fleet. Several machines often sign in to the same provider
// account, so identical quota windows are shown once with every machine that reports them.

import type { EnvWorld } from "../store";
import type { GaugeLevel } from "../game/theme";

export interface LimitWindow {
  provider: string;
  label: string;
  usedPercent: number;
  resetsAt?: string;
  machines: string[];
}

/** Why a provider has no quota to show, or a health note it reported. */
export interface LimitNote {
  provider: string;
  text: string;
  machines: string[];
}

export interface FleetLimits {
  windows: LimitWindow[];
  notes: LimitNote[];
  /** The fullest window, if any provider reports one. */
  peak?: number;
  /** How much of the fleet the peak speaks for: provider sign-ins (provider × machine). */
  coverage: { reporting: number; total: number; silent: Array<{ provider: string; machines: string[]; failed: boolean }> };
}

/** Quota use (0–100) → gauge level; quotas warn earlier than host load. */
export function limitLevel(usedPercent: number): GaugeLevel {
  return usedPercent >= 90 ? "critical" : usedPercent >= 75 ? "high" : "ok";
}

export function fleetLimits(envs: EnvWorld[]): FleetLimits {
  const windows = new Map<string, LimitWindow>();
  const notes = new Map<string, LimitNote>();
  const note = (provider: string, text: string, machine: string) => {
    const key = `${provider}|${text}`;
    const existing = notes.get(key);
    if (existing) { if (!existing.machines.includes(machine)) existing.machines.push(machine); }
    else notes.set(key, { provider, text, machines: [machine] });
  };
  let total = 0, reporting = 0;
  const silent = new Map<string, { provider: string; machines: string[]; failed: boolean }>();
  for (const env of envs) {
    const machine = env.summary.label;
    for (const p of env.providers ?? []) {
      if (!p.enabled || p.status === "disabled") continue;
      const provider = p.displayName ?? p.instanceId;
      const limits = p.usageLimits;
      total++;
      if (limits?.windows?.length) reporting++;
      else {
        const failed = limits?.unavailable?.reason === "probeFailed";
        const key = `${provider}|${failed}`;
        const entry = silent.get(key) ?? { provider, machines: [], failed };
        if (!entry.machines.includes(machine)) entry.machines.push(machine);
        silent.set(key, entry);
      }
      for (const w of limits?.windows ?? []) {
        const used = Math.round(w.usedPercent);
        const key = [p.driver, limits?.credentialFingerprint ?? "", w.id, w.label, w.resetsAt ?? "", used].join("|");
        const existing = windows.get(key);
        if (existing) { if (!existing.machines.includes(machine)) existing.machines.push(machine); }
        else windows.set(key, { provider, label: w.label, usedPercent: used, resetsAt: w.resetsAt, machines: [machine] });
      }
      if (limits?.unavailable) {
        note(provider, limits.unavailable.reason === "probeFailed"
          ? `Usage could not be read${limits.unavailable.message ? `: ${limits.unavailable.message}` : ""}`
          : "Usage limits are not reported", machine);
      }
      if (p.message) note(provider, p.message, machine);
    }
  }
  const list = [...windows.values()].sort((a, b) => b.usedPercent - a.usedPercent);
  return { windows: list, notes: [...notes.values()], peak: list.length ? list[0].usedPercent : undefined,
    coverage: { reporting, total, silent: [...silent.values()].sort((a, b) => b.machines.length - a.machines.length) } };
}
