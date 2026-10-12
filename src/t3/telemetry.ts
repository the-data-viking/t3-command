// What a crew member is doing right now, derived only from T3's own activity stream
// (StarNet's rule: never show state the harness can't prove).

import type { OrchestrationThread } from "./types";

/** Where on the station a crew member goes for its current step. */
export type Workstation = "console" | "terminal" | "files" | "comms";

export interface Telemetry {
  workstation: Workstation;
  /** Short description of the open tool call, if any. */
  doing?: string;
  /** Context window used, 0..1, from the latest context-window report. */
  context?: number;
  /** Background tasks (subagents, shells) currently running. */
  tasks: number;
}

const WORKSTATION_BY_ITEM: Record<string, Workstation> = {
  command_execution: "terminal",
  file_change: "files",
  file_read: "files",
  image_view: "files",
  mcp_tool_call: "comms",
  dynamic_tool_call: "comms",
  web_search: "comms",
  web_fetch: "comms",
};

const cache = new WeakMap<OrchestrationThread, Telemetry>();

export function telemetry(thread: OrchestrationThread): Telemetry {
  const hit = cache.get(thread);
  if (hit) return hit;

  const turnId = thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null;
  const openTools = new Map<string, { item: string; doing?: string }>();
  const openTasks = new Set<string>();
  let context: number | undefined;

  for (const a of thread.activities) {
    const p = a.payload ?? {};
    if (a.kind === "context-window.updated") {
      const used = Number(p.usedTokens);
      const max = Number(p.maxTokens);
      if (max > 0 && Number.isFinite(used)) context = Math.min(1, used / max);
      continue;
    }
    if (a.kind.startsWith("task.")) {
      const id = String(p.taskId ?? "");
      if (!id) continue;
      const status = String(p.status ?? "");
      if (a.kind === "task.started") openTasks.add(id);
      else if (a.kind === "task.completed" || ["completed", "cancelled", "stopped", "failed"].includes(status)) openTasks.delete(id);
      continue;
    }
    if (!a.kind.startsWith("tool.") || !turnId || a.turnId !== turnId) continue;
    const id = String(p.toolCallId ?? a.id);
    if (a.kind === "tool.completed" || p.status === "completed" || p.status === "failed") openTools.delete(id);
    else openTools.set(id, { item: String(p.itemType ?? ""), doing: typeof p.detail === "string" ? p.detail : a.summary });
  }

  const current = [...openTools.values()].pop();
  const result: Telemetry = {
    workstation: current ? (WORKSTATION_BY_ITEM[current.item] ?? "comms") : "console",
    doing: current?.doing,
    context,
    // A task.started whose completion was missed (restart, interrupt, outside the turn window)
    // must not orbit forever: drones need a running turn or T3's own background liveness.
    tasks: thread.latestTurn?.state === "running" || thread.backgroundLiveness === "working" || thread.backgroundLiveness === "monitoring" ? openTasks.size : 0,
  };
  cache.set(thread, result);
  return result;
}
