// Compatibility boundary for T3 Code 0.1.0 (orchestration v2). The rest of Command and
// the local Hermes bridge keep Command's existing shell/transcript representation.
// Source: pingdotgg/t3code v0.1.0, packages/contracts/src/orchestrationV2.ts.
import type { Activity, Checkpoint, LatestTurn, Message, ModelSelection, OrchestrationThread, ProjectShell, ShellStreamItem, ThreadShell, ThreadStreamItem } from "../src/t3/types.ts";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const text = (value: unknown): string => typeof value === "string" ? value : "";
const nullableText = (value: unknown): string | null => typeof value === "string" ? value : null;
const active = (status: unknown) => ["preparing", "starting", "running", "waiting"].includes(text(status));
const terminal = (status: unknown) => ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(text(status));
const turnState = (status: unknown): LatestTurn["state"] => status === "failed" ? "error"
  : status === "cancelled" || status === "interrupted" || status === "rolled_back" ? "interrupted"
  : active(status) ? "running" : "completed";

/** v2's latest queued run need not be the run currently doing work. */
export function v2Shell(value: unknown): ThreadShell {
  const t = row(value);
  const request = row(t.pendingRuntimeRequest);
  const status = t.activityRunStatus ?? t.status;
  const runId = nullableText(t.activeRunId) ?? nullableText(t.latestRunId);
  const at = text(t.updatedAt);
  const latestTurn: LatestTurn | null = runId && status !== "queued" ? {
    turnId: runId, state: turnState(status),
    requestedAt: text(t.latestRunRequestedAt) || at,
    startedAt: nullableText(t.activityRunStartedAt) ?? nullableText(t.latestRunStartedAt),
    completedAt: active(status) ? null : nullableText(t.latestRunCompletedAt),
    assistantMessageId: row(t.latestVisibleMessage).role === "assistant" ? nullableText(row(t.latestVisibleMessage).id) : null,
  } : null;
  const background = rows(t.pendingBackgroundTasks);
  return {
    ...t,
    id: text(t.id), projectId: text(t.projectId), title: text(t.title),
    modelSelection: t.modelSelection as ModelSelection,
    runtimeMode: t.runtimeMode as ThreadShell["runtimeMode"], interactionMode: t.interactionMode as ThreadShell["interactionMode"],
    branch: nullableText(t.branch), worktreePath: nullableText(t.worktreePath), latestTurn,
    session: runId || t.activeProviderThreadId ? {
      threadId: text(t.id), providerName: text(t.providerInstanceId), providerInstanceId: text(t.providerInstanceId),
      runtimeMode: t.runtimeMode as ThreadShell["runtimeMode"], activeTurnId: active(status) ? runId : null,
      status: active(status) ? (status === "preparing" || status === "starting" ? "starting" : "running") : status === "failed" ? "error" : "idle",
      lastError: nullableText(t.lastError), updatedAt: at,
    } : null,
    hasPendingUserInput: request.kind === "user_input",
    hasPendingApprovals: !!request.id && request.kind !== "user_input",
    hasActionableProposedPlan: Boolean(t.hasActionableProposedPlan),
    backgroundLiveness: background.length ? (background.some((b) => b.kind === "subagent" || b.kind === "background_task") ? "working" : "monitoring") : null,
    latestUserMessageAt: nullableText(t.latestUserMessageAt),
    createdAt: text(t.createdAt), updatedAt: at, archivedAt: nullableText(t.archivedAt),
    settledAt: nullableText(t.settledAt), unsettledAt: nullableText(t.unsettledAt),
    snoozedUntil: nullableText(t.snoozedUntil), pinnedAt: nullableText(t.pinnedAt),
    pullRequests: (t.pullRequests ?? []) as ThreadShell["pullRequests"],
  };
}

