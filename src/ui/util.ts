import type { EnvWorld } from "../store";
import { isHistory, unitState, type UnitState } from "../t3/derive";
import type { ThreadShell } from "../t3/types";

export const STATE_LABELS: Record<UnitState, string> = {
  alert: "Needs approval",
  question: "Has a question",
  working: "Working",
  monitoring: "Monitoring",
  error: "Failed",
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

/**
 * "Working" without a running turn: the session or background agents are still going after the
 * turn ended. Shown as Background so it doesn't read as a turn that's also "Last turn 28s".
 */
export function isBackground(thread: ThreadShell, state: UnitState): boolean {
  return state === "working" && thread.latestTurn?.state !== "running";
}

/** A crew member's state as shown in lists (adds Background to the map's states). */
export function stateLabel(thread: ThreadShell, state: UnitState): string {
  // A plan-mode crew member's finished turn is a plan waiting for approval, not a report.
  if (state === "done" && thread.interactionMode === "plan") return "Plan ready";
  return isBackground(thread, state) ? "Background" : STATE_LABELS[state];
}

export interface FleetCounts { working: number; background: number; monitoring: number; waiting: number; reports: number; failed: number; crew: number; awake: number }

/** A finished turn's report that's been marked read in this browser (until the next turn). */
export function reportRead(readReports: Record<string, string>, envId: string, thread: ThreadShell): boolean {
  const turn = thread.latestTurn?.turnId;
  return !!turn && readReports[`${envId}:${thread.id}`] === turn;
}

/** One count for the top bar, the phone dock and the tab title: Hermes sessions included. */
export function fleetCounts(envs: Record<string, EnvWorld>, readReports: Record<string, string> = {}): FleetCounts {
  const c: FleetCounts = { working: 0, background: 0, monitoring: 0, waiting: 0, reports: 0, failed: 0, crew: 0, awake: 0 };
  for (const u of allUnits(envs)) {
    if (envs[u.envId]?.summary.kind !== "hermes") {
      c.crew++;
      if (u.state !== "sleeping") c.awake++;
    }
    if (u.state === "working") { if (isBackground(u.thread, u.state)) c.background++; else c.working++; }
    else if (u.state === "monitoring") c.monitoring++;
    else if (u.state === "alert" || u.state === "question") c.waiting++;
    // Reports and failures count as needs-you.ts does: not once seen (Hermes operators' included).
    else if (u.state === "done") { if (u.thread.latestTurn && !reportRead(readReports, u.envId, u.thread)) c.reports++; }
    else if (u.state === "error") { if (u.thread.latestTurn && !reportRead(readReports, u.envId, u.thread)) c.failed++; }
  }
  return c;
}
