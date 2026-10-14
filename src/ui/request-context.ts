// Context for a decision: what an approval request is for, read from the turn it belongs to —
// the order that started the turn, what the agent last said before asking, where it runs, and
// what it did in the turn so far. Only what the transcript shows; nothing inferred.

import type { EnvWorld } from "../store";
import type { OrchestrationThread, PendingRequest, ThreadShell } from "../t3/types";

export interface RequestContext {
  /** The order that started this turn, shortened. */
  order?: string;
  /** The agent's last words before asking, shortened to a sentence or two. */
  intent?: string;
  /** Machine, workspace and branch. */
  where: string[];
  /** The last few tool calls this turn, newest last. */
  recent: string[];
}

/** The last sentence or two of a message, at most `max` characters. */
export function lastWords(text: string, max = 240): string {
  const clean = text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const sentences = clean.match(/[^.!?]+[.!?]*/g) ?? [clean];
  let out = "";
  for (let i = sentences.length - 1; i >= 0; i--) {
    const next = (sentences[i].trim() + " " + out).trim();
    if (next.length > max) break;
    out = next;
  }
  return out || `…${clean.slice(-max + 1)}`;
}

const short = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function requestContext(env: EnvWorld | undefined, thread: ThreadShell, detail: OrchestrationThread | undefined, request: PendingRequest): RequestContext {
  const turnId = request.activity.turnId ?? thread.latestTurn?.turnId ?? null;
  const asked = Date.parse(request.activity.createdAt);
  const inTurn = <T extends { turnId: string | null; createdAt: string }>(items: T[]) =>
    items.filter((m) => m.turnId === turnId && !(Date.parse(m.createdAt) > asked));
  const messages = detail ? inTurn(detail.messages) : [];
  const order = messages.find((m) => m.role === "user")?.text.trim();
  const said = [...messages].reverse().find((m) => m.role === "assistant" && m.text.trim())?.text;
  const tools = detail ? inTurn(detail.activities).filter((a) => a.kind.startsWith("tool.") && a.id !== request.activity.id) : [];
  // One line per tool call: the latest activity for each call id.
  const calls = new Map<string, string>();
  for (const a of tools) {
    const id = String(a.payload?.toolCallId ?? a.id);
    const what = typeof a.payload?.detail === "string" && a.payload.detail.trim() ? a.payload.detail : a.summary;
    if (what?.trim()) { calls.delete(id); calls.set(id, short(what.split("\n")[0].trim(), 90)); }
  }
  const project = env?.projects[thread.projectId];
  const where = [
    env?.summary.label,
    thread.worktreePath ?? project?.workspaceRoot,
    thread.branch ? `branch ${thread.branch}` : undefined,
  ].filter((s): s is string => !!s);
  return {
    order: order ? short(order.replace(/\s+/g, " "), 200) : undefined,
    intent: said ? lastWords(said) : undefined,
    where,
    recent: [...calls.values()].slice(-3),
  };
}
