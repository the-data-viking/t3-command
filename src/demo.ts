// A fixed demo fleet for development and layout checks: open the dev server with `?demo`. It fills
// the store directly and answers the few HTTP reads the UI makes, so nothing talks to a real T3
// server or agent. Dev builds only (import.meta.env.DEV).

import { summarizeHistory, type TurnRecord } from "../shared/history";
import type { HostHistory } from "../shared/host";
import type { StorageView } from "../shared/storage";
import type { EnvWorld } from "./store";
import { useGame } from "./store";
import type { ProjectShell, ThreadShell } from "./t3/types";

export const DEMO = !!import.meta.env?.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).has("demo");

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const GB = 1024 ** 3;

const project = (id: string, title: string): ProjectShell => ({
  id, title, workspaceRoot: `/work/${id}`, repositoryIdentity: { canonicalKey: `github.com/demo/${id}`, name: id },
  defaultModelSelection: null, createdAt: ago(9000), updatedAt: ago(10),
});

function thread(id: string, projectId: string, title: string, state: "working" | "alert" | "question" | "done" | "error" | "monitoring" | "background" | "sleeping", startedMin: number, model = "claude-opus-5-5", instanceId = "claudeAgent"): ThreadShell {
  const running = state === "working" || state === "alert" || state === "question";
  return {
    id, projectId, title, modelSelection: { instanceId, model }, runtimeMode: "full-access", interactionMode: "default",
    branch: `t3/${id}`, worktreePath: null,
    latestTurn: { turnId: `${id}-t`, state: state === "error" ? "error" : running ? "running" : "completed", requestedAt: ago(startedMin), startedAt: ago(startedMin), completedAt: running ? null : ago(Math.max(0, startedMin - 20)), assistantMessageId: null },
    session: { threadId: id, status: state === "background" ? "running" : running ? "running" : state === "error" ? "error" : "ready", providerName: instanceId, runtimeMode: "full-access", activeTurnId: running ? `${id}-t` : null, lastError: state === "error" ? "Command failed: npm test exited 1" : null, updatedAt: ago(1) },
    latestUserMessageAt: ago(startedMin), hasPendingApprovals: state === "alert", hasPendingUserInput: state === "question",
    backgroundLiveness: state === "monitoring" ? "monitoring" : null,
    planProgress: state === "working" ? { step: "Write the layout check", completedSteps: 2, totalSteps: 5 } : null,
    createdAt: ago(startedMin + 60), updatedAt: ago(state === "working" ? 1 : startedMin), archivedAt: null,
    settledAt: state === "sleeping" ? ago(30) : null, unsettledAt: null, snoozedUntil: null, pinnedAt: null,
  };
}

function env(id: string, label: string, projects: ProjectShell[], threads: ThreadShell[]): EnvWorld {
  return {
    summary: { id, label, url: `https://${id}.demo`, status: "ok", serverVersion: "0.0.45", protocolVersion: 1, addedAt: ago(20000) },
    connection: "live", synced: true,
    projects: Object.fromEntries(projects.map((p) => [p.id, p])),
    threads: Object.fromEntries(threads.map((t) => [t.id, t])),
    providers: [],
  };
}

function fleet(): Record<string, EnvWorld> {
  const stone = project("stone", "the-living-stone"), cmd = project("command", "t3-command");
  return {
    mini: env("mini", "Mac mini (local)", [stone, cmd], [
      thread("a1", "command", "Check out the current state of the t3-command interface", "working", 42),
      thread("a2", "stone", "Restore Glassrun Gorge Canyon", "alert", 1300, "gpt-6", "codex"),
      thread("a3", "command", "Clear out stale worktrees", "done", 90),
      thread("a4", "stone", "Old settled thread", "sleeping", 3000),
    ]),
    agent1: env("agent1", "tls-agent-01", [stone], [
      thread("b1", "stone", "I'm considering a 2D top down reimagining of Aurvanga", "working", 130, "gpt-6", "codex"),
      thread("b2", "stone", "Diagnose Hollow Vein client visuals", "question", 15),
      thread("b3", "stone", "Watch the nightly build", "monitoring", 200),
    ]),
    wes: env("wes", "Wesley-Desktop", [stone], [
      thread("c1", "stone", "Update Althing and Synthbench repos", "error", 60),
      thread("c2", "stone", "Background review sweep", "background", 25),
    ]),
  };
}

