// Fleet layout: pure geometry computed from the game store. No rendering here.
//
//   station  = one T3 environment: a core hub with project modules docked on its sides
//   module   = one project: consoles for awake crew, a workstation strip, quarters, maybe an archive pod
//   crew     = one thread: a seat at a console, or a bunk in quarters when settled

import type { EnvWorld, GameState } from "../store";
import { unitKey } from "../store";
import { isHistory, unitState } from "../t3/derive";
import type { Workstation } from "../t3/telemetry";
import type { ThreadShell } from "../t3/types";
import { teamColor } from "./theme";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Side = "n" | "s" | "w" | "e";

export interface ModuleLayout {
  key: string; // envId:projectId
  envId: string;
  projectId: string;
  side: Side;
  room: Rect;
  /** Corridor from the core to the room, as a thick line. */
  corridor: [Point, Point];
  workstations: Record<Exclude<Workstation, "console">, Point>;
  consoles: Point[];
  archive?: Rect;
  archived: number;
  quarters?: Rect;
}

export interface CrewLayout {
  key: string;
  envId: string;
  threadId: string;
  moduleKey: string;
  /** Where the crew member sits (in front of its console) or sleeps (bunk). */
  home: Point;
  console?: Point;
  sleeping: boolean;
}

export interface StationLayout {
  envId: string;
  index: number;
  color: number;
  center: Point;
  coreRadius: number;
  bounds: Rect;
  modules: ModuleLayout[];
}

export interface FleetLayout {
  stations: Map<string, StationLayout>;
  modules: Map<string, ModuleLayout>;
  crew: Map<string, CrewLayout>;
  bounds: Rect;
}

const CORE = 62;
const DOCK_GAP = 46; // corridor length between core and module
const STACK_GAP = 34; // between modules stacked on the same side
const CONSOLE_W = 46;
const CONSOLE_H = 50;
const STRIP_H = 46; // workstation strip at the top of each module
const BUNK_W = 18;
const BUNK_H = 12;
const PAD = 14;
const ARCHIVE_W = 44;
const ARCHIVE_H = 40;
const SIDES: Side[] = ["n", "s", "w", "e"];

