// A new request, from anywhere: which project it's for, and which machine should take it. The
// operator works one agent per request, so starting one is the commonest order there is.

import type { ProjectGroup } from "../game/layout";
import type { EnvWorld } from "../store";
import type { StorageView } from "../../shared/storage";
import { hostView, type HostState } from "../t3/host";
import { storageSummary } from "../t3/storage";
import { isHistory } from "../t3/derive";

const LAST_KEY = "t3c:new-request:last";

/** When a project last had work: its threads' latest update on any machine. */
export function lastActive(group: ProjectGroup): number {
  let at = 0;
  for (const m of group.members) for (const t of Object.values(m.env.threads)) {
    if (t.projectId === m.project.id && !isHistory(t)) at = Math.max(at, Date.parse(t.updatedAt) || 0);
  }
  return at;
}

/** Projects, the one you last started a request in first, then the most recently active. */
export function projectOrder(groups: ProjectGroup[], last = lastProject()): ProjectGroup[] {
  return [...groups].sort((a, b) => Number(b.key === last) - Number(a.key === last) || lastActive(b) - lastActive(a) || a.name.localeCompare(b.name));
}

export function lastProject(): string | undefined {
  try { return localStorage.getItem(LAST_KEY) ?? undefined; } catch { return undefined; }
}
export function rememberProject(key: string): void {
  try { localStorage.setItem(LAST_KEY, key); } catch { /* per-browser convenience */ }
}

export interface MachineChoice { envId: string; label: string; ok: boolean; reason: string; score: number }

/**
 * Every machine with this project checked out, best first: reachable, its disk not about to fill,
 * then the least busy (CPU, then crew working there). Each says why, so the pick is never a mystery.
 */
export function machineChoices(group: ProjectGroup, hosts: Record<string, HostState>, storage: Record<string, StorageView>, now = Date.now()): MachineChoice[] {
  return group.members.map(({ env, project }) => {
    const id = env.summary.id;
    const live = env.connection === "live";
    const disk = storageSummary(storage[id], now);
    const cpu = hostView(hosts[id], env.connection, now).cpuFraction;
    const working = working_(env, project.id);
    const full = disk.level === "critical";
    const parts = [
      cpu !== undefined ? `${Math.round(cpu * 100)}% CPU` : "CPU unknown",
      disk.usedFraction !== undefined ? `disk ${Math.round(disk.usedFraction * 100)}%${full ? " (nearly full)" : ""}` : undefined,
      working ? `${working} working here` : "nobody working here",
    ].filter(Boolean);
    const ok = live && !full;
    const reason = live ? parts.join(" · ") : "unreachable";
    const score = (live ? 0 : 1000) + (full ? 100 : 0) + (cpu ?? 0.5) * 10 + working;
    return { envId: id, label: env.summary.label, ok, reason, score };
  }).sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
}

function working_(env: EnvWorld, projectId: string): number {
  return Object.values(env.threads).filter((t) => t.projectId === projectId && !isHistory(t) && t.latestTurn?.state === "running").length;
}