export function v2ShellItems(values: unknown[]): ShellStreamItem[] {
  return values.flatMap((value): ShellStreamItem[] => {
    const item = row(value);
    const sequence = Number(item.sequence);
    switch (item.kind) {
      case "snapshot": {
        const snapshot = row(item.snapshot);
        // T3 also sends snapshot-shaped repository enrichment frames, sometimes for just
        // one workspace. Empty threads here do not mean that the fleet was removed.
        if (Array.isArray(item.resolvedRepositoryIdentityRoots)) return [{ kind: "project-enrichment",
          projects: snapshot.projects as ProjectShell[], resolvedRoots: item.resolvedRepositoryIdentityRoots as string[] }];
        return [{ kind: "snapshot", snapshot: {
          snapshotSequence: Number(snapshot.snapshotSequence), projects: snapshot.projects as Extract<ShellStreamItem, { kind: "snapshot" }>["snapshot"]["projects"],
          threads: rows(snapshot.threads).map(v2Shell),
        } }];
      }
      case "synchronized": return [{ kind: "synchronized" }];
      case "project.updated": return [{ kind: "project-upserted", sequence, project: item.project as Extract<ShellStreamItem, { kind: "project-upserted" }>["project"] }];
      case "project.removed": return [{ kind: "project-removed", sequence, projectId: text(item.projectId) }];
      case "thread.updated": return item.location === "archive" ? [{ kind: "thread-removed", sequence, threadId: text(row(item.thread).id) }]
        : [{ kind: "thread-upserted", sequence, thread: v2Shell(item.thread) }];
      case "thread.removed": return item.location === "archive" ? [] : [{ kind: "thread-removed", sequence, threadId: text(item.threadId) }];
      default: return [];
    }
  });
}

/** Metadata refreshes must not resurrect deleted projects or undo newer project edits. */
export function enrichProjectRepositories(current: Record<string, ProjectShell>, projects: ProjectShell[], resolvedRoots: string[]): Record<string, ProjectShell> {
  let next = current;
  const roots = new Set(resolvedRoots);
  for (const project of projects) {
    const existing = current[project.id];
    if (!existing || existing.workspaceRoot !== project.workspaceRoot || !roots.has(project.workspaceRoot)) continue;
    if (JSON.stringify(existing.repositoryIdentity) === JSON.stringify(project.repositoryIdentity)) continue;
    if (next === current) next = { ...current };
    next[project.id] = { ...existing, repositoryIdentity: project.repositoryIdentity };
  }
  return next;
}

function activity(item: Row, kind: string, tone: Activity["tone"], summary: string, payload: Row, suffix = "", at?: string): Activity {
  return { id: `${text(item.id)}${suffix}`, kind, tone, summary, payload,
    turnId: nullableText(item.runId), createdAt: at ?? text(item.startedAt ?? item.updatedAt) };
}