export function sortedEnvs(state: GameState): EnvWorld[] {
  return Object.values(state.envs).sort((a, b) => a.summary.addedAt.localeCompare(b.summary.addedAt));
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

interface DraftModule {
  projectId: string;
  awake: ThreadShell[];
  asleep: ThreadShell[];
  archived: number;
  cols: number;
  rows: number;
  bunkRows: number;
  w: number;
  h: number;
}

function draftModule(projectId: string, threads: ThreadShell[]): DraftModule {
  const awake = threads.filter((t) => !isHistory(t) && unitState(t) !== "sleeping").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const asleep = threads.filter((t) => !isHistory(t) && unitState(t) === "sleeping").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const archived = threads.filter(isHistory).length;
  const cols = Math.min(5, Math.max(3, Math.ceil(Math.sqrt(awake.length * 1.5))));
  const rows = Math.max(1, Math.ceil(awake.length / cols));
  const w = cols * CONSOLE_W + PAD * 2;
  const perBunkRow = Math.floor((w - PAD * 2) / BUNK_W);
  const bunkRows = asleep.length ? Math.ceil(asleep.length / perBunkRow) : 0;
  const h = STRIP_H + rows * CONSOLE_H + (bunkRows ? bunkRows * (BUNK_H + 4) + 18 : 0) + PAD;
  return { projectId, awake, asleep, archived, cols, rows, bunkRows, w, h };
}

/** Lay out one station around (0, 0); translated into the sector grid afterwards. */
function layoutStation(env: EnvWorld): { modules: ModuleLayout[]; crew: CrewLayout[]; bounds: Rect } {
  const envId = env.summary.id;
  const byProject = new Map<string, ThreadShell[]>();
  for (const t of Object.values(env.threads)) byProject.set(t.projectId, [...(byProject.get(t.projectId) ?? []), t]);

  const projects = Object.values(env.projects).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const used: Record<Side, number> = { n: 0, s: 0, w: 0, e: 0 };
  const modules: ModuleLayout[] = [];
  const crew: CrewLayout[] = [];
  let bounds: Rect = { x: -CORE, y: -CORE, w: CORE * 2, h: CORE * 2 };

  projects.forEach((project, i) => {
    const d = draftModule(project.id, byProject.get(project.id) ?? []);
    const side = SIDES[i % SIDES.length];
    const offset = CORE + DOCK_GAP + used[side];
    used[side] += (side === "n" || side === "s" ? d.h : d.w) + STACK_GAP;

    let room: Rect;
    let corridor: [Point, Point];
    switch (side) {
      case "n":
        room = { x: -d.w / 2, y: -offset - d.h, w: d.w, h: d.h };
        corridor = [{ x: 0, y: -CORE }, { x: 0, y: room.y + room.h }];
        break;
      case "s":
        room = { x: -d.w / 2, y: offset, w: d.w, h: d.h };
        corridor = [{ x: 0, y: CORE }, { x: 0, y: room.y }];
        break;
      case "w":
        room = { x: -offset - d.w, y: -d.h / 2, w: d.w, h: d.h };
        corridor = [{ x: -CORE, y: 0 }, { x: room.x + room.w, y: 0 }];
        break;
      case "e":
        room = { x: offset, y: -d.h / 2, w: d.w, h: d.h };
        corridor = [{ x: CORE, y: 0 }, { x: room.x, y: 0 }];
        break;
    }

    const key = `${envId}:${project.id}`;
    const stripY = room.y + 22;
    const workstations = {
      terminal: { x: room.x + room.w * 0.22, y: stripY },
      files: { x: room.x + room.w * 0.5, y: stripY },
      comms: { x: room.x + room.w * 0.78, y: stripY },
    };
    const consoles: Point[] = [];
    d.awake.forEach((t, k) => {
      const col = k % d.cols;
      const row = Math.floor(k / d.cols);
      const inRow = Math.min(d.cols, d.awake.length - row * d.cols);
      const x = room.x + room.w / 2 + (col - (inRow - 1) / 2) * CONSOLE_W;
      const y = room.y + STRIP_H + row * CONSOLE_H + 14;
      consoles.push({ x, y });
      crew.push({ key: unitKey(envId, t.id), envId, threadId: t.id, moduleKey: key, home: { x, y: y + 20 }, console: { x, y }, sleeping: false });
    });

    let quarters: Rect | undefined;
    if (d.bunkRows) {
      const qy = room.y + STRIP_H + d.rows * CONSOLE_H + 6;
      quarters = { x: room.x + PAD - 4, y: qy, w: room.w - PAD * 2 + 8, h: d.bunkRows * (BUNK_H + 4) + 10 };
      const perRow = Math.floor((room.w - PAD * 2) / BUNK_W);
      d.asleep.forEach((t, k) => {
        const x = room.x + PAD + (k % perRow) * BUNK_W + BUNK_W / 2;
        const y = qy + 10 + Math.floor(k / perRow) * (BUNK_H + 4) + BUNK_H / 2;
        crew.push({ key: unitKey(envId, t.id), envId, threadId: t.id, moduleKey: key, home: { x, y }, sleeping: true });
      });
    }

    let archive: Rect | undefined;
    if (d.archived) {
      // Pod docked on the module's outer corner, away from the core.
      const ax = side === "w" ? room.x - ARCHIVE_W - 10 : room.x + room.w + 10;
      const ay = side === "s" ? room.y + room.h - ARCHIVE_H : room.y;
      archive = { x: ax, y: ay, w: ARCHIVE_W, h: ARCHIVE_H };
      bounds = union(bounds, archive);
    }

    bounds = union(bounds, room);
    modules.push({ key, envId, projectId: project.id, side, room, corridor, workstations, consoles, archive, archived: d.archived, quarters });
  });

  return { modules, crew, bounds };
}

function shift<T extends Point>(p: T, dx: number, dy: number): T {
  return { ...p, x: p.x + dx, y: p.y + dy };
}

export function computeFleetLayout(state: GameState): FleetLayout {
  const envs = sortedEnvs(state);
  const drafts = envs.map((env) => ({ env, ...layoutStation(env) }));
  const fleet: FleetLayout = { stations: new Map(), modules: new Map(), crew: new Map(), bounds: { x: 0, y: 0, w: 0, h: 0 } };
  if (drafts.length === 0) return fleet;

  // Sector grid: roughly square, with room between stations for their banners.
  const columns = Math.ceil(Math.sqrt(drafts.length));
  const cellW = Math.max(...drafts.map((d) => d.bounds.w)) + 200;
  const cellH = Math.max(...drafts.map((d) => d.bounds.h)) + 230;

  drafts.forEach((d, index) => {
    const cx = (index % columns) * cellW;
    const cy = Math.floor(index / columns) * cellH;
    // Center the station's own bounds in its cell.
    const dx = cx - (d.bounds.x + d.bounds.w / 2);
    const dy = cy - (d.bounds.y + d.bounds.h / 2);
    const modules = d.modules.map((m) => ({
      ...m,
      room: shift(m.room, dx, dy),
      corridor: [shift(m.corridor[0], dx, dy), shift(m.corridor[1], dx, dy)] as [Point, Point],
      workstations: {
        terminal: shift(m.workstations.terminal, dx, dy),
        files: shift(m.workstations.files, dx, dy),
        comms: shift(m.workstations.comms, dx, dy),
      },
      consoles: m.consoles.map((p) => shift(p, dx, dy)),
      archive: m.archive && shift(m.archive, dx, dy),
      quarters: m.quarters && shift(m.quarters, dx, dy),
    }));
    const station: StationLayout = {
      envId: d.env.summary.id,
      index,
      color: teamColor(index),
      center: { x: dx, y: dy },
      coreRadius: CORE,
      bounds: shift(d.bounds, dx, dy),
      modules,
    };
    fleet.stations.set(station.envId, station);
    for (const m of modules) fleet.modules.set(m.key, m);
    for (const c of d.crew) {
      fleet.crew.set(c.key, { ...c, home: shift(c.home, dx, dy), console: c.console && shift(c.console, dx, dy) });
    }
    fleet.bounds = index === 0 ? station.bounds : union(fleet.bounds, station.bounds);
  });
  return fleet;
}

/** Team color for an environment, consistent between the map and the HUD. */
export function stationColor(state: GameState, envId: string): number {
  const index = sortedEnvs(state).findIndex((e) => e.summary.id === envId);
  return teamColor(Math.max(0, index));
}