function records(): TurnRecord[] {
  const out: TurnRecord[] = [];
  for (let d = 0; d < 7; d++) {
    for (let i = 0; i < 4 + (d % 3); i++) {
      const start = NOW - d * 86_400_000 - i * 3_600_000;
      const dur = (10 + i * 7) * 60_000;
      out.push({ envId: "mini", envLabel: "Mac mini (local)", projectId: "command", projectTitle: "t3-command", threadId: `h${d}${i}`, threadTitle: `Demo turn ${d}.${i}`, turnId: `h${d}${i}`,
        provider: "claudeAgent", model: "claude-opus-5-5", startedAt: new Date(start - dur).toISOString(), completedAt: new Date(start).toISOString(), durationMs: dur, waitMs: i === 1 ? 5 * 60_000 : 0,
        outcome: i === 3 ? "error" : "completed", ...(i === 3 ? { error: "npm test exited 1" } : {}) });
    }
  }
  return out;
}

function storage(): Record<string, StorageView> {
  const view = (envId: string, freeGb: number): StorageView => ({ envId, trend: [], latest: { sampledAt: NOW, volumes: [{ mount: "/", totalBytes: 115 * GB, usedBytes: (115 - freeGb) * GB, availableBytes: freeGb * GB }] } });
  return { mini: view("mini", 60), agent1: view("agent1", 2), wes: view("wes", 14) };
}

function hostHistory(envId: string, hours: number): HostHistory {
  const from = NOW - hours * 3_600_000;
  const points = Array.from({ length: 120 }, (_, i) => {
    const at = from + (i / 119) * (NOW - from);
    const cpu = 0.2 + 0.15 * Math.sin(i / 7) + (i % 17 === 0 ? 0.4 : 0);
    return { at, cpu, cpuPeak: Math.min(1, cpu + 0.1), mem: 0.55 + 0.05 * Math.sin(i / 11) };
  });
  return { envId, from, to: NOW, points };
}

/** Answers for the HTTP reads the UI makes; undefined means "not handled in the demo". */
export function demoFetch(path: string): unknown {
  const url = new URL(path, "http://demo");
  if (url.pathname === "/api/me") return { user: "demo", devMode: true };
  if (url.pathname === "/api/envs") return Object.values(fleet()).map((e) => e.summary);
  if (url.pathname === "/api/storage") return Object.values(storage());
  if (url.pathname === "/api/history") {
    const env = { mini: "Mac mini (local)" };
    return summarizeHistory(records(), [{ envId: "mini", from: ago(8 * 1440), to: ago(0) }], env, { days: Number(url.searchParams.get("days") ?? 7), timeZone: "UTC", now: NOW });
  }
  if (url.pathname === "/api/hosts/history") return hostHistory(url.searchParams.get("envId") ?? "", Number(url.searchParams.get("hours") ?? 24));
  if (url.pathname === "/api/update") return { enabled: false, phase: "idle", reason: "Demo fleet" };
  return undefined;
}

export function loadDemoFleet(): void {
  const envs = fleet();
  useGame.setState({
    me: { user: "demo", devMode: true },
    envs,
    storage: storage(),
    hosts: Object.fromEntries(Object.keys(envs).map((id, i) => [id, { history: [], snapshot: { sampledAt: Date.now(), cpuUtilization: 0.2 + i * 0.25, cpuCount: 8, availableMemoryBytes: 8 * GB, totalMemoryBytes: 24 * GB } }])),
  });
}
