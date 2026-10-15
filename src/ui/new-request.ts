// A new request, from anywhere: which project it's for, and which machine should take it. The
// operator works one agent per request, so starting one is the commonest order there is.

import type { ProjectGroup } from "../game/layout";
import type { EnvWorld } from "../store";
import type { StorageView } from "../../shared/storage";
import { hostView, type HostState } from "../t3/host";
import { storageSummary } from "../t3/storage";
import { isHistory } from "../t3/derive";
import { ROUTING_LEVELS, type RoutingLevel } from "../../shared/prefs";

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

export interface MachineChoice {
  envId: string;
  label: string;
  ok: boolean;
  reason: string;
  score: number;
  /** How eagerly auto-routing picks this machine (see Machines). */
  level: RoutingLevel;
  /** Auto-routing may pick it: reachable, room on disk, and not set to Manual only. */
  auto: boolean;
  /** Its CPU load has been read (routing waits a moment for this). */
  measured: boolean;
}

const WEIGHT = Object.fromEntries(ROUTING_LEVELS.map((l) => [l.id, l.weight])) as Record<RoutingLevel, number>;
const LEVEL_NOTE: Partial<Record<RoutingLevel, string>> = { prefer: "preferred", less: "used less often", manual: "manual only" };

/**
 * Every machine with this project checked out, best first: reachable, its disk not about to fill,
 * open to auto-routing, then the least busy (CPU, then crew working there) scaled by its routing
 * level. Each says why, so the pick is never a mystery.
 */
export function machineChoices(group: ProjectGroup, hosts: Record<string, HostState>, storage: Record<string, StorageView>, routing: Record<string, RoutingLevel> = {}, now = Date.now()): MachineChoice[] {
  return group.members.map(({ env, project }) => {
    const id = env.summary.id;
    const level = routing[id] ?? "normal";
    const live = env.connection === "live";
    const disk = storageSummary(storage[id], now);
    const cpu = hostView(hosts[id], env.connection, now).cpuFraction;
    const working = working_(env, project.id);
    const full = disk.level === "critical";
    const parts = [
      cpu !== undefined ? `${Math.round(cpu * 100)}% CPU` : "CPU unknown",
      disk.usedFraction !== undefined ? `disk ${Math.round(disk.usedFraction * 100)}%${full ? " (nearly full)" : ""}` : undefined,
      working ? `${working} working here` : "nobody working here",
      LEVEL_NOTE[level],
    ].filter(Boolean);
    const ok = live && !full;
    const reason = live ? parts.join(" · ") : "unreachable";
    // Tiers first (unreachable last, then a full disk, then Manual only), then load within a tier:
    // Prefer halves a machine's load, Less often doubles it.
    const tier = !live ? 3 : full ? 2 : level === "manual" ? 1 : 0;
    const load = ((cpu ?? 0.5) * 10 + working) * (WEIGHT.normal / (WEIGHT[level] || WEIGHT.normal));
    const score = tier * 1000 + load;
    return { envId: id, label: env.summary.label, ok, reason, score, level, auto: ok && level !== "manual", measured: cpu !== undefined };
  }).sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
}

function working_(env: EnvWorld, projectId: string): number {
  return Object.values(env.threads).filter((t) => t.projectId === projectId && !isHistory(t) && t.latestTurn?.state === "running").length;
}
