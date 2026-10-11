// The RTS map, rendered with PixiJS. Purely a view of the game store: it reads state, and
// clicks turn into store selections. All art is procedural placeholder Graphics.

import { Application, Container, Graphics, Text, type FederatedPointerEvent, type TextStyleOptions } from "pixi.js";
import { setSelection, unitKey, useGame, type EnvWorld, type GameState, type Selection } from "../store";
import { isHistory, unitState, type UnitState } from "../t3/derive";
import type { ProjectShell, ThreadShell } from "../t3/types";
import { sfx } from "./sfx";

// ---- Layout --------------------------------------------------------------------------

interface Point {
  x: number;
  y: number;
}

const BASE_SPACING = 1700;
const PROJECT_RING = 430;
const MINE_DISTANCE = 210;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  // Final avalanche (murmur3 fmix) so similar keys like "gx1"/"gx2" don't produce correlated values.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296; // [0, 1)
}

interface ProjectLayout {
  building: Point;
  mine: Point;
  /** Archive building for imported history, on the opposite side from the camp. */
  library: Point;
  archived: number;
  /** Unit direction from HQ to building (used to lay out slots). */
  out: Point;
}

interface UnitLayout {
  home: Point;
  mine: Point;
  sleeping: boolean;
}

interface Layout {
  hq: Map<string, Point>;
  projects: Map<string, ProjectLayout>; // key: envId:projectId
  units: Map<string, UnitLayout>; // key: unitKey
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

function sortedEnvs(state: GameState): EnvWorld[] {
  return Object.values(state.envs).sort((a, b) => a.summary.addedAt.localeCompare(b.summary.addedAt));
}

function computeLayout(state: GameState): Layout {
  const layout: Layout = {
    hq: new Map(),
    projects: new Map(),
    units: new Map(),
    bounds: { minX: -600, minY: -600, maxX: 600, maxY: 600 },
  };
  const grow = (p: Point, pad: number) => {
    const b = layout.bounds;
    b.minX = Math.min(b.minX, p.x - pad);
    b.minY = Math.min(b.minY, p.y - pad);
    b.maxX = Math.max(b.maxX, p.x + pad);
    b.maxY = Math.max(b.maxY, p.y + pad);
  };

  sortedEnvs(state).forEach((env, envIndex) => {
    // Bases on a grid, roughly square, so many environments stay compact.
    const columns = Math.ceil(Math.sqrt(Object.keys(state.envs).length));
    const hq = { x: (envIndex % columns) * BASE_SPACING, y: Math.floor(envIndex / columns) * BASE_SPACING };
    layout.hq.set(env.summary.id, hq);
    grow(hq, 300);

    const projects = Object.values(env.projects).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const threadsByProject = new Map<string, ThreadShell[]>();
    const archivedByProject = new Map<string, number>();
    for (const t of Object.values(env.threads)) {
      if (isHistory(t)) {
        archivedByProject.set(t.projectId, (archivedByProject.get(t.projectId) ?? 0) + 1);
        continue;
      }
      const list = threadsByProject.get(t.projectId) ?? [];
      list.push(t);
      threadsByProject.set(t.projectId, list);
    }

    projects.forEach((project, i) => {
      const angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(projects.length, 1) + (projects.length === 2 ? Math.PI / 2 : 0);
      const out = { x: Math.cos(angle), y: Math.sin(angle) };
      const building = { x: hq.x + out.x * PROJECT_RING, y: hq.y + out.y * PROJECT_RING };
      const mine = { x: building.x + out.x * MINE_DISTANCE, y: building.y + out.y * MINE_DISTANCE };
      const side0 = { x: -out.y, y: out.x };
      const library = { x: building.x - side0.x * 165, y: building.y - side0.y * 165 };
      const archived = archivedByProject.get(project.id) ?? 0;
      layout.projects.set(`${env.summary.id}:${project.id}`, { building, mine, out, library, archived });
      grow(mine, 200);
      grow(library, 120);

      const threads = (threadsByProject.get(project.id) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const awake = threads.filter((t) => unitState(t) !== "sleeping");
      const asleep = threads.filter((t) => unitState(t) === "sleeping");
      const side = { x: -out.y, y: out.x }; // perpendicular to `out`

      // Awake units stand in an arc on the HQ side of their building.
      awake.forEach((t, k) => {
        const row = Math.floor(k / 7);
        const inRow = Math.min(7, awake.length - row * 7);
        const col = (k % 7) - (inRow - 1) / 2; // centered on the line toward HQ
        const radius = 110 + row * 44;
        const a = Math.atan2(-out.y, -out.x) + col * 0.5 + (row % 2) * 0.25;
        layout.units.set(unitKey(env.summary.id, t.id), {
          home: { x: building.x + Math.cos(a) * radius, y: building.y + Math.sin(a) * radius },
          mine,
          sleeping: false,
        });
      });
      // Sleeping units camp in a grid beside the building.
      asleep.forEach((t, k) => {
        const col = k % 6;
        const row = Math.floor(k / 6);
        const origin = { x: building.x + side.x * 150, y: building.y + side.y * 150 };
        const home = {
          x: origin.x + side.x * col * 30 + out.x * (row * 30 - 30),
          y: origin.y + side.y * col * 30 + out.y * (row * 30 - 30),
        };
        layout.units.set(unitKey(env.summary.id, t.id), { home, mine, sleeping: true });
        grow(home, 60);
      });
    });
  });
  return layout;
}

// ---- Colors & styles -----------------------------------------------------------------

const PROVIDER_COLORS: Record<string, number> = {
  claudeAgent: 0xe2884f,
  codex: 0x46b7a6,
  cursor: 0x8f8fe8,
  grok: 0xc9c9c9,
  opencode: 0xd8c25a,
};

const STATE_COLORS: Record<UnitState, number> = {
  alert: 0xff4d4d,
  question: 0xffcc33,
  working: 0x7fd4ff,
  error: 0xff6b3d,
  done: 0x6fe37a,
  idle: 0xbfc7d5,
  sleeping: 0x6b7385,
};

const CONNECTION_COLORS: Record<string, number> = {
  live: 0x6fe37a,
  connecting: 0xffcc33,
  reconnecting: 0xffcc33,
  "needs-pairing": 0xff6b3d,
  "needs-update": 0xff6b3d,
  offline: 0x888888,
};

const LABEL: TextStyleOptions = {
  fontFamily: "'Press Start 2P', ui-monospace, monospace",
  fontSize: 8,
  fill: 0xf1f1e6,
  stroke: { color: 0x0b0f0a, width: 3 },
  align: "center",
};

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ---- Sprites -------------------------------------------------------------------------

class UnitSprite extends Container {
  readonly key: string;
  readonly envId: string;
  readonly threadId: string;
  private shadow = new Graphics();
  private ring = new Graphics();
  private body = new Graphics();
  private badge = new Graphics();
  private badgeText = new Text({ text: "", style: { ...LABEL, fontSize: 10 } });
  private cargo = new Graphics();
  private nameText = new Text({ text: "", style: LABEL });
  private seed: number;
  private bodyColor = -1;
  private drawnState?: UnitState;
  pos: Point;
  state: UnitState = "idle";
  thread!: ThreadShell;
  hovered = false;

  constructor(key: string, envId: string, threadId: string, start: Point) {
    super();
    this.key = key;
    this.envId = envId;
    this.threadId = threadId;
    this.seed = hash(key);
    this.pos = { ...start };
    this.badgeText.anchor.set(0.5);
    this.badgeText.resolution = 2;
    this.nameText.anchor.set(0.5, 0);
    this.nameText.resolution = 2;
    this.nameText.y = 16;
    this.addChild(this.ring, this.shadow, this.cargo, this.body, this.badge, this.badgeText, this.nameText);
    this.eventMode = "static";
    this.cursor = "pointer";
    this.hitArea = { contains: (x: number, y: number) => x * x + (y + 8) * (y + 8) < 22 * 22 };
    this.on("pointerover", () => (this.hovered = true));
    this.on("pointerout", () => (this.hovered = false));
    this.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      sfx.select();
      setSelection({ kind: "unit", envId, threadId });
    });
  }

