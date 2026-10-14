// A fixed demo fleet for development and layout checks: open the dev server with `?demo`. It fills
// the store directly and answers the few HTTP reads the UI makes, so nothing talks to a real T3
// server or agent. Dev builds only (import.meta.env.DEV).

import { summarizeHistory, type TurnRecord } from "../shared/history";
import type { HostHistory } from "../shared/host";
import type { StorageView } from "../shared/storage";
import type { Dispatch, DispatchHow } from "../shared/dispatches";
import { DEFAULT_PLAYBOOKS } from "../shared/playbooks";
import { memoryOf } from "../shared/memory";
import type { EnvWorld, GameState } from "./store";
import { useGame } from "./store";
import type { OrchestrationThread, ProjectShell, Provider, ThreadShell } from "./t3/types";

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
    // Wesley-Desktop runs the T3 desktop app one release behind; the others update via the T3 service.
    summary: { id, label, url: `https://${id}.demo`, status: "ok", serverVersion: id === "wes" ? "0.0.44" : "0.0.45", protocolVersion: 1, addedAt: ago(20000),
      selfUpdate: id === "wes" ? { method: "desktop-managed", desktopAppUpdate: true, continuesThreads: true } : { method: "boot-service", desktopAppUpdate: false, continuesThreads: true } },
    connection: "live", synced: true,
    projects: Object.fromEntries(projects.map((p) => [p.id, p])),
    threads: Object.fromEntries(threads.map((t) => [t.id, t])),
    providers: providers(id),
  };
}

/** A local Hermes base with two operators: one working, one with a report ready. */
function hermesEnv(): EnvWorld {
  const ws = project("hermes-ws", "hermes-workspace");
  const op = (id: string, profile: string, title: string, state: "working" | "done") => ({ ...thread(id, ws.id, title, state, 30), hermesProfile: profile });
  const e = env("hermes", "Hermes", [ws], [op("h1", "default", "Morning briefing", "working"), op("h2", "money-guy", "Budget review", "done")]);
  return { ...e, summary: { ...e.summary, kind: "hermes", url: "/work/hermes" }, providers: [] };
}

