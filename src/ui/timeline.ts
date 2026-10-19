// The fleet timeline's model: one lane per crew member, grouped by project, with a bar per turn
// over the window — finished turns from the Command server's history, plus whatever is running
// or waiting on you right now from the live fleet.

import type { TimelineView, TurnRecord } from "../../shared/history";
import type { EnvWorld, GameState } from "../store";
import { isSubagent } from "../t3/derive";
import { waitingSince } from "./queue";
import { allUnits } from "./util";

export type BarTone = "done" | "error" | "interrupted" | "working" | "alert" | "question";

export interface Bar {
  start: number;
  end: number;
  tone: BarTone;
  /** Still going: ends at "now". */
  live: boolean;
  /** The part of a live turn spent waiting on you (drawn hatched), as opposed to the agent working. */
  waiting?: boolean;
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

export function buildTimeline(view: TimelineView, envs: Record<string, EnvWorld>, now: number, details: GameState["details"] = {}): Group[] {
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
    if (r.isSubagent || (thread && isSubagent(thread))) continue;
    const l = lane(r.envId, r.threadId, thread?.title || r.threadTitle || "Untitled", live?.summary.label ?? r.envLabel,
      (thread && live.projects[thread.projectId]?.title) || r.projectTitle);
    const start = Math.max(view.from, Date.parse(r.startedAt)), end = Date.parse(r.completedAt);
    l.bars.push({ start, end, tone: TONE[r.outcome], live: false, record: r });
    l.last = Math.max(l.last, end);
    seen.add(`${r.envId}:${r.threadId}:${r.turnId}`);
  }
  // The live fleet: a turn running or waiting on you now, unless history already closed it.
  for (const u of allUnits(envs)) {
    if (isSubagent(u.thread)) continue;
    const turn = u.thread.latestTurn;
    if (!turn || seen.has(`${u.envId}:${u.thread.id}:${turn.turnId}`)) continue;
    if (turn.state !== "running" && u.state !== "alert" && u.state !== "question") continue;
    const env = envs[u.envId];
    if (env.connection !== "live") continue;
    const started = Date.parse(turn.startedAt ?? turn.requestedAt);
    if (!Number.isFinite(started)) continue;
    const l = lane(u.envId, u.thread.id, u.thread.title || "Untitled", env.summary.label, env.projects[u.thread.projectId]?.title ?? "No project");
    const start = Math.max(view.from, started);
    if (u.state === "alert" || u.state === "question") {
      // Truth: the agent worked until it asked; only the time since is waiting on you.
      const asked = Math.min(now, Math.max(start, waitingSince(u.thread, details[`${u.envId}:${u.thread.id}`]?.thread)));
      if (asked > start) l.bars.push({ start, end: asked, tone: "working", live: false });
      l.bars.push({ start: asked, end: now, tone: u.state, live: true, waiting: true });
    } else l.bars.push({ start, end: now, tone: "working", live: true });
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

/** Axis ticks on whole local hours: the finest step that leaves at most `max` labels (they need ~80 px each). */
export function ticks(from: number, to: number, max = 8): number[] {
  const hours = (to - from) / 3_600_000;
  const step = [1, 2, 3, 6, 12, 24, 48].find((h) => hours / h <= max) ?? 48;
  const first = new Date(from);
  first.setMinutes(0, 0, 0);
  const out: number[] = [];
  for (let t = first.getTime() + 3_600_000; t < to; t += 3_600_000) {
    const d = new Date(t);
    // Steps past a day land on midnights every other day or so.
    if (step <= 24 ? d.getHours() % step === 0 : d.getHours() === 0 && Math.floor(t / 86_400_000) % (step / 24) === 0) out.push(t);
  }
  return out;
}