  setThread(thread: ThreadShell): void {
    this.thread = thread;
    this.state = unitState(thread);
    const color = PROVIDER_COLORS[thread.modelSelection.instanceId] ?? 0x9aa6c4;
    if (color !== this.bodyColor || this.drawnState !== this.state) {
      this.bodyColor = color;
      this.drawnState = this.state;
      this.drawBody();
    }
    this.nameText.text = truncate(thread.title || "Untitled", 22);
  }

  private drawBody(): void {
    const sleeping = this.state === "sleeping";
    const c = sleeping ? 0x59606e : this.bodyColor;
    this.shadow.clear().ellipse(0, 4, 12, 5).fill({ color: 0x000000, alpha: 0.35 });
    const b = this.body.clear();
    if (sleeping) {
      // Lying down in a bedroll.
      b.roundRect(-14, -6, 28, 10, 5).fill(0x3b4251);
      b.circle(-9, -2, 6).fill(c);
      return;
    }
    b.roundRect(-9, -16, 18, 18, 7).fill(c); // torso
    b.circle(0, -21, 7).fill(0xf0d2b0); // head
    b.rect(-7, -27, 14, 4).fill(c); // cap
    b.circle(3, -21, 1.3).fill(0x1a1a1a); // eye
    b.rect(-7, 1, 5, 4).fill(0x2a2f38); // legs
    b.rect(2, 1, 5, 4).fill(0x2a2f38);
  }