/** Codex reports a weekly and a 5-hour quota on one machine and fails on another; Claude reports none. */
function providers(envId: string): Provider[] {
  const base = { enabled: true, installed: true, status: "ready", models: [] };
  const codex = envId === "mini"
    ? { ...base, instanceId: "codex", driver: "codex", displayName: "Codex", usageLimits: { checkedAt: ago(1), windows: [{ id: "w", kind: "weekly", label: "Weekly", usedPercent: 28, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() }, { id: "s", kind: "session", label: "5-hour", usedPercent: 82, resetsAt: new Date(NOW + 72 * 60_000).toISOString() }] } }
    : { ...base, instanceId: "codex", driver: "codex", displayName: "Codex", usageLimits: { checkedAt: ago(1), windows: [], unavailable: { reason: "probeFailed", message: "JSON-RPC -32600" } } };
  const claude = { ...base, instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude", usageLimits: { checkedAt: ago(1), windows: [], unavailable: { reason: "unsupported" } } };
  return [codex, claude] as unknown as Provider[];
}

function fleet(): Record<string, EnvWorld> {
  const stone = project("stone", "the-living-stone"), cmd = project("command", "t3-command");
  return {
    mini: env("mini", "Mac mini (local)", [stone, cmd], [
      thread("a1", "command", "Check out the current state of the t3-command interface", "working", 42),
      thread("a2", "stone", "Restore Glassrun Gorge Canyon", "alert", 1300, "gpt-6", "codex"),
      { ...thread("a3", "command", "Clear out stale worktrees", "done", 90), pullRequests: [{ host: "github.com", repository: "demo/command", number: 72, url: "https://github.com/demo/command/pull/72",
        snapshot: { state: "open", title: "Remove stale worktrees", headBranch: "t3/a3", baseBranch: "main", isDraft: false, additions: 14, deletions: 212, changedFiles: 6, checksState: "passing", reviewDecision: null } }] } as ThreadShell,
      // A long-lived thread whose merged PRs are tallied on the Living Stone's hull.
      { ...thread("a4", "stone", "Old settled thread", "sleeping", 3000), pullRequests: Array.from({ length: 12 }, (_, k) => ({ host: "github.com", repository: "demo/stone", number: 40 + k, url: `https://github.com/demo/stone/pull/${40 + k}`,
        snapshot: { state: "merged", title: `Stone change ${k + 1}`, headBranch: `t3/s${k}`, baseBranch: "main", isDraft: false } })) } as ThreadShell,
      { ...thread("a5", "stone", "Imported: first pass at the canyon", "sleeping", 9000), latestTurn: null, session: null, latestUserMessageAt: null } as ThreadShell,
    ]),
    agent1: env("agent1", "tls-agent-01", [stone], [
      // Open PRs dock at the Living Stone as cargo pods: one passing, one failing, one draft.
      { ...thread("b1", "stone", "I'm considering a 2D top down reimagining of Aurvanga", "working", 130, "gpt-6", "codex"), pullRequests: [
        { host: "github.com", repository: "demo/stone", number: 61, url: "https://github.com/demo/stone/pull/61", snapshot: { state: "open", title: "Top-down tile renderer", headBranch: "t3/b61", baseBranch: "main", isDraft: false, checksState: "passing" } },
        { host: "github.com", repository: "demo/stone", number: 62, url: "https://github.com/demo/stone/pull/62", snapshot: { state: "open", title: "Aurvanga map import", headBranch: "t3/b62", baseBranch: "main", isDraft: false, checksState: "failing" } },
        { host: "github.com", repository: "demo/stone", number: 63, url: "https://github.com/demo/stone/pull/63", snapshot: { state: "open", title: "Sketch: lighting pass", headBranch: "t3/b63", baseBranch: "main", isDraft: true, checksState: null } },
      ] } as ThreadShell,
      thread("b2", "stone", "Diagnose Hollow Vein client visuals", "question", 15),
      thread("b3", "stone", "Watch the nightly build", "monitoring", 200),
    ]),
    hermes: hermesEnv(),
    wes: env("wes", "Wesley-Desktop", [stone], [
      thread("c1", "stone", "Update Althing and Synthbench repos", "error", 60),
      thread("c2", "stone", "Background review sweep", "background", 25),
    ]),
    // A machine that has dropped off: its crew show last-known state, greyed, with no signal.
    lab: { ...env("lab", "lab-runner", [project("lab", "lab-tools")], [
      thread("d1", "lab", "Profile the nightly import", "working", 50),
    ]), connection: "reconnecting" },
  };
}

function records(): TurnRecord[] {
  const out: TurnRecord[] = [];
  for (let d = 0; d < 7; d++) {
    for (let i = 0; i < 4 + (d % 3); i++) {
      const start = NOW - d * 86_400_000 - i * 3_600_000;
      const dur = (10 + i * 7) * 60_000;
      out.push({ envId: "mini", envLabel: "Mac mini (local)", projectId: "command", projectTitle: "t3-command", threadId: `h${d}${i}`, threadTitle: `Demo turn ${d}.${i}`, turnId: `h${d}${i}`,
        provider: "claudeAgent", model: "claude-opus-5-5", startedAt: new Date(start - dur).toISOString(), completedAt: new Date(start).toISOString(), durationMs: dur, waitMs: i === 1 ? 5 * 60_000 : 0, ...(i === 1 ? { waits: [[start - dur + 4 * 60_000, start - dur + 9 * 60_000]] as Array<[number, number]> } : {}),
        outcome: i === 3 ? "error" : "completed", ...(i === 3 ? { error: "npm test exited 1" } : {}) });
    }
  }
  return out;
}

function storage(): Record<string, StorageView> {
  const view = (envId: string, freeGb: number): StorageView => ({ envId, trend: [], latest: { sampledAt: NOW, volumes: [{ mount: "/", totalBytes: 115 * GB, usedBytes: (115 - freeGb) * GB, availableBytes: freeGb * GB }] } });
  // Wesley-Desktop's disk is filling (a build cache growing): about 1.5% an hour, so full in ~8h.
  const filling = Array.from({ length: 73 }, (_, i) => ({ at: NOW - (72 - i) * 300_000, usedFraction: (115 - 14) / 115 - 0.015 * ((72 - i) / 12) }));
  return { mini: view("mini", 60), agent1: view("agent1", 2), wes: { ...view("wes", 14), trend: filling } };
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
  if (url.pathname === "/api/history/timeline") {
    const hours = Number(url.searchParams.get("hours") ?? 24), from = NOW - hours * 3_600_000;
    return { from, to: NOW, turns: records().filter((r) => Date.parse(r.completedAt) >= from) };
  }
  if (url.pathname === "/api/hosts/history") return hostHistory(url.searchParams.get("envId") ?? "", Number(url.searchParams.get("hours") ?? 24));
  if (url.pathname === "/api/update") return { enabled: false, phase: "idle", reason: "Demo fleet" };
  if (url.pathname === "/api/playbooks") return DEFAULT_PLAYBOOKS;
  // Station memory: a busy Living Stone with a few scars, a lab that mostly fails.
  if (url.pathname === "/api/memory") return { ...memoryOf(records(), 0), "mini:stone": { completed: 23, failed: 3 }, "agent1:stone": { completed: 9, failed: 1 }, "lab:lab": { completed: 2, failed: 5 } };
  return undefined;
}

/** Thread details for the crew waiting on you, so their requests show in the roster and event card. */
function demoDetails(envs: Record<string, EnvWorld>): GameState["details"] {
  const detail = (envId: string, threadId: string, minutesAgo: number, kind: "approval" | "user-input", payload: Record<string, unknown>, transcript: { order?: string; said?: string; tools?: string[] } = {}) => {
    const shell = envs[envId].threads[threadId];
    const turnId = shell.latestTurn?.turnId ?? null;
    const at = (m: number) => ago(minutesAgo + m);
    const messages = [
      ...(transcript.order ? [{ id: `${threadId}-u`, role: "user", text: transcript.order, turnId, streaming: false, createdAt: at(30), updatedAt: at(30) }] : []),
      ...(transcript.said ? [{ id: `${threadId}-a`, role: "assistant", text: transcript.said, turnId, streaming: false, createdAt: at(1), updatedAt: at(1) }] : []),
    ];
    const tools = (transcript.tools ?? []).map((t, i) => ({ id: `${threadId}-tool${i}`, tone: "tool", kind: "tool.completed", summary: t, createdAt: at(10 - i * 3), turnId, payload: { toolCallId: `call${i}`, detail: t } }));
    const thread = { ...shell, messages, checkpoints: [], activities: [
      ...tools,
      { id: `${threadId}-req`, tone: "approval", kind: `${kind}.requested`, summary: "", createdAt: ago(minutesAgo), turnId: shell.latestTurn?.turnId ?? null, payload: { requestId: `${threadId}-req`, ...payload } },
    ] } as unknown as OrchestrationThread;
    return [`${envId}:${threadId}`, { thread, synced: true }] as const;
  };
  // A finished job with a written report, changes and a PR, for the debrief card.
  const done = envs.mini.threads.a3;
  const report = { ...done, activities: [], messages: [{ id: "a3-m", role: "assistant", turnId: done.latestTurn?.turnId ?? null, streaming: false, createdAt: ago(70), updatedAt: ago(70),
    text: "Removed 9 stale worktrees under ~/.t3/worktrees (all merged or abandoned, none with uncommitted work).\n\n- Kept 3 active worktrees with open threads.\n- Added `npm run prune-worktrees` so this can be repeated.\n- Opened PR #72; checks are green." }],
    checkpoints: [{ turnId: done.latestTurn?.turnId ?? "", checkpointTurnCount: 1, status: "ready", completedAt: ago(70), files: [
      { path: "tools/prune-worktrees.mjs", kind: "added", additions: 12, deletions: 0 }, { path: "package.json", kind: "modified", additions: 2, deletions: 0 },
      { path: "docs/worktrees.md", kind: "modified", additions: 0, deletions: 212 } ] }] } as unknown as OrchestrationThread;
  return Object.fromEntries([
    ["mini:a3", { thread: report, synced: true }] as const,
    detail("mini", "a2", 22, "approval", { requestKind: "command", detail: "pnpm migrate --force" }, {
      order: "Restore the Glassrun Gorge Canyon level data from last week's backup and make sure the game loads it.",
      said: "The backup restored cleanly, but the save schema is two versions behind. I need to run the pending migrations against the local dev database before the loader will accept it.",
      tools: ["cp backups/glassrun-2026-10-06.db data/levels.db", "pnpm test -- levels/loader", "cat prisma/migrations/0042_canyon_props/migration.sql"],
    }),
    detail("agent1", "b2", 9, "user-input", { questions: [{ id: "env", question: "Which environment should the client build target?", options: [{ label: "Staging" }, { label: "Production" }] }] }),
  ]);
}

/** A morning's comms: what the away briefing and the comms log show. */
function demoLog(): GameState["log"] {
  const at = (min: number) => NOW - min * 60_000;
  const e = (id: number, min: number, tone: GameState["log"][number]["tone"], kind: NonNullable<GameState["log"][number]["kind"]>, text: string, envId?: string, threadId?: string) =>
    ({ id: `s${id}`, at: at(min), tone, kind, text, envId, threadId });
  return [
    e(1, 95, "info", "started", "\"Clear out stale worktrees\" started work", "mini", "a3"),
    e(2, 70, "good", "done", "\"Clear out stale worktrees\" finished", "mini", "a3"),
    e(3, 65, "good", "merged", "\"Clear out stale worktrees\": PR #72 merged (Remove stale worktrees)", "mini", "a3"),
    e(4, 60, "bad", "failed", "\"Update Althing and Synthbench repos\" failed: Command failed: npm test exited 1", "wes", "c1"),
    e(5, 50, "info", "started", "\"Profile the nightly import\" started work", "lab", "d1"),
    e(6, 45, "bad", "offline", "Lost contact with lab-runner", "lab"),
    e(7, 22, "alert", "approval", "\"Restore Glassrun Gorge Canyon\" needs your approval", "mini", "a2"),
    e(8, 9, "alert", "question", "\"Diagnose Hollow Vein client visuals\" has a question", "agent1", "b2"),
  ];
}

export function loadDemoFleet(): void {
  const envs = fleet();
  useGame.setState({
    me: { user: "demo", devMode: true },
    envs,
    hermesCatalog: { envId: "hermes", loaded: true, bots: [
      { name: "default", title: "default", description: "", model: null, provider: null, skillCount: 0, isDefault: true },
      { name: "money-guy", title: "Money Guy", description: "", model: null, provider: null, skillCount: 0, isDefault: false },
    ] },
    storage: storage(),
    details: demoDetails(envs),
    log: demoLog(),
    hosts: Object.fromEntries(Object.keys(envs).map((id, i) => [id, { history: [], snapshot: { sampledAt: Date.now(), cpuUtilization: 0.2 + i * 0.25, cpuCount: 8, availableMemoryBytes: 8 * GB, totalMemoryBytes: 24 * GB } }])),
    dispatches: demoDispatches(envs),
    // A standing order: the 2D reimagining keeps going, two more turns after this one.
    followUps: { paused: false, queued: [{ id: "demo-standing", envId: "agent1", threadId: "b1", afterTurnId: envs.agent1.threads.b1.latestTurn?.turnId ?? null,
      text: "Keep going with the next step of your plan; stop and report if you're blocked.", createdAt: NOW - 3_600_000, expiresAt: NOW + 8 * 3_600_000, left: 2, total: 4 }] },
  });
}

/** A squad order playing out: one working, one waiting on you, one reported, one not started, one never sent. */
function demoDispatches(envs: Record<string, EnvWorld>): Dispatch[] {
  const member = (envId: string, threadId: string, how: DispatchHow, started: boolean) => {
    const t = envs[envId].threads[threadId];
    return { envId, threadId, title: t.title, how, baseTurnId: started ? "before" : t.latestTurn?.turnId ?? null };
  };
  const parted = (envId: string, threadId: string, how: DispatchHow, started: boolean, part: string) => ({ ...member(envId, threadId, how, started), part });
  return [{ id: "demo-mission", at: NOW - 25 * 60_000, text: "Aurvanga plays top-down: tiles, the imported map and lighting together, at 60 fps on the dev machine.",
    mission: { name: "Aurvanga top-down", goal: "Aurvanga plays top-down: tiles, the imported map and lighting together, at 60 fps on the dev machine." },
    members: [parted("agent1", "b1", "sent", true, "The tile renderer and camera"), parted("agent1", "b2", "sent", true, "Hollow Vein's client visuals in the new view"), parted("agent1", "b3", "sent", false, "Keep the nightly build green while it lands")],
  }, { id: "demo-dispatch", at: NOW - 40 * 60_000, text: "Give me a short status: where you are, what's left, and anything blocking you or needing my decision.", members: [
    member("mini", "a1", "sent", true), member("agent1", "b2", "sent", true), member("mini", "a3", "sent", true),
    member("lab", "d1", "sent", false), member("wes", "c1", "failed", false),
  ] }];
}

/** The demo's review of "Clear out stale worktrees": its branch diff and PR #72 with checks. */
export function demoReview(): { diff: string; pr: import("./t3/types").PullRequestDetail } {
  const diff = [
    "diff --git a/tools/prune-worktrees.mjs b/tools/prune-worktrees.mjs", "new file mode 100644", "--- /dev/null", "+++ b/tools/prune-worktrees.mjs",
    "@@ -0,0 +1,6 @@", "+#!/usr/bin/env node", "+// Remove T3 worktrees whose branches are merged or abandoned.", "+import { pruneMerged } from './worktrees.mjs';", "+const removed = await pruneMerged({ dryRun: process.argv.includes('--dry-run') });", "+console.log(`Removed ${removed.length} worktrees`);", "+",
    "diff --git a/package.json b/package.json", "--- a/package.json", "+++ b/package.json", "@@ -8,6 +8,7 @@", "   \"scripts\": {", "     \"test\": \"node --test\",", "+    \"prune-worktrees\": \"node tools/prune-worktrees.mjs\",", "     \"lint\": \"eslint .\"",
  ].join("\n");
  const pr = { repository: "demo/command", number: 72, title: "Remove stale worktrees", body: "", url: "https://github.com/demo/command/pull/72", state: "open", isDraft: false,
    mergeability: "mergeable", additions: 14, deletions: 212, changedFiles: 6, headBranch: "t3/a3", baseBranch: "main", mergedAt: null,
    reviewers: [{ login: "njord", name: null }], baseComparison: "behind", behindBy: 3,
    checks: [{ name: "test", status: "success", description: null, url: null }, { name: "lint", status: "success", description: null, url: null }, { name: "e2e", status: "pending", description: "Queued", url: null }] } as import("./t3/types").PullRequestDetail;
  return { diff, pr };
}
