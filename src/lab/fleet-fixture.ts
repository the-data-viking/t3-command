// A made-up fleet of any size for the scale lab: machines, Hermes, and projects that are busy, resting
// or long quiet. Deterministic for a given size, so two layouts can be compared on the same fleet.

import type { EnvWorld, GameState } from "../store";
import type { ProjectShell, ThreadShell } from "../t3/types";

export interface FleetSpec {
  machines: number;
  projects: number;
  /** Projects with crew awake right now. */
  active: number;
  /** Of the rest, how many worked in the last three days (the others have been quiet for weeks). */
  resting: number;
  hermes: boolean;
}

export const FLEET_PRESETS: Array<{ name: string; spec: FleetSpec }> = [
  { name: "Today", spec: { machines: 7, projects: 5, active: 2, resting: 3, hermes: true } },
  { name: "Near term", spec: { machines: 10, projects: 20, active: 6, resting: 8, hermes: true } },
  { name: "Growth", spec: { machines: 12, projects: 30, active: 8, resting: 10, hermes: true } },
  { name: "Stress", spec: { machines: 16, projects: 40, active: 12, resting: 12, hermes: true } },
];

const MACHINE_NAMES = ["Mac mini (local)", "tls-agent-01", "tls-agent-02", "tls-agent-03", "Wesley-Desktop", "tls-mani", "tls-sol",
  "tls-agent-04", "tls-agent-05", "build-farm", "gpu-box", "tls-agent-06", "studio-mbp", "tls-agent-07", "ci-runner", "tls-agent-08"];
const PROJECT_NAMES = ["The Living Stone", "T3 Command", "Dataviking Infra", "Job Data Platform", "SynthBench", "Hollow Vein", "Glassrun Gorge",
  "AI Gateway", "Fleet Ops", "Storage Reclaim", "Mobile Shell", "Pixel Forge", "Ledger Sync", "Atlas Docs", "Signal Relay", "Model Bench",
  "Night Market", "Coldframe", "Quarry", "Lumen API", "Tidewater", "Orbit CRM", "Harbor CI", "Ember UI", "Kestrel Kit", "Waypoint",
  "Driftwood", "Basalt DB", "Copperline", "Starling", "Northwind", "Halcyon", "Foundry", "Vantage", "Parallax", "Meridian", "Sundial",
  "Lattice", "Keystone", "Marrow"];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function makeFleet(spec: FleetSpec, now: number): GameState {
  const random = rng(spec.machines * 1000 + spec.projects * 31 + spec.active * 7 + spec.resting);
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const envs: Record<string, EnvWorld> = {};
  const env = (id: string, label: string, addedAt: string, kind?: "hermes"): EnvWorld => ({
    summary: { id, label, url: "", status: "connected", addedAt, ...(kind ? { kind } : {}) },
    connection: "connected", synced: true, projects: {}, threads: {}, providers: [],
  } as unknown as EnvWorld);
  for (let m = 0; m < spec.machines; m++) envs[`m${m}`] = env(`m${m}`, MACHINE_NAMES[m] ?? `machine-${m}`, `2026-01-${String(m + 1).padStart(2, "0")}`);
  if (spec.hermes) envs.hermes = env("hermes", "Hermes", "2025-12-01", "hermes");

  const thread = (id: string, projectId: string, kind: "working" | "monitoring" | "done" | "question" | "settled", updatedAgo: number, extra: Partial<ThreadShell> = {}): ThreadShell => {
    const running = kind === "working" || kind === "question";
    return {
      id, projectId, title: id, modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", interactionMode: "default",
      branch: null, worktreePath: null,
      latestTurn: { turnId: `${id}-t`, state: running ? "running" : "completed", requestedAt: iso(updatedAgo + HOUR), startedAt: iso(updatedAgo + HOUR), completedAt: running ? null : iso(updatedAgo), assistantMessageId: null },
      session: { threadId: id, status: running ? "running" : "ready", providerName: "claudeAgent", runtimeMode: "full-access", activeTurnId: running ? `${id}-t` : null, lastError: null, updatedAt: iso(updatedAgo) },
      latestUserMessageAt: iso(updatedAgo + HOUR), hasPendingApprovals: false, hasPendingUserInput: kind === "question",
      backgroundLiveness: kind === "monitoring" ? "monitoring" : null, planProgress: null,
      createdAt: iso(updatedAgo + 2 * HOUR), updatedAt: iso(updatedAgo), archivedAt: null,
      settledAt: kind === "settled" ? iso(updatedAgo) : null, unsettledAt: null, snoozedUntil: null, pinnedAt: null,
      ...extra,
    } as ThreadShell;
  };

  const machines = Object.keys(envs).filter((id) => id !== "hermes");
  const active = Math.min(spec.active, spec.projects);
  const resting = Math.min(spec.resting, spec.projects - active);
  for (let p = 0; p < spec.projects; p++) {
    if (!machines.length) break;
    const id = `p${p}`;
    const name = PROJECT_NAMES[p] ?? `Project ${p + 1}`;
    // Every fourth project is shared by two or three machines; the first one by five, like The Living Stone.
    const owners = p === 0 ? Math.min(5, machines.length) : p % 4 === 0 ? Math.min(2 + (p % 8 === 0 ? 1 : 0), machines.length) : 1;
    const base = Math.floor(random() * machines.length);
    const served = Array.from({ length: owners }, (_, k) => machines[(base + k * 3) % machines.length]).filter((v, i, a) => a.indexOf(v) === i);
    const tier = p < active ? "active" : p < active + resting ? "resting" : "dormant";
    served.forEach((envId, k) => {
      const project: ProjectShell = { id, title: name, workspaceRoot: `/work/${id}`, repositoryIdentity: { canonicalKey: `github.com/fleet/${id}`, name }, defaultModelSelection: null, createdAt: iso(90 * DAY), updatedAt: iso(DAY) } as ProjectShell;
      envs[envId].projects[id] = project;
      const add = (t: ThreadShell) => { envs[envId].threads[t.id] = t; };
      if (tier === "active" && (k === 0 || random() < 0.5)) {
        const crew = p === 0 && k === 0 ? 4 : 1 + Math.floor(random() * 3);
        for (let c = 0; c < crew; c++) {
          const roll = random();
          add(thread(`${id}-${envId}-a${c}`, id, roll < 0.55 ? "working" : roll < 0.75 ? "monitoring" : roll < 0.92 ? "done" : "question", random() * 40 * MIN));
        }
      }
      // Settled crew everywhere: recent for busy and resting projects, weeks old for quiet ones.
      const settledAgo = tier === "dormant" ? (8 + random() * 40) * DAY : tier === "resting" ? (1 + random() * 60) * HOUR : (1 + random() * 20) * HOUR;
      const settled = tier === "dormant" ? Math.floor(random() * 3) : 1 + Math.floor(random() * 3);
      for (let c = 0; c < settled; c++) add(thread(`${id}-${envId}-s${c}`, id, "settled", settledAgo + c * HOUR));
    });
  }
  if (spec.hermes) {
    for (const profile of ["maintenance", "money-guy"]) {
      const t = thread(`hermes-${profile}`, "hermes", "done", 2 * HOUR, { hermesProfile: profile } as Partial<ThreadShell>);
      envs.hermes.threads[t.id] = t;
    }
  }
  return { envs, memory: {} } as unknown as GameState;
}