  /** Where the unit wants to be right now. */
  private target(layout: UnitLayout, t: number): Point {
    if (this.state === "working") {
      // Mining loop: walk to the mine, dig, carry back, drop off.
      const period = 7 + this.seed * 3;
      const phase = ((t / period + this.seed) % 1 + 1) % 1;
      const lateral = (this.seed - 0.5) * 40;
      const dx = layout.mine.x - layout.home.x;
      const dy = layout.mine.y - layout.home.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const mine = { x: layout.mine.x - (dx / len) * 34 + nx * lateral, y: layout.mine.y - (dy / len) * 34 + ny * lateral };
      let f: number;
      if (phase < 0.35) f = phase / 0.35;
      else if (phase < 0.55) f = 1;
      else if (phase < 0.9) f = 1 - (phase - 0.55) / 0.35;
      else f = 0;
      this.cargo.visible = phase >= 0.55 && phase < 0.9;
      return { x: layout.home.x + (mine.x - layout.home.x) * f, y: layout.home.y + (mine.y - layout.home.y) * f };
    }
    this.cargo.visible = false;
    if (this.state === "idle" || this.state === "done") {
      // Mill about near home.
      const bucket = Math.floor(t / 5 + this.seed * 10);
      const a = hash(`${this.key}:${bucket}`) * Math.PI * 2;
      return { x: layout.home.x + Math.cos(a) * 14, y: layout.home.y + Math.sin(a) * 10 };
    }
    return layout.home;
  }

  tick(layout: UnitLayout, t: number, dt: number, selected: boolean, zoom: number): void {
    const target = this.target(layout, t);
    const speed = this.state === "working" ? 9 : 2.5;
    const k = Math.min(1, dt * speed);
    const prevX = this.pos.x;
    this.pos.x += (target.x - this.pos.x) * k;
    this.pos.y += (target.y - this.pos.y) * k;
    this.position.set(this.pos.x, this.pos.y);
    this.zIndex = this.pos.y;

    const moving = Math.abs(this.pos.x - prevX) > 0.05;
    if (moving) this.body.scale.x = this.pos.x < prevX ? -1 : 1;
    const bob = this.state === "sleeping" ? 0 : moving ? Math.abs(Math.sin(t * 14 + this.seed * 9)) * 2.5 : Math.sin(t * 2 + this.seed * 9) * 0.6;
    this.body.y = -bob;

    this.cargo.clear();
    if (this.cargo.visible) {
      this.cargo.poly([0, -6, 5, 0, 0, 6, -5, 0]).fill(0x8ff7ff).stroke({ color: 0x2f8fa3, width: 1 });
      this.cargo.position.set(10 * this.body.scale.x, -14 - bob);
    }

    this.drawBadge(t);
    this.drawRing(selected, t);
    // Names only up close, so neighbors' labels don't pile up; always for the selected/hovered unit.
    this.nameText.visible = selected || this.hovered || (zoom > 1.4 && this.state !== "sleeping");
    this.alpha = this.state === "sleeping" && !selected ? 0.8 : 1;
  }