/** Project structured v2 timeline items into Command's messages and activity feed. */
export function v2Thread(value: unknown): OrchestrationThread {
  const p = row(value);
  const t = row(p.thread);
  const rolledBack = new Set(rows(p.runs).filter((r) => r.status === "rolled_back").map((r) => r.id));
  const visible = (r: Row) => !rolledBack.has(r.runId);
  const runs = rows(p.runs).filter((r) => r.status !== "queued" && r.status !== "rolled_back").sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
  const current = [...runs].reverse().find((r) => active(r.status)) ?? runs.at(-1);
  const providerThread = rows(p.providerThreads).find((r) => r.id === t.activeProviderThreadId);
  const runtimeRequests = rows(p.runtimeRequests);
  const pending = runtimeRequests.filter((r) => r.status === "pending");
  const messages = new Map<string, Message>();
  const activities: Activity[] = [];
  const localItems = rows(p.turnItems);
  const localIds = new Set(localItems.map((i) => i.id));
  const items = [...rows(p.visibleTurnItems).map((r) => row(r.item)).filter((i) => !localIds.has(i.id)), ...localItems]
    .filter(visible).sort((a, b) => Date.parse(text(a.startedAt ?? a.updatedAt)) - Date.parse(text(b.startedAt ?? b.updatedAt)) || Number(a.ordinal) - Number(b.ordinal));
  for (const m of rows(p.messages).filter(visible)) messages.set(text(m.id), { ...m, turnId: nullableText(m.runId) } as unknown as Message);
  for (const i of items) {
    const at = text(i.startedAt ?? i.updatedAt);
    const title = text(i.title) || text(i.type).replace(/_/g, " ");
    switch (i.type) {
      case "user_message":
      case "assistant_message":
      case "reasoning": {
        const id = text(i.messageId) || text(i.id);
        // message.updated and turn-item.updated are full replacements, never deltas.
        if (!messages.has(id) || text(i.updatedAt) >= messages.get(id)!.updatedAt || i.type === "reasoning") messages.set(id, {
          id, role: i.type === "reasoning" ? "reasoning" : i.type === "user_message" ? "user" : "assistant",
          text: text(i.text), turnId: nullableText(i.runId), streaming: Boolean(i.streaming),
          attachments: i.attachments as Message["attachments"], createdAt: at, updatedAt: text(i.updatedAt),
        });
        break;
      }
      case "approval_request":
      case "user_input_request": {
        const question = i.type === "user_input_request";
        const prefix = question ? "user-input" : "approval";
        activities.push(activity(i, `${prefix}.requested`, "approval", text(i.prompt) || title, { ...i, requestId: i.requestId }));
        const request = runtimeRequests.find((r) => r.id === i.requestId);
        if ((request && request.status !== "pending") || (!request && terminal(i.status))) {
          activities.push(activity(i, `${prefix}.resolved`, "info", "Request closed", { requestId: i.requestId, decision: request?.decision, answers: request?.answers }, ":resolved", text(request?.resolvedAt ?? i.completedAt ?? i.updatedAt)));
        }
        break;
      }
      case "todo_list":
        activities.push(activity(i, "turn.plan.updated", "info", title, { plan: rows(i.steps).map((s) => ({ step: s.text, status: s.status === "running" ? "inProgress" : s.status })), explanation: i.explanation }));
        break;
      case "proposed_plan":
        activities.push(activity(i, "plan.proposed", "info", text(i.markdown), { ...i, planMarkdown: i.markdown }));
        break;
      case "error":
        activities.push(activity(i, "turn.failed", "error", text(row(i.failure).message) || title, row(i.failure)));
        break;
      case "compaction":
        activities.push(activity(i, "context-compaction", "info", title, { state: terminal(i.status) ? "compacted" : "compacting", beforeTokens: i.beforeTokenCount, afterTokens: i.afterTokenCount }));
        break;
      case "subagent":
        activities.push(activity(i, terminal(i.status) ? "task.completed" : "task.started", "tool", title, { ...i, taskId: i.subagentId }));
        break;
      case "command_execution":
      case "file_change":
      case "file_search":
      case "web_search":
      case "dynamic_tool": {
        const payload = { ...i, toolCallId: i.id, itemType: i.type === "dynamic_tool" ? "dynamic_tool_call" : i.type,
          detail: text(i.input) || text(i.fileName) || title, command: i.input };
        activities.push(activity(i, "tool.started", "tool", title, { ...payload, status: "running" }));
        if (terminal(i.status)) activities.push(activity(i, "tool.completed", i.status === "failed" ? "error" : "tool", title, payload, ":completed", text(i.completedAt ?? i.updatedAt)));
        break;
      }
      default:
        activities.push(activity(i, text(i.type), "info", text(i.message) || title, i));
    }
  }
  if (providerThread?.contextUsage) activities.push(activity({ id: `context:${text(providerThread.id)}`, runId: current?.id, updatedAt: providerThread.updatedAt }, "context-window.updated", "info", "Context usage", row(providerThread.contextUsage)));
  activities.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const checkpoints: Checkpoint[] = rows(p.checkpoints).filter((c) => visible(c) && c.appRunOrdinal != null && c.runId != null).map((c) => ({
    turnId: text(c.runId), checkpointTurnCount: Number(c.appRunOrdinal), status: c.status === "stale" ? "missing" : c.status as Checkpoint["status"],
    files: c.files as Checkpoint["files"], completedAt: text(c.capturedAt),
  }));
  const shell = v2Shell({ ...t, status: current?.status ?? "idle", latestRunId: current?.id ?? null,
    activeRunId: current && active(current.status) ? current.id : null,
    latestRunRequestedAt: current?.requestedAt, latestRunStartedAt: current?.workStartedAt ?? current?.startedAt, latestRunCompletedAt: current?.completedAt,
    pendingRuntimeRequest: pending[0], pendingBackgroundTasks: providerThread?.pendingBackgroundTasks,
    latestUserMessageAt: [...messages.values()].filter((m) => m.role === "user").at(-1)?.createdAt ?? null,
    lastError: [...activities].reverse().find((a) => a.kind === "turn.failed" && a.turnId === current?.id)?.summary,
  });
  if (shell.latestTurn) shell.latestTurn.assistantMessageId = [...messages.values()].reverse().find((m) => m.role === "assistant" && m.turnId === current?.id)?.id ?? null;
  const plan = [...activities].reverse().find((a) => a.kind === "turn.plan.updated" && a.turnId === current?.id);
  const steps = rows(plan?.payload?.plan);
  return { ...shell,
    planProgress: current && active(current.status) && steps.length ? { step: text((steps.find((s) => s.status === "inProgress") ?? steps.find((s) => s.status === "pending") ?? steps.at(-1))?.step), totalSteps: steps.length, completedSteps: steps.filter((s) => s.status === "completed").length } : null,
    messages: [...messages.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)), activities, checkpoints };
}

