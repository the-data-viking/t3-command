// Applies live thread events to a thread snapshot. Mirrors T3's server-side projector
// (docs/PROTOCOL.md §4.3). Returns the same object when an event doesn't change anything we show.

import type { Activity, Checkpoint, LatestTurn, Message, OrchestrationEvent, OrchestrationThread, ThreadSession } from "./types";

const MESSAGE_CAP = 2000;

function upsertMessage(thread: OrchestrationThread, p: Record<string, unknown>, at: string): OrchestrationThread {
  const id = p.messageId as string;
  const text = (p.text as string | undefined) ?? "";
  const streaming = Boolean(p.streaming);
  const index = thread.messages.findIndex((m) => m.id === id);
  let messages: Message[];
  if (index >= 0) {
    const prev = thread.messages[index];
    const next: Message = {
      ...prev,
      // While streaming, text is a delta to append; the final event carries the full text.
      text: streaming ? prev.text + text : text || prev.text,
      streaming,
      turnId: (p.turnId as string | null | undefined) ?? prev.turnId,
      updatedAt: (p.updatedAt as string | undefined) ?? at,
      ...(p.attachments !== undefined ? { attachments: p.attachments as Message["attachments"] } : {}),
    };
    messages = thread.messages.slice();
    messages[index] = next;
  } else {
    const created: Message = {
      id,
      role: p.role as Message["role"],
      text,
      streaming,
      turnId: (p.turnId as string | null | undefined) ?? null,
      createdAt: (p.createdAt as string | undefined) ?? at,
      updatedAt: (p.updatedAt as string | undefined) ?? at,
      ...(p.attachments !== undefined ? { attachments: p.attachments as Message["attachments"] } : {}),
    };
    messages = [...thread.messages, created].slice(-MESSAGE_CAP);
  }
  return { ...thread, messages };
}

function appendActivity(thread: OrchestrationThread, activity: Activity): OrchestrationThread {
  const index = thread.activities.findIndex((a) => a.id === activity.id);
  const activities = thread.activities.slice();
  if (index >= 0) activities[index] = activity;
  else activities.push(activity);
  return { ...thread, activities };
}

function setSession(thread: OrchestrationThread, session: ThreadSession): OrchestrationThread {
  let latestTurn: LatestTurn | null = thread.latestTurn;
  if (session.status === "running" && session.activeTurnId) {
    if (latestTurn?.turnId !== session.activeTurnId || latestTurn.state !== "running") {
      latestTurn = {
        turnId: session.activeTurnId,
        state: "running",
        requestedAt: session.updatedAt,
        startedAt: session.updatedAt,
        completedAt: null,
        assistantMessageId: null,
      };
    }
  } else if (latestTurn?.state === "running" && session.status !== "starting") {
    const state = session.status === "error" ? "error" : session.status === "interrupted" ? "interrupted" : "completed";
    latestTurn = { ...latestTurn, state, completedAt: session.updatedAt };
  }
  return { ...thread, session, latestTurn };
}

function upsertCheckpoint(thread: OrchestrationThread, checkpoint: Checkpoint): OrchestrationThread {
  const checkpoints = thread.checkpoints.filter((c) => c.turnId !== checkpoint.turnId);
  checkpoints.push(checkpoint);
  checkpoints.sort((a, b) => a.checkpointTurnCount - b.checkpointTurnCount);
  return { ...thread, checkpoints };
}

function revert(thread: OrchestrationThread, turnCount: number): OrchestrationThread {
  const kept = thread.checkpoints.filter((c) => c.checkpointTurnCount <= turnCount);
  const dropped = new Set(thread.checkpoints.filter((c) => c.checkpointTurnCount > turnCount).map((c) => c.turnId));
  const keep = <T extends { turnId: string | null }>(items: T[]) => items.filter((i) => !i.turnId || !dropped.has(i.turnId));
  return { ...thread, checkpoints: kept, messages: keep(thread.messages), activities: keep(thread.activities) };
}

export function applyThreadEvent(thread: OrchestrationThread, event: OrchestrationEvent): OrchestrationThread {
  const p = event.payload;
  switch (event.type) {
    case "thread.message-sent":
      return upsertMessage(thread, p, event.occurredAt);
    case "thread.activity-appended":
      return appendActivity(thread, p.activity as Activity);
    case "thread.session-set":
      return setSession(thread, p.session as ThreadSession);
    case "thread.turn-diff-completed":
      return upsertCheckpoint(thread, p as unknown as Checkpoint);
    case "thread.reverted":
      return revert(thread, p.turnCount as number);
    default:
      return thread;
  }
}