  private drawBadge(t: number): void {
    const b = this.badge.clear();
    const y = this.state === "sleeping" ? -18 : -40;
    const pulse = 1 + Math.sin(t * 6) * 0.12;
    this.badgeText.visible = true;
    this.badgeText.position.set(0, y);
    this.badgeText.scale.set(1);
    switch (this.state) {
      case "alert":
        b.circle(0, y, 9 * pulse).fill(STATE_COLORS.alert).stroke({ color: 0xffffff, width: 2 });
        this.badgeText.text = "!";
        break;
      case "question":
        b.circle(0, y, 9 * pulse).fill(STATE_COLORS.question).stroke({ color: 0xffffff, width: 2 });
        this.badgeText.text = "?";
        break;
      case "error":
        b.circle(0, y, 8).fill(STATE_COLORS.error);
        this.badgeText.text = "x";
        break;
      case "done": {
        const hop = Math.abs(Math.sin(t * 3 + this.seed * 5)) * 3;
        b.circle(0, y - hop, 8).fill(STATE_COLORS.done);
        this.badgeText.text = "✓";
        this.badgeText.y = y - hop;
        break;
      }
      case "working": {
        // Little swinging pick.
        const swing = Math.sin(t * 10 + this.seed * 7) * 0.8;
        b.moveTo(0, y + 6).lineTo(Math.sin(swing) * 10, y + 6 - Math.cos(swing) * 10).stroke({ color: 0xc8b28a, width: 2 });
        b.circle(Math.sin(swing) * 10, y + 6 - Math.cos(swing) * 10, 2.5).fill(0x9aa3ad);
        this.badgeText.visible = false;
        break;
      }
      case "sleeping": {
        const drift = (t * 0.6 + this.seed) % 1;
        this.badgeText.text = "z";
        this.badgeText.position.set(6 + drift * 6, y - drift * 14);
        this.badgeText.alpha = 1 - drift;
        return;
      }
      default:
        this.badgeText.visible = false;
    }
    this.badgeText.alpha = 1;
  }

  private drawRing(selected: boolean, t: number): void {
    const r = this.ring.clear();
    if (selected) {
      r.ellipse(0, 4, 20, 9).stroke({ color: 0x9cff6b, width: 2 });
    } else if (this.state === "alert" || this.state === "question") {
      const grow = (t * 1.2 + this.seed) % 1;
      r.ellipse(0, 4, 14 + grow * 26, 6 + grow * 12).stroke({ color: STATE_COLORS[this.state], width: 2, alpha: 1 - grow });
    } else if (this.hovered) {
      r.ellipse(0, 4, 18, 8).stroke({ color: 0xffffff, width: 1, alpha: 0.6 });
    }
  }
}

class BuildingSprite extends Container {
  private base = new Graphics();
  private mine = new Graphics();
  private nameText = new Text({ text: "", style: { ...LABEL, fontSize: 9 } });
  private mineLabel = new Text({ text: "", style: { ...LABEL, fontSize: 7, fill: 0x8ff7ff } });
  readonly envId: string;
  readonly projectId: string;
  private hovered = false;