const EVENT_TABLES: Record<string, string> = {
  run: "runs", "run-attempt": "attempts", node: "nodes", subagent: "subagents", "provider-session": "providerSessions",
  "provider-thread": "providerThreads", "provider-turn": "providerTurns", "runtime-request": "runtimeRequests",
  message: "messages", "turn-item": "turnItems", plan: "plans", "checkpoint-scope": "checkpointScopes", checkpoint: "checkpoints",
  "context-handoff": "contextHandoffs", "context-transfer": "contextTransfers",
};

/** Stateful per-subscription decoder; sequences are carried by the envelope in v2. */
export function v2ThreadStream(): (values: unknown[]) => ThreadStreamItem[] {
  let projection: Row | undefined;
  let sequence = -1;
  let synced = false;
  return (values) => {
    let changed = false;
    for (const value of values) {
      const item = row(value);
      if (item.kind === "snapshot") { projection = row(item.projection); sequence = Number(item.snapshotSequence); changed = true; }
      else if (item.kind === "synchronized") synced = true;
      else if (item.kind === "event" && projection && Number(item.sequence) > sequence) {
        sequence = Number(item.sequence);
        const event = row(item.event);
        const type = text(event.type);
        const payload = row(event.payload);
        const [entity] = type.split(".");
        if (entity === "thread" && payload.id === row(projection.thread).id) { projection = { ...projection, thread: payload }; changed = true; }
        else if (EVENT_TABLES[entity] && payload.id) {
          const table = EVENT_TABLES[entity];
          projection = { ...projection, [table]: [...rows(projection[table]).filter((r) => r.id !== payload.id), payload] };
          changed = true;
        }
      }
    }
    return [...(changed && projection ? [{ kind: "snapshot" as const, snapshot: { snapshotSequence: sequence, thread: v2Thread(projection) } }] : []),
      ...(synced ? [{ kind: "synchronized" as const }] : [])];
  };
}

export function protocolStreamPayload(version: number, tag: string, payload: unknown): unknown {
  if (version !== 2 || tag !== "orchestration.subscribeThread") return payload;
  // A new decoder needs a snapshot. Shell streams can still resume incrementally.
  const p = row(payload);
  return { threadId: p.threadId, requestCompletionMarker: p.requestCompletionMarker };
}

