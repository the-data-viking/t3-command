// The fleet timeline's model: one lane per crew member, grouped by project, with a bar per turn
// over the window — finished turns from the Command server's history, plus whatever is running
// or waiting on you right now from the live fleet.

import type { TimelineView, TurnRecord } from "../../shared/history";
import type { EnvWorld } from "../store";
import { allUnits } from "./util";

export type BarTone = "done" | "error" | "interrupted" | "working" | "alert" | "question";

export interface Bar {
  start: number;
  end: number;
  tone: BarTone;
  /** Still going: ends at "now". */
  live: boolean;
  record?: TurnRecord;
}

export interface Lane {
  key: string;
  envId: string;
  threadId: string;
  title: string;
  machine: string;
  bars: Bar[];
  /** Latest moment anything happened in this lane, for ordering. */
  last: number;
}

export interface Group { project: string; lanes: Lane[]; last: number }

const TONE: Record<TurnRecord["outcome"], BarTone> = { completed: "done", error: "error", interrupted: "interrupted" };

export function buildTimeline(view: TimelineView, envs: Record<string, EnvWorld>, now: number): Group[] {
  const lanes = new Map<string, Lane & { project: string }>();
  const lane = (envId: string, threadId: string, title: string, machine: string, project: string) => {
    const key = `${envId}:${threadId}`;
    let l = lanes.get(key);
    if (!l) lanes.set(key, (l = { key, envId, threadId, title, machine, project, bars: [], last: 0 }));
    return l;
  };
  const seen = new Set<string>();
  for (const r of view.turns) {
    const live = envs[r.envId];
    const thread = live?.threads[r.threadId];
    const l = lane(r.envId, r.threadId, thread?.title || r.threadTitle || "Untitled", live?.summary.label ?? r.envLabel,
      (thread && live.projects[thread.projectId]?.title) || r.projectTitle);
    const start = Math.max(view.from, Date.parse(r.startedAt)), end = Date.parse(r.completedAt);
    l.bars.push({ start, end, tone: TONE[r.outcome], live: false, record: r });
    l.last = Math.max(l.last, end);
    seen.add(`${r.envId}:${r.threadId}:${r.turnId}`);
  }
  // The live fleet: a turn running or waiting on you now, unless history already closed it.
  for (const u of allUnits(envs)) {
    const turn = u.thread.latestTurn;
    if (!turn || seen.has(`${u.envId}:${u.thread.id}:${turn.turnId}`)) continue;
    if (turn.state !== "running" && u.state !== "alert" && u.state !== "question") continue;
    const env = envs[u.envId];
    if (env.connection !== "live") continue;
    const started = Date.parse(turn.startedAt ?? turn.requestedAt);
    if (!Number.isFinite(started)) continue;
    const l = lane(u.envId, u.thread.id, u.thread.title || "Untitled", env.summary.label, env.projects[u.thread.projectId]?.title ?? "No project");
    l.bars.push({ start: Math.max(view.from, started), end: now, tone: u.state === "alert" || u.state === "question" ? u.state : "working", live: true });
    l.last = now;
  }
  const groups = new Map<string, Group>();
  for (const l of lanes.values()) {
    const g = groups.get(l.project) ?? { project: l.project, lanes: [], last: 0 };
    g.lanes.push(l);
    g.last = Math.max(g.last, l.last);
    groups.set(l.project, g);
  }
  for (const g of groups.values()) g.lanes.sort((a, b) => b.last - a.last || a.key.localeCompare(b.key));
  return [...groups.values()].sort((a, b) => b.last - a.last || a.project.localeCompare(b.project));
}

/** Axis ticks on whole local hours, spaced so there are about six to eight. */
export function ticks(from: number, to: number): number[] {
  const hours = (to - from) / 3_600_000;
  const step = hours <= 6 ? 1 : hours <= 24 ? 3 : hours <= 72 ? 12 : 24;
  const first = new Date(from);
  first.setMinutes(0, 0, 0);
  const out: number[] = [];
  for (let t = first.getTime() + 3_600_000; t < to; t += 3_600_000) {
    if (new Date(t).getHours() % step === 0) out.push(t);
  }
  return out;
}