  constructor(envId: string, projectId: string, mineLayer: Container) {
    super();
    this.envId = envId;
    this.projectId = projectId;
    this.nameText.anchor.set(0.5, 0);
    this.nameText.resolution = 2;
    this.nameText.y = 34;
    this.mineLabel.anchor.set(0.5, 0);
    this.mineLabel.resolution = 2;
    this.addChild(this.base, this.nameText);
    mineLayer.addChild(this.mine, this.mineLabel);
    this.eventMode = "static";
    this.cursor = "pointer";
    this.hitArea = { contains: (x: number, y: number) => Math.abs(x) < 50 && y > -70 && y < 40 };
    this.on("pointerover", () => (this.hovered = true));
    this.on("pointerout", () => (this.hovered = false));
    this.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      sfx.building();
      setSelection({ kind: "building", envId, projectId });
    });
  }

  update(project: ProjectShell, layout: ProjectLayout, selected: boolean, busy: number, t: number): void {
    this.position.set(layout.building.x, layout.building.y);
    this.zIndex = layout.building.y;
    this.nameText.text = truncate(project.title, 24);

    const g = this.base.clear();
    g.ellipse(0, 22, 62, 20).fill({ color: 0x000000, alpha: 0.3 });
    if (selected || this.hovered) g.ellipse(0, 22, 66, 24).stroke({ color: selected ? 0x9cff6b : 0xffffff, width: 2, alpha: selected ? 1 : 0.6 });
    g.rect(-44, -26, 88, 46).fill(0x8a6a48).stroke({ color: 0x4a3626, width: 2 }); // walls
    g.poly([-52, -24, 0, -62, 52, -24]).fill(0xb2483a).stroke({ color: 0x5a221b, width: 2 }); // roof
    g.rect(-10, -2, 20, 22).fill(0x3a2a1c); // door
    g.rect(-34, -14, 12, 10).fill(busy > 0 ? 0xffe28a : 0x2c3640); // windows light up while busy
    g.rect(22, -14, 12, 10).fill(busy > 0 ? 0xffe28a : 0x2c3640);
    // Chimney smoke while anyone is working.
    g.rect(24, -58, 10, 20).fill(0x6e5a4a);
    if (busy > 0) {
      for (let i = 0; i < 3; i++) {
        const p = (t * 0.5 + i / 3) % 1;
        g.circle(29 + Math.sin(p * 6 + i) * 4, -62 - p * 40, 4 + p * 6).fill({ color: 0xcfcfcf, alpha: 0.5 * (1 - p) });
      }
    }

    // The project's crystal mine.
    const m = this.mine.clear();
    const { x, y } = layout.mine;
    m.ellipse(x, y + 14, 46, 16).fill({ color: 0x000000, alpha: 0.25 });
    m.ellipse(x, y + 8, 40, 14).fill(0x5d5a52);
    const glow = busy > 0 ? 0.6 + Math.sin(t * 4) * 0.3 : 0.25;
    const crystals: Array<[number, number, number]> = [[-16, 4, 14], [0, -6, 22], [16, 2, 16], [-4, 8, 10]];
    for (const [cx, cy, h] of crystals) {
      m.poly([x + cx, y + cy - h, x + cx + 7, y + cy, x + cx, y + cy + 5, x + cx - 7, y + cy]).fill(0x5fd8ee).stroke({ color: 0x2f8fa3, width: 1.5 });
    }
    m.circle(x, y - 4, 30).fill({ color: 0x8ff7ff, alpha: glow * 0.25 });
    this.mineLabel.position.set(x, y + 26);
    this.mineLabel.text = busy > 0 ? `${busy} mining` : "";
  }

  destroyAll(): void {
    this.mine.destroy();
    this.mineLabel.destroy();
    this.destroy({ children: true });
  }
}

class LibrarySprite extends Container {
  private g = new Graphics();
  private nameText = new Text({ text: "", style: { ...LABEL, fontSize: 7, fill: 0xd9c9a3 } });
  readonly envId: string;
  readonly projectId: string;
  private hovered = false;

  constructor(envId: string, projectId: string) {
    super();
    this.envId = envId;
    this.projectId = projectId;
    this.nameText.anchor.set(0.5, 0);
    this.nameText.resolution = 2;
    this.nameText.y = 24;
    this.addChild(this.g, this.nameText);
    this.eventMode = "static";
    this.cursor = "pointer";
    this.hitArea = { contains: (x: number, y: number) => Math.abs(x) < 38 && y > -60 && y < 30 };
    this.on("pointerover", () => (this.hovered = true));
    this.on("pointerout", () => (this.hovered = false));
    this.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      sfx.building();
      setSelection({ kind: "library", envId, projectId });
    });
  }

  update(layout: ProjectLayout, selected: boolean): void {
    this.position.set(layout.library.x, layout.library.y);
    this.zIndex = layout.library.y;
    const g = this.g.clear();
    g.ellipse(0, 16, 40, 13).fill({ color: 0x000000, alpha: 0.3 });
    if (selected || this.hovered) g.ellipse(0, 16, 44, 16).stroke({ color: selected ? 0x9cff6b : 0xffffff, width: 2, alpha: selected ? 1 : 0.6 });
    // A small stone archive with a dome.
    g.rect(-28, -18, 56, 32).fill(0x8d8577).stroke({ color: 0x4a453d, width: 2 });
    g.arc(0, -18, 22, Math.PI, 0).fill(0x6f8aa0).stroke({ color: 0x34424e, width: 2 });
    for (const x of [-20, -8, 4, 16]) g.rect(x, -14, 4, 26).fill(0xb3ab9c); // columns
    // Book stack out front grows with the archive (one book per ~2 imports, capped).
    const books = Math.min(8, Math.ceil(layout.archived / 2));
    const colors = [0xb2483a, 0x3a6fb2, 0x4f8a3a, 0xc9a23a];
    for (let i = 0; i < books; i++) g.rect(30 - (i % 2), 10 - i * 4, 14, 4).fill(colors[i % colors.length]).stroke({ color: 0x1a1a1a, width: 1 });
    this.nameText.text = `Archive (${layout.archived})`;
  }
}