export function protocolStreamDecoder(version: number, tag: string): (values: unknown[]) => unknown[] {
  return version !== 2 ? (values) => values : tag === "orchestration.subscribeShell" ? v2ShellItems
    : tag === "orchestration.subscribeThread" ? v2ThreadStream() : (values) => values;
}

type Request = (tag: string, payload: unknown) => Promise<unknown>;

/** Translate Command actions, including server-owned follow-ups, at the RPC boundary. */
export async function protocolRequest(version: number, tag: string, payload: unknown, request: Request): Promise<unknown> {
  if (version !== 2 || tag !== "orchestration.dispatchCommand") return request(tag, payload);
  const c = row(payload);
  const command = { ...c };
  delete command.createdAt;
  const send = (body: Row) => request(tag, body);
  if (text(c.type).startsWith("project.")) return request("projects.mutate", command);
  if (c.type === "thread.approval.respond" || c.type === "thread.user-input.respond") return send({ ...command, type: "runtime-request.respond" });
  if (c.type === "thread.turn.interrupt") {
    let runId = c.turnId;
    if (!runId) {
      const p = row(await request("orchestration.getThreadProjection", { threadId: c.threadId }));
      const runs = rows(p.runs).sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
      runId = [...runs].reverse().find((r) => active(r.status))?.id ?? runs.filter((r) => r.status !== "queued" && r.status !== "rolled_back").at(-1)?.id;
    }
    if (!runId) throw new Error("This thread has no active run to interrupt");
    return send({ commandId: c.commandId, type: "run.interrupt", threadId: c.threadId, runId, holdQueue: true });
  }
  if (c.type === "thread.checkpoint.revert") {
    const p = row(await request("orchestration.getThreadProjection", { threadId: c.threadId }));
    const checkpoint = rows(p.checkpoints).find((r) => r.appRunOrdinal === c.turnCount && r.status === "ready");
    if (!checkpoint) throw new Error("That rollback checkpoint is unavailable");
    return send({ commandId: c.commandId, type: "checkpoint.rollback", threadId: c.threadId, checkpointId: checkpoint.id, scopeId: checkpoint.scopeId, restoreFiles: true });
  }
  if (c.type !== "thread.turn.start") return send(command);
  const message = row(c.message);
  const bootstrap = row(c.bootstrap);
  const create = row(bootstrap.createThread);
  if (create.projectId) {
    const prepare = row(bootstrap.prepareWorktree);
    const workspaceStrategy = prepare.baseBranch ? { type: "worktree", baseRef: prepare.baseBranch, branch: prepare.branch, startFromOrigin: prepare.startFromOrigin }
      : create.worktreePath ? { type: "existing_worktree", worktreePath: create.worktreePath, ...(create.branch ? { branch: create.branch } : {}) }
      : { type: "root", ...(create.branch ? { branch: create.branch } : {}) };
    return request("orchestration.launchThread", {
      commandId: c.commandId, threadId: c.threadId, creationSource: "web", projectId: create.projectId, title: create.title,
      generateTitle: true, modelSelection: c.modelSelection, runtimeMode: c.runtimeMode, interactionMode: c.interactionMode,
      workspaceStrategy, initialMessage: { messageId: message.messageId, text: message.text, attachments: message.attachments ?? [] },
    });
  }
  // These modes moved from turn-start into independent thread commands in v2.
  for (const [field, type] of [["runtimeMode", "thread.runtime-mode.set"], ["interactionMode", "thread.interaction-mode.set"]]) {
    if (c[field] !== undefined) await send({ commandId: `${text(c.commandId)}:${field}`, type, threadId: c.threadId, [field]: c[field] });
  }
  return send({ type: "message.dispatch", commandId: c.commandId, threadId: c.threadId,
    messageId: message.messageId, text: message.text, attachments: message.attachments ?? [],
    modelSelection: c.modelSelection, createdBy: "user", creationSource: "web", deliveryIntent: "auto", dispatchMode: { type: "start_immediately" } });
}