class HqSprite extends Container {
  private g = new Graphics();
  private nameText = new Text({ text: "", style: { ...LABEL, fontSize: 11 } });
  private status = new Text({ text: "", style: { ...LABEL, fontSize: 7 } });

  constructor() {
    super();
    this.nameText.anchor.set(0.5, 0);
    this.nameText.resolution = 2;
    this.nameText.y = 48;
    this.status.anchor.set(0.5, 0);
    this.status.resolution = 2;
    this.status.y = 66;
    this.addChild(this.g, this.nameText, this.status);
  }

  update(env: EnvWorld, at: Point, t: number): void {
    this.position.set(at.x, at.y);
    this.zIndex = at.y;
    const color = CONNECTION_COLORS[env.connection] ?? 0x888888;
    const g = this.g.clear();
    g.ellipse(0, 30, 90, 30).fill({ color: 0x000000, alpha: 0.3 });
    g.poly([-60, 30, -50, -20, 50, -20, 60, 30]).fill(0x59616e).stroke({ color: 0x2b3038, width: 3 });
    g.rect(-30, -60, 60, 42).fill(0x6c7684).stroke({ color: 0x2b3038, width: 3 });
    g.rect(-6, -100, 4, 42).fill(0x2b3038); // flagpole
    const wave = Math.sin(t * 3) * 3;
    g.poly([-2, -100, 26, -94 + wave, -2, -86]).fill(color);
    g.circle(0, -38, 10).fill({ color, alpha: env.connection === "live" ? 0.9 : 0.4 + Math.sin(t * 5) * 0.3 });
    this.nameText.text = truncate(env.summary.label, 28);
    this.status.text = env.connection === "live" ? `T3 ${env.summary.serverVersion ?? ""}`.trim() : env.connection.toUpperCase();
  }
}

// ---- World -----------------------------------------------------------------------------

export class World {
  private app = new Application();
  private camera = new Container();
  private ground = new Graphics();
  private mines = new Container();
  private entities = new Container();
  private units = new Map<string, UnitSprite>();
  private buildings = new Map<string, BuildingSprite>();
  private libraries = new Map<string, LibrarySprite>();
  private hqs = new Map<string, HqSprite>();
  private layout: Layout = computeLayout(useGame.getState());
  private zoom = 1;
  private time = 0;
  private unsubscribe?: () => void;
  private fittedOnce = false;
  private destroyed = false;
  private ready: Promise<void>;

  constructor(host: HTMLElement) {
    this.ready = this.init(host);
  }

  private async init(host: HTMLElement): Promise<void> {
    await this.app.init({ resizeTo: host, background: 0x24361f, antialias: true, autoDensity: true, resolution: window.devicePixelRatio || 1 });
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    host.appendChild(this.app.canvas);
    this.entities.sortableChildren = true;
    this.camera.addChild(this.ground, this.mines, this.entities);
    this.app.stage.addChild(this.camera);
    this.setupCamera();

    this.sync(useGame.getState());
    this.unsubscribe = useGame.subscribe((s) => this.sync(s));
    this.app.ticker.add((ticker) => this.tick(ticker.deltaMS / 1000));
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe?.();
    void this.ready.then(() => {
      if (this.app.renderer) this.app.destroy(true, { children: true });
    });
  }

  // ---- Camera ----

  private setupCamera(): void {
    const stage = this.app.stage;
    stage.eventMode = "static";
    stage.hitArea = this.app.screen;
    let drag: { x: number; y: number; camX: number; camY: number; moved: boolean } | null = null;
    stage.on("pointerdown", (e: FederatedPointerEvent) => {
      drag = { x: e.global.x, y: e.global.y, camX: this.camera.x, camY: this.camera.y, moved: false };
    });
    stage.on("globalpointermove", (e: FederatedPointerEvent) => {
      if (!drag || e.buttons === 0) return;
      const dx = e.global.x - drag.x;
      const dy = e.global.y - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) this.camera.position.set(drag.camX + dx, drag.camY + dy);
    });
    const end = () => {
      drag = null;
    };
    stage.on("pointerup", (e: FederatedPointerEvent) => {
      // A click on empty ground clears the selection.
      if (drag && !drag.moved && e.target === stage) setSelection(null);
      end();
    });
    stage.on("pointerupoutside", end);
    this.app.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = this.app.canvas.getBoundingClientRect();
        this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );
  }

  private zoomAt(sx: number, sy: number, factor: number): void {
    const next = Math.min(2.5, Math.max(0.25, this.zoom * factor));
    const wx = (sx - this.camera.x) / this.zoom;
    const wy = (sy - this.camera.y) / this.zoom;
    this.zoom = next;
    this.camera.scale.set(next);
    this.camera.position.set(sx - wx * next, sy - wy * next);
  }

  fitAll(): void {
    const b = this.layout.bounds;
    const { width, height } = this.app.screen;
    const zoom = Math.min(1.2, Math.max(0.25, Math.min(width / (b.maxX - b.minX), height / (b.maxY - b.minY))));
    this.zoom = zoom;
    this.camera.scale.set(zoom);
    this.camera.position.set(width / 2 - ((b.minX + b.maxX) / 2) * zoom, height / 2 - ((b.minY + b.maxY) / 2) * zoom);
  }

  /** Center the camera on a unit or building. */
  focus(selection: Selection): void {
    if (!selection) return;
    let p: Point | undefined;
    if (selection.kind === "unit") p = this.units.get(unitKey(selection.envId, selection.threadId))?.pos;
    else if (selection.kind === "library") p = this.layout.projects.get(`${selection.envId}:${selection.projectId}`)?.library;
    else p = this.layout.projects.get(`${selection.envId}:${selection.projectId}`)?.building;
    if (!p) return;
    const { width, height } = this.app.screen;
    // Leave room for the side panel on the right.
    const zoom = Math.max(this.zoom, 1);
    this.zoom = zoom;
    this.camera.scale.set(zoom);
    this.camera.position.set(width * 0.38 - p.x * zoom, height / 2 - p.y * zoom);
  }

  // ---- Sync with the store ----

  private sync(state: GameState): void {
    this.layout = computeLayout(state);
    const seenUnits = new Set<string>();
    const seenBuildings = new Set<string>();
    const seenHqs = new Set<string>();

    for (const env of Object.values(state.envs)) {
      const envId = env.summary.id;
      seenHqs.add(envId);
      if (!this.hqs.has(envId)) {
        const hq = new HqSprite();
        this.hqs.set(envId, hq);
        this.entities.addChild(hq);
      }
      for (const project of Object.values(env.projects)) {
        const key = `${envId}:${project.id}`;
        seenBuildings.add(key);
        if (!this.buildings.has(key)) {
          const b = new BuildingSprite(envId, project.id, this.mines);
          this.buildings.set(key, b);
          this.entities.addChild(b);
        }
        if ((this.layout.projects.get(key)?.archived ?? 0) > 0 && !this.libraries.has(key)) {
          const lib = new LibrarySprite(envId, project.id);
          this.libraries.set(key, lib);
          this.entities.addChild(lib);
        }
      }
      for (const thread of Object.values(env.threads)) {
        const key = unitKey(envId, thread.id);
        const layout = this.layout.units.get(key);
        if (!layout) continue; // thread in a project we don't know about
        seenUnits.add(key);
        let unit = this.units.get(key);
        if (!unit) {
          // New recruits walk out of their building.
          const building = this.layout.projects.get(`${envId}:${thread.projectId}`)?.building ?? layout.home;
          unit = new UnitSprite(key, envId, thread.id, this.fittedOnce ? { x: building.x, y: building.y + 10 } : layout.home);
          this.units.set(key, unit);
          this.entities.addChild(unit);
        }
        unit.setThread(thread);
      }
    }

    for (const [key, unit] of this.units) {
      if (seenUnits.has(key)) continue;
      unit.destroy({ children: true });
      this.units.delete(key);
    }
    for (const [key, building] of this.buildings) {
      if (seenBuildings.has(key)) continue;
      building.destroyAll();
      this.buildings.delete(key);
    }
    for (const [key, lib] of this.libraries) {
      if (seenBuildings.has(key) && (this.layout.projects.get(key)?.archived ?? 0) > 0) continue;
      lib.destroy({ children: true });
      this.libraries.delete(key);
    }
    for (const [key, hq] of this.hqs) {
      if (seenHqs.has(key)) continue;
      hq.destroy({ children: true });
      this.hqs.delete(key);
    }

    if (!this.fittedOnce && Object.values(state.envs).some((e) => e.synced)) {
      this.fittedOnce = true;
      this.drawGround();
      this.fitAll();
    }
  }

  private drawGround(): void {
    const g = this.ground.clear();
    const b = this.layout.bounds;
    const pad = 1500;
    // Scattered grass tufts and pebbles, seeded so they stay put.
    for (let i = 0; i < 900; i++) {
      const x = b.minX - pad + hash(`gx${i}`) * (b.maxX - b.minX + pad * 2);
      const y = b.minY - pad + hash(`gy${i}`) * (b.maxY - b.minY + pad * 2);
      if (hash(`gk${i}`) < 0.8) g.rect(x, y, 3, 6).fill({ color: 0x3c5a2e, alpha: 0.8 });
      else g.circle(x, y, 3).fill({ color: 0x5b5f55, alpha: 0.7 });
    }
    // A dirt clearing around each base.
    for (const hq of this.layout.hq.values()) {
      g.circle(hq.x, hq.y, PROJECT_RING + 120).fill({ color: 0x4a3f2c, alpha: 0.35 });
      g.circle(hq.x, hq.y, 170).fill({ color: 0x5a4c34, alpha: 0.45 });
    }
  }

  // ---- Frame ----

  private tick(dt: number): void {
    this.time += dt;
    const state = useGame.getState();
    const t = this.time;
    const sel = state.selection;

    const busyByBuilding = new Map<string, number>();
    for (const unit of this.units.values()) {
      if (unit.state !== "working") continue;
      const key = `${unit.envId}:${unit.thread.projectId}`;
      busyByBuilding.set(key, (busyByBuilding.get(key) ?? 0) + 1);
    }

    for (const [envId, hq] of this.hqs) {
      const env = state.envs[envId];
      const at = this.layout.hq.get(envId);
      if (env && at) hq.update(env, at, t);
    }
    for (const [key, building] of this.buildings) {
      const project = state.envs[building.envId]?.projects[building.projectId];
      const layout = this.layout.projects.get(key);
      if (!project || !layout) continue;
      const selected = sel?.kind === "building" && sel.envId === building.envId && sel.projectId === building.projectId;
      building.update(project, layout, selected, busyByBuilding.get(key) ?? 0, t);
    }
    for (const [key, lib] of this.libraries) {
      const layout = this.layout.projects.get(key);
      if (!layout) continue;
      lib.update(layout, sel?.kind === "library" && `${sel.envId}:${sel.projectId}` === key);
    }
    for (const [key, unit] of this.units) {
      const layout = this.layout.units.get(key);
      if (!layout) continue;
      const selected = sel?.kind === "unit" && sel.envId === unit.envId && sel.threadId === unit.threadId;
      unit.tick(layout, t, dt, selected, this.zoom);
    }
  }
}

/** The live map, for hotkeys and panels that need to move the camera. */
export const worldRef: { current: World | null } = { current: null };
