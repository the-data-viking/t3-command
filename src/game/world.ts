// The fleet map, rendered with PixiJS. A view of the game store: it reads state, and clicks
// become store selections. All art is procedural (vector "tactical display" style) so a sprite
// set can replace it later without touching layout or behavior.
//
// Rule borrowed from StarNet: the map never shows activity T3 can't prove. Consoles light up
// only during a real turn, crew walk to a workstation only for a real open tool call, and idle
// crew stand still.

import {
  Application,
  Container,
  Graphics,
  Rectangle,
  Text,
  TilingSprite,
  type FederatedPointerEvent,
  type TextStyleOptions,
} from "pixi.js";
import { setSelection, unitKey, useGame, type EnvWorld, type GameState, type Selection } from "../store";
import { isHistory, unitState, type UnitState } from "../t3/derive";
import { telemetry, type Telemetry } from "../t3/telemetry";
import type { ThreadShell } from "../t3/types";
import { computeFleetLayout, type CrewLayout, type FleetLayout, type ModuleLayout, type Point, type Rect, type StationLayout } from "./layout";
import { sfx } from "./sfx";
import { HUD, PROVIDER_VISOR, STATUS } from "./theme";

const FONT = "'Chakra Petch', 'IBM Plex Mono', ui-monospace, monospace";
const MONO = "'IBM Plex Mono', ui-monospace, monospace";

function label(size: number, fill: number, extra: Partial<TextStyleOptions> = {}): Text {
  const t = new Text({ text: "", style: { fontFamily: FONT, fontSize: size, fill, fontWeight: "600", letterSpacing: 1, ...extra } });
  t.resolution = 3;
  return t;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Zoom below which stations collapse to their banners and fine detail fades. */
const STRATEGIC_ZOOM = 0.55;

// ---- Crew ------------------------------------------------------------------------------

class CrewSprite extends Container {
  readonly key: string;
  readonly envId: string;
  readonly threadId: string;
  private seed: number;
  private shadow = new Graphics();
  private ring = new Graphics();
  private body = new Graphics();
  private fx = new Graphics();
  private nameText = label(7, HUD.text);
  pos: Point;
  state: UnitState = "idle";
  thread!: ThreadShell;
  info?: Telemetry;
  hovered = false;
  /** Whether the crew member is currently at its own console (vs. a workstation or bunk). */
  atConsole = true;

  constructor(layout: CrewLayout, start: Point) {
    super();
    this.key = layout.key;
    this.envId = layout.envId;
    this.threadId = layout.threadId;
    this.seed = hash(layout.key);
    this.pos = { ...start };
    this.nameText.anchor.set(0.5, 0);
    this.nameText.y = 8;
    this.addChild(this.ring, this.shadow, this.body, this.fx, this.nameText);
    this.eventMode = "static";
    this.cursor = "pointer";
    this.hitArea = new Rectangle(-10, -26, 20, 32);
    this.on("pointerover", () => (this.hovered = true));
    this.on("pointerout", () => (this.hovered = false));
    this.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      sfx.select();
      setSelection({ kind: "unit", envId: this.envId, threadId: this.threadId });
    });
  }

  update(thread: ThreadShell, info: Telemetry | undefined): void {
    this.thread = thread;
    this.state = unitState(thread);
    this.info = info;
    this.nameText.text = truncate((thread.title || "Untitled").toUpperCase(), 26);
  }

  private target(layout: CrewLayout, modules: Map<string, ModuleLayout>): Point {
    if (this.state === "working" && this.info && this.info.workstation !== "console") {
      const ws = modules.get(layout.moduleKey)?.workstations[this.info.workstation];
      if (ws) return { x: ws.x + (this.seed - 0.5) * 22, y: ws.y + 16 };
    }
    return layout.home;
  }

  tick(layout: CrewLayout, modules: Map<string, ModuleLayout>, t: number, dt: number, selected: boolean, zoom: number): void {
    const target = this.target(layout, modules);
    const k = Math.min(1, dt * 3.2);
    const px = this.pos.x;
    const py = this.pos.y;
    this.pos.x += (target.x - this.pos.x) * k;
    this.pos.y += (target.y - this.pos.y) * k;
    const moving = Math.hypot(this.pos.x - px, this.pos.y - py) > 0.08;
    this.atConsole = !layout.sleeping && Math.hypot(this.pos.x - layout.home.x, this.pos.y - layout.home.y) < 3;
    this.position.set(this.pos.x, this.pos.y);
    this.zIndex = this.pos.y;

    // Up close crew are drawn at true size; zoomed out they grow a little so they stay visible.
    const scale = zoom < STRATEGIC_ZOOM ? Math.min(2.2, STRATEGIC_ZOOM / zoom) : 1;
    this.scale.set(scale);

    this.drawBody(t, moving);
    this.drawFx(t, selected, zoom);
    this.drawRing(selected, t);
    this.nameText.visible = !layout.sleeping && (selected || this.hovered || zoom > 1.6);
  }

  private drawBody(t: number, moving: boolean): void {
    const b = this.body.clear();
    const s = this.shadow.clear();
    const visor = PROVIDER_VISOR[this.thread.modelSelection.instanceId] ?? 0x9fb3d1;
    if (this.state === "sleeping") {
      // Lying in a bunk with the lights off.
      b.roundRect(-7, -4, 14, 6, 3).fill(0x3b4352);
      b.circle(-5, -2, 3).fill(0x59616f);
      return;
    }
    s.ellipse(0, 1, 7, 2.5).fill({ color: 0x000000, alpha: 0.5 });
    const step = moving ? Math.sin(t * 16 + this.seed * 9) : 0;
    const typing = this.state === "working" && this.atConsole ? Math.sin(t * 22 + this.seed * 5) * 0.8 : 0;
    // legs
    b.rect(-4, -4 + Math.max(0, step) * 1.5, 3, 4).fill(0xaeb8c4);
    b.rect(1, -4 + Math.max(0, -step) * 1.5, 3, 4).fill(0xaeb8c4);
    // suit + backpack
    b.roundRect(-6, -14, 12, 11, 3).fill(0xdde4ec);
    b.rect(-7, -13, 2, 7).fill(0x9aa5b2);
    // arms (typing at the console moves them)
    b.rect(5, -12 + typing, 2, 5).fill(0xc9d2dc);
    b.rect(-5, -12 - typing, 2, 5).fill(0xc9d2dc);
    // helmet + visor in the provider's color
    b.circle(0, -18, 6).fill(0xeef2f6);
    b.roundRect(-1, -21, 6, 5, 2).fill(visor);
    b.rect(1, -20, 2, 1).fill({ color: 0xffffff, alpha: 0.6 });
  }

  private drawFx(t: number, selected: boolean, zoom: number): void {
    const f = this.fx.clear();
    const y = -32;
    const pulse = 1 + Math.sin(t * 7) * 0.15;
    switch (this.state) {
      case "alert":
        f.poly([0, y - 8 * pulse, 7 * pulse, y, 0, y + 8 * pulse, -7 * pulse, y]).fill(STATUS.alert).stroke({ color: 0xffffff, width: 1.5 });
        f.rect(-1, y - 4, 2, 5).fill(0xffffff).rect(-1, y + 2.5, 2, 2).fill(0xffffff);
        break;
      case "question":
        f.circle(0, y, 7 * pulse).fill(STATUS.question).stroke({ color: 0xffffff, width: 1.5 });
        f.rect(-1, y + 2, 2, 2).fill(0x111111).rect(-1, y - 4, 2, 4).fill(0x111111);
        break;
      case "done":
        f.circle(0, y + 2, 5).fill(STATUS.done);
        f.moveTo(-2.5, y + 2).lineTo(-0.5, y + 4).lineTo(3, y - 0.5).stroke({ color: 0x08210f, width: 1.5 });
        break;
      case "error":
        f.circle(0, y + 2, 5).fill(STATUS.error);
        f.moveTo(-2, y).lineTo(2, y + 4).moveTo(2, y).lineTo(-2, y + 4).stroke({ color: 0x2a0d00, width: 1.5 });
        break;
      case "working": {
        const a = t * 5 + this.seed * 6;
        f.arc(0, y + 2, 4, a, a + Math.PI * 1.3).stroke({ color: STATUS.working, width: 1.5 });
        break;
      }
    }
    // Drones: one per running background task (subagent, shell…).
    const tasks = Math.min(4, this.info?.tasks ?? 0);
    for (let i = 0; i < tasks; i++) {
      const a = t * 2.2 + (i / tasks) * Math.PI * 2;
      f.circle(Math.cos(a) * 13, -12 + Math.sin(a) * 6, 1.8).fill(STATUS.working);
    }
    // Context window as a health bar (only when T3 has reported it).
    const ctx = this.info?.context;
    if (ctx !== undefined && (selected || this.hovered || zoom > 1.3)) {
      const left = 1 - ctx;
      const color = left > 0.4 ? STATUS.done : left > 0.15 ? STATUS.question : STATUS.alert;
      f.rect(-9, 4, 18, 2.5).fill({ color: 0x000000, alpha: 0.7 });
      f.rect(-9, 4, 18 * left, 2.5).fill(color);
    }
  }

  private drawRing(selected: boolean, t: number): void {
    const r = this.ring.clear();
    if (selected) {
      r.ellipse(0, 1, 12, 5).stroke({ color: HUD.amber, width: 1.5 });
    } else if (this.state === "alert" || this.state === "question") {
      const g = (t * 1.1 + this.seed) % 1;
      r.ellipse(0, 1, 8 + g * 20, 3 + g * 8).stroke({ color: STATUS[this.state], width: 1.5, alpha: 1 - g });
    } else if (this.hovered) {
      r.ellipse(0, 1, 11, 4.5).stroke({ color: 0xffffff, width: 1, alpha: 0.6 });
    }
  }
}

// ---- Stations --------------------------------------------------------------------------

/** Static hull geometry for one station, plus its live lights and screen-space banner. */
class StationSprite {
  readonly envId: string;
  readonly hull = new Container();
  readonly lights = new Graphics();
  readonly banner = new Container();
  private bannerBg = new Graphics();
  private bannerName = label(13, HUD.text, { fontWeight: "700", letterSpacing: 2 });
  private bannerStatus = new Text({ text: "", style: { fontFamily: MONO, fontSize: 11, fill: HUD.muted, letterSpacing: 0.5 } });
  private moduleLabels: Text[] = [];
  layout!: StationLayout;

  constructor(envId: string) {
    this.envId = envId;
    this.bannerStatus.resolution = 3;
    this.bannerName.position.set(14, 6);
    this.bannerStatus.position.set(14, 26);
    this.banner.addChild(this.bannerBg, this.bannerName, this.bannerStatus);
    this.banner.eventMode = "static";
    this.banner.cursor = "pointer";
    this.banner.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      sfx.building();
      worldRef.current?.focusStation(envId);
    });
  }

  /** Redraw the hull (called when the layout changes, not every frame). */
  build(layout: StationLayout, env: EnvWorld): void {
    this.layout = layout;
    for (const child of this.hull.removeChildren()) child.destroy({ children: true });
    this.moduleLabels = [];
    const team = layout.color;
    const g = new Graphics();
    this.hull.addChild(g);

    // Corridors first, so rooms sit on top of them.
    for (const m of layout.modules) {
      const [a, b] = m.corridor;
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: HUD.hullEdge, width: 26 });
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: HUD.hull, width: 20 });
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: team, width: 2, alpha: 0.5 });
    }

    // Core hub: an octagon with the team color ring.
    const c = layout.center;
    const oct = (r: number) => {
      const pts: number[] = [];
      for (let i = 0; i < 8; i++) {
        const a = Math.PI / 8 + (i * Math.PI) / 4;
        pts.push(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r);
      }
      return pts;
    };
    g.poly(oct(layout.coreRadius + 6)).fill(HUD.hullEdge);
    g.poly(oct(layout.coreRadius)).fill(HUD.hull).stroke({ color: team, width: 2.5 });
    g.poly(oct(layout.coreRadius - 16)).fill(HUD.floor).stroke({ color: HUD.hullLight, width: 1.5 });
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + Math.PI / 4;
      g.rect(c.x + Math.cos(a) * (layout.coreRadius - 8) - 2, c.y + Math.sin(a) * (layout.coreRadius - 8) - 2, 4, 4).fill(HUD.amber);
    }

    for (const m of layout.modules) this.buildModule(g, m, env, team);
  }

  private buildModule(g: Graphics, m: ModuleLayout, env: EnvWorld, team: number): void {
    const r = m.room;
    // Hull walls, floor tiles, team stripe.
    g.rect(r.x - 6, r.y - 6, r.w + 12, r.h + 12).fill(HUD.hullEdge);
    g.rect(r.x - 3, r.y - 3, r.w + 6, r.h + 6).fill(HUD.hull).stroke({ color: HUD.hullLight, width: 1 });
    g.rect(r.x, r.y, r.w, r.h).fill(HUD.floor);
    for (let x = r.x + 12; x < r.x + r.w; x += 24) g.moveTo(x, r.y).lineTo(x, r.y + r.h).stroke({ color: HUD.floorTile, width: 1 });
    for (let y = r.y + 12; y < r.y + r.h; y += 24) g.moveTo(r.x, y).lineTo(r.x + r.w, y).stroke({ color: HUD.floorTile, width: 1 });
    g.rect(r.x - 3, r.y - 3, r.w + 6, 3).fill(team);
    // Corner bolts.
    for (const [x, y] of [[r.x - 3, r.y - 3], [r.x + r.w, r.y - 3], [r.x - 3, r.y + r.h], [r.x + r.w, r.y + r.h]] as const) {
      g.rect(x, y, 3, 3).fill(HUD.amberDim);
    }

    // Workstation strip: terminal, file archive, comms dish.
    const strip = { x: r.x, y: r.y, w: r.w, h: 40 };
    g.rect(strip.x, strip.y, strip.w, strip.h).fill({ color: 0x0b0f15, alpha: 0.8 });
    g.moveTo(strip.x, strip.y + strip.h).lineTo(strip.x + strip.w, strip.y + strip.h).stroke({ color: HUD.amberDim, width: 1, alpha: 0.8 });
    const { terminal, files, comms } = m.workstations;
    g.roundRect(terminal.x - 11, terminal.y - 12, 22, 14, 2).fill(0x202a36).stroke({ color: 0x3a4757, width: 1 });
    g.rect(terminal.x - 8, terminal.y - 9, 16, 8).fill(0x06231a);
    g.rect(files.x - 9, files.y - 14, 18, 18).fill(0x2a3240).stroke({ color: 0x3a4757, width: 1 });
    for (let i = 0; i < 3; i++) g.rect(files.x - 7, files.y - 12 + i * 6, 14, 4).fill(0x3a4554);
    g.moveTo(comms.x, comms.y + 2).lineTo(comms.x, comms.y - 6).stroke({ color: 0x5b6676, width: 2 });
    g.arc(comms.x, comms.y - 6, 9, Math.PI * 1.05, Math.PI * 1.95).stroke({ color: 0xaeb8c4, width: 2.5 });
    g.circle(comms.x, comms.y - 10, 1.5).fill(HUD.amber);

    // Console desks (screens are drawn live in drawLights).
    for (const p of m.consoles) {
      g.roundRect(p.x - 15, p.y - 4, 30, 9, 2).fill(0x232c38).stroke({ color: 0x334051, width: 1 });
      g.rect(p.x - 12, p.y - 13, 24, 9).fill(0x0a0e13);
      g.rect(p.x - 4, p.y + 13, 8, 5).fill(0x2b3442); // chair
    }

    // Quarters: bunks for settled crew.
    if (m.quarters) {
      const q = m.quarters;
      g.rect(q.x, q.y, q.w, q.h).fill({ color: 0x0b0e13, alpha: 0.9 }).stroke({ color: 0x1f2631, width: 1 });
      for (let x = q.x + 4; x < q.x + q.w - 14; x += 18) {
        for (let y = q.y + 6; y < q.y + q.h - 8; y += 16) g.roundRect(x, y, 16, 10, 2).fill(0x161b23);
      }
    }

    // Archive pod for imported history.
    if (m.archive) {
      const a = m.archive;
      g.rect(a.x - 4, a.y - 4, a.w + 8, a.h + 8).fill(HUD.hullEdge);
      g.rect(a.x, a.y, a.w, a.h).fill(0x161c26).stroke({ color: 0x6f8aa0, width: 1.5 });
      for (let i = 0; i < 4; i++) g.rect(a.x + 6 + i * 9, a.y + 8, 6, a.h - 16).fill(0x22344a).stroke({ color: 0x3f6a8f, width: 1 });
      const hit = new Container();
      hit.eventMode = "static";
      hit.cursor = "pointer";
      hit.hitArea = new Rectangle(a.x - 4, a.y - 4, a.w + 8, a.h + 8);
      hit.on("pointertap", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        sfx.building();
        setSelection({ kind: "library", envId: m.envId, projectId: m.projectId });
      });
      this.hull.addChild(hit);
    }

    // The whole room selects the module (project).
    const room = new Container();
    room.eventMode = "static";
    room.cursor = "pointer";
    room.hitArea = new Rectangle(r.x - 6, r.y - 6, r.w + 12, r.h + 12);
    room.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      sfx.building();
      setSelection({ kind: "building", envId: m.envId, projectId: m.projectId });
    });
    this.hull.addChildAt(room, 0);

    const project = env.projects[m.projectId];
    const name = label(8, HUD.amber, { letterSpacing: 1.5 });
    name.text = truncate((project?.title ?? "?").toUpperCase(), 28) + (m.archived ? `  ·  ARCHIVE ${m.archived}` : "");
    name.anchor.set(0, 1);
    name.position.set(r.x - 2, r.y - 9);
    this.hull.addChild(name);
    this.moduleLabels.push(name);
  }

  /** Live per-frame details: console screens, core glow, labels, banner. */
  drawLights(env: EnvWorld, crew: Map<string, CrewSprite>, layouts: FleetLayout, t: number, zoom: number, selection: Selection): void {
    const g = this.lights.clear();
    const live = env.connection === "live";
    const L = this.layout;
    const counts = { working: 0, attention: 0, done: 0, total: 0 };
    const terminalBusy = new Set<string>();

    for (const m of L.modules) {
      const selected = selection && selection.kind !== "unit" && selection.envId === m.envId && selection.projectId === m.projectId;
      if (selected) {
        const r = m.room;
        g.rect(r.x - 8, r.y - 8, r.w + 16, r.h + 16).stroke({ color: HUD.amber, width: 2 });
      }
    }

    for (const sprite of crew.values()) {
      if (sprite.envId !== this.envId) continue;
      const lay = layouts.crew.get(sprite.key);
      counts.total++;
      if (sprite.state === "working") counts.working++;
      if (sprite.state === "alert" || sprite.state === "question") counts.attention++;
      if (sprite.state === "done") counts.done++;
      if (sprite.state === "working" && sprite.info?.workstation === "terminal" && lay) terminalBusy.add(lay.moduleKey);
      if (!lay?.console) continue;
      const p = lay.console;
      // Screen color = what the crew member at this console is actually doing.
      let color: number = 0x1a2430;
      let alpha = 1;
      switch (sprite.state) {
        case "working":
          color = STATUS.working;
          alpha = sprite.atConsole ? 0.75 + Math.sin(t * 18 + p.x) * 0.2 : 0.35;
          break;
        case "alert":
        case "question":
          color = STATUS[sprite.state];
          alpha = 0.5 + Math.sin(t * 6) * 0.4;
          break;
        case "done":
          color = STATUS.done;
          alpha = 0.55;
          break;
        case "error":
          color = STATUS.error;
          alpha = 0.6;
          break;
      }
      if (!live) alpha *= 0.25;
      g.rect(p.x - 12, p.y - 13, 24, 9).fill({ color, alpha });
      if (sprite.state === "working" && sprite.atConsole && live) {
        for (let i = 0; i < 3; i++) g.rect(p.x - 10, p.y - 11 + i * 2.5, 6 + ((t * 30 + i * 7 + p.x) % 14), 1).fill({ color: 0xffffff, alpha: 0.35 });
      }
    }

    // Terminal screens glow while someone is running a command there.
    for (const m of L.modules) {
      const p = m.workstations.terminal;
      const busy = terminalBusy.has(m.key) && live;
      g.rect(p.x - 8, p.y - 9, 16, 8).fill({ color: 0x3dff8a, alpha: busy ? 0.5 + Math.sin(t * 20) * 0.3 : 0.08 });
    }

    // Core glow reflects the connection.
    const c = L.center;
    const coreColor = live ? L.color : env.connection === "reconnecting" || env.connection === "connecting" ? STATUS.question : 0x3a4250;
    g.circle(c.x, c.y, 18 + (live ? Math.sin(t * 2) * 2 : 0)).fill({ color: coreColor, alpha: live ? 0.25 : 0.15 });
    g.circle(c.x, c.y, 8).fill({ color: coreColor, alpha: live ? 0.9 : 0.4 });

    this.hull.alpha = live ? 1 : 0.45;
    for (const l of this.moduleLabels) {
      l.visible = zoom > 0.3;
      l.scale.set(Math.max(1, 0.9 / zoom));
    }

    this.drawBanner(env, counts, zoom);
  }

  private drawBanner(env: EnvWorld, counts: { working: number; attention: number; done: number; total: number }, zoom: number): void {
    const L = this.layout;
    const live = env.connection === "live";
    // Constant on-screen size regardless of zoom.
    const s = 1 / zoom;
    const scale = s * (zoom < STRATEGIC_ZOOM ? 1.15 : 0.9);
    this.banner.scale.set(scale);
    // Sit above the module name labels (which keep a minimum on-screen size) with a small gap.
    const labelHeight = 14 * Math.max(1, 0.9 / zoom);
    this.banner.position.set(L.bounds.x, L.bounds.y - 10 - labelHeight - 8 * s - 44 * scale);
    this.bannerName.text = env.summary.label.toUpperCase();
    const status = live
      ? [
          "● LIVE",
          counts.attention && `${counts.attention} ALERT${counts.attention > 1 ? "S" : ""}`,
          counts.working && `${counts.working} ACTIVE`,
          counts.done && `${counts.done} REPORT${counts.done > 1 ? "S" : ""}`,
          `${counts.total} CREW`,
        ]
          .filter(Boolean)
          .join(" · ")
      : env.connection === "needs-update"
        ? "▲ NEEDS T3-COMMAND UPDATE"
        : env.connection === "needs-pairing"
          ? "▲ NEEDS PAIRING"
          : env.connection === "offline"
            ? "○ OFFLINE"
            : "◌ NO SIGNAL · RETRYING";
    this.bannerStatus.text = status;
    this.bannerStatus.style.fill = !live ? STATUS.question : counts.attention ? STATUS.alert : HUD.muted;
    const w = Math.max(this.bannerName.width, this.bannerStatus.width) + 28;
    const b = this.bannerBg.clear();
    b.rect(0, 0, w, 44).fill({ color: 0x05080d, alpha: 0.85 }).stroke({ color: live ? L.color : 0x3a4250, width: 1, alpha: 0.8 });
    b.rect(0, 0, 4, 44).fill(live ? L.color : 0x3a4250);
    // HUD corner brackets
    b.moveTo(w - 10, 0).lineTo(w, 0).lineTo(w, 10).stroke({ color: HUD.amber, width: 1.5 });
    b.moveTo(w, 34).lineTo(w, 44).lineTo(w - 10, 44).stroke({ color: HUD.amber, width: 1.5 });
    if (counts.attention && live) b.rect(w - 8, 18, 4, 8).fill(STATUS.alert);
  }

  destroy(): void {
    this.hull.destroy({ children: true });
    this.lights.destroy();
    this.banner.destroy({ children: true });
  }
}

// ---- World -----------------------------------------------------------------------------

export interface MinimapData {
  bounds: Rect;
  stations: Array<{ rect: Rect; color: number; live: boolean }>;
  dots: Array<{ x: number; y: number; color: number; big: boolean }>;
  view: Rect;
}

export class World {
  private app = new Application();
  private sky?: TilingSprite;
  private camera = new Container();
  private grid = new Graphics();
  private hulls = new Container();
  private lights = new Container();
  private crewLayer = new Container();
  private banners = new Container();
  private edge = new Graphics();
  private edgeHits = new Container();
  private stations = new Map<string, StationSprite>();
  private crew = new Map<string, CrewSprite>();
  private layout: FleetLayout = { stations: new Map(), modules: new Map(), crew: new Map(), bounds: { x: 0, y: 0, w: 0, h: 0 } };
  private zoom = 1;
  private time = 0;
  private fitted = false;
  /** Set once the user pans, zooms or jumps somewhere; until then the view keeps fitting the fleet. */
  private userMoved = false;
  private destroyed = false;
  /** Pixi finished initializing; until then the camera API is a no-op. */
  private initialized = false;
  private unsubscribe?: () => void;
  private ready: Promise<void>;
  private lastEnvs?: GameState["envs"];
  private lastDetails?: GameState["details"];

  constructor(host: HTMLElement) {
    this.ready = this.init(host);
  }

  private async init(host: HTMLElement): Promise<void> {
    await this.app.init({ resizeTo: host, background: HUD.space, antialias: true, autoDensity: true, resolution: window.devicePixelRatio || 1 });
    try {
      await Promise.all([document.fonts.load("600 10px 'Chakra Petch'"), document.fonts.load("10px 'IBM Plex Mono'")]);
    } catch {
      // Fallback fonts are fine.
    }
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    host.appendChild(this.app.canvas);
    this.initialized = true;

    this.sky = new TilingSprite({ texture: this.makeStarTexture(), width: this.app.screen.width, height: this.app.screen.height });
    this.crewLayer.sortableChildren = true;
    this.camera.addChild(this.grid, this.hulls, this.lights, this.crewLayer, this.banners);
    this.app.stage.addChild(this.sky, this.camera, this.edge, this.edgeHits);
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

  private makeStarTexture() {
    const size = 1024;
    const g = new Graphics();
    g.rect(0, 0, size, size).fill(HUD.space);
    // Faint nebula blotches.
    for (let i = 0; i < 6; i++) {
      const x = hash(`nx${i}`) * size;
      const y = hash(`ny${i}`) * size;
      const color = [0x1a1033, 0x0b1f2e, 0x2a1220][i % 3];
      for (let j = 0; j < 40; j++) {
        g.circle(x + (hash(`n${i}${j}x`) - 0.5) * 360, y + (hash(`n${i}${j}y`) - 0.5) * 240, 20 + hash(`n${i}${j}r`) * 60).fill({ color, alpha: 0.05 });
      }
    }
    for (let i = 0; i < 520; i++) {
      const x = hash(`sx${i}`) * size;
      const y = hash(`sy${i}`) * size;
      const m = hash(`sm${i}`);
      const color = m > 0.97 ? 0xffd9a0 : m > 0.94 ? 0xa0d8ff : 0xffffff;
      const px = m > 0.985 ? 2 : 1;
      g.rect(Math.round(x), Math.round(y), px, px).fill({ color, alpha: 0.25 + m * 0.6 });
    }
    return this.app.renderer.generateTexture({ target: g, frame: new Rectangle(0, 0, size, size) });
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
      if (drag.moved) {
        this.userMoved = true;
        this.camera.position.set(drag.camX + dx, drag.camY + dy);
      }
    });
    stage.on("pointerup", (e: FederatedPointerEvent) => {
      if (drag && !drag.moved && e.target === stage) setSelection(null);
      drag = null;
    });
    stage.on("pointerupoutside", () => (drag = null));
    this.app.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.userMoved = true;
        const rect = this.app.canvas.getBoundingClientRect();
        this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );
  }

  private setZoom(z: number): void {
    this.zoom = Math.min(3, Math.max(0.12, z));
    this.camera.scale.set(this.zoom);
  }

  private zoomAt(sx: number, sy: number, factor: number): void {
    const wx = (sx - this.camera.x) / this.zoom;
    const wy = (sy - this.camera.y) / this.zoom;
    this.setZoom(this.zoom * factor);
    this.camera.position.set(sx - wx * this.zoom, sy - wy * this.zoom);
  }

  private frame(rect: Rect, maxZoom: number, rightInset = 0): void {
    const { width, height } = this.app.screen;
    const usableW = width - rightInset;
    const topInset = 70;
    const z = Math.min(maxZoom, Math.min(usableW / (rect.w + 160), (height - topInset) / (rect.h + 220)));
    this.setZoom(z);
    this.camera.position.set(usableW / 2 - (rect.x + rect.w / 2) * this.zoom, topInset / 2 + height / 2 - (rect.y + rect.h / 2) * this.zoom);
  }

  fitAll(): void {
    if (!this.initialized) return;
    this.frame(this.layout.bounds, 1.1);
  }

  focusStation(envId: string): void {
    const s = this.layout.stations.get(envId);
    this.userMoved = true;
    if (s && this.initialized) this.frame(s.bounds, 1.6, Math.min(460, this.app.screen.width * 0.3));
  }

  centerOn(x: number, y: number): void {
    if (!this.initialized) return;
    this.userMoved = true;
    const { width, height } = this.app.screen;
    this.camera.position.set(width / 2 - x * this.zoom, height / 2 - y * this.zoom);
  }

  /** Center the camera on a unit, module or archive, leaving room for the side panel. */
  focus(selection: Selection): void {
    if (!selection || !this.initialized) return;
    let p: Point | undefined;
    if (selection.kind === "unit") p = this.crew.get(unitKey(selection.envId, selection.threadId))?.pos;
    else {
      const m = this.layout.modules.get(`${selection.envId}:${selection.projectId}`);
      const r = selection.kind === "library" ? m?.archive : m?.room;
      if (r) p = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    }
    if (!p) return;
    this.userMoved = true;
    const { width, height } = this.app.screen;
    this.setZoom(Math.max(this.zoom, 1.6));
    this.camera.position.set(width * 0.36 - p.x * this.zoom, height / 2 - p.y * this.zoom);
  }

  minimap(): MinimapData | undefined {
    if (!this.initialized) return undefined;
    const { width, height } = this.app.screen;
    const view = { x: -this.camera.x / this.zoom, y: -this.camera.y / this.zoom, w: width / this.zoom, h: height / this.zoom };
    const state = useGame.getState();
    return {
      bounds: this.layout.bounds,
      stations: [...this.layout.stations.values()].map((s) => ({ rect: s.bounds, color: s.color, live: state.envs[s.envId]?.connection === "live" })),
      dots: [...this.crew.values()]
        .filter((c) => c.state !== "sleeping")
        .map((c) => ({ x: c.pos.x, y: c.pos.y, color: STATUS[c.state], big: c.state === "alert" || c.state === "question" })),
      view,
    };
  }

  // ---- Sync with the store ----

  private sync(state: GameState): void {
    if (state.envs === this.lastEnvs && state.details === this.lastDetails) return;
    const layoutChanged = state.envs !== this.lastEnvs;
    this.lastEnvs = state.envs;
    this.lastDetails = state.details;

    if (layoutChanged) {
      this.layout = computeFleetLayout(state);
      const seen = new Set<string>();
      for (const [envId, sl] of this.layout.stations) {
        seen.add(envId);
        let station = this.stations.get(envId);
        if (!station) {
          station = new StationSprite(envId);
          this.stations.set(envId, station);
          this.hulls.addChild(station.hull);
          this.lights.addChild(station.lights);
          this.banners.addChild(station.banner);
        }
        station.build(sl, state.envs[envId]);
      }
      for (const [envId, station] of this.stations) {
        if (seen.has(envId)) continue;
        station.destroy();
        this.stations.delete(envId);
      }
      this.drawGrid();
    }

    const seenCrew = new Set<string>();
    for (const env of Object.values(state.envs)) {
      for (const thread of Object.values(env.threads)) {
        if (isHistory(thread)) continue;
        const key = unitKey(env.summary.id, thread.id);
        const lay = this.layout.crew.get(key);
        if (!lay) continue;
        seenCrew.add(key);
        let sprite = this.crew.get(key);
        if (!sprite) {
          // New crew step out of the core; on first load everyone starts at their post.
          const station = this.layout.stations.get(env.summary.id);
          sprite = new CrewSprite(lay, this.fitted && station ? { ...station.center } : lay.home);
          this.crew.set(key, sprite);
          this.crewLayer.addChild(sprite);
        }
        const detail = state.details[key];
        sprite.update(thread, detail ? telemetry(detail.thread) : undefined);
      }
    }
    for (const [key, sprite] of this.crew) {
      if (seenCrew.has(key)) continue;
      sprite.destroy({ children: true });
      this.crew.delete(key);
    }

    if (Object.values(state.envs).some((e) => e.synced)) {
      // New crew walk out of the core once the first snapshot has been placed.
      this.fitted = true;
      if (layoutChanged && !this.userMoved) this.fitAll();
    }
  }

  private drawGrid(): void {
    const g = this.grid.clear();
    const b = this.layout.bounds;
    const step = 400;
    const pad = 2400;
    const x0 = Math.floor((b.x - pad) / step) * step;
    const y0 = Math.floor((b.y - pad) / step) * step;
    const x1 = b.x + b.w + pad;
    const y1 = b.y + b.h + pad;
    for (let x = x0; x < x1; x += step) g.moveTo(x, y0).lineTo(x, y1).stroke({ color: HUD.cyan, width: 1, alpha: 0.05 });
    for (let y = y0; y < y1; y += step) g.moveTo(x0, y).lineTo(x1, y).stroke({ color: HUD.cyan, width: 1, alpha: 0.05 });
    for (let x = x0; x < x1; x += step) {
      for (let y = y0; y < y1; y += step) {
        g.rect(x - 3, y, 7, 1).fill({ color: HUD.cyan, alpha: 0.18 });
        g.rect(x, y - 3, 1, 7).fill({ color: HUD.cyan, alpha: 0.18 });
      }
    }
  }

  // ---- Frame ----

  private tick(dt: number): void {
    this.time += dt;
    const state = useGame.getState();
    const t = this.time;
    const sel = state.selection;

    if (this.sky) {
      this.sky.width = this.app.screen.width;
      this.sky.height = this.app.screen.height;
      this.sky.tilePosition.set(this.camera.x * 0.15, this.camera.y * 0.15);
    }
    this.grid.visible = this.zoom > 0.2;

    for (const [key, sprite] of this.crew) {
      const lay = this.layout.crew.get(key);
      if (!lay) continue;
      const selected = sel?.kind === "unit" && sel.envId === sprite.envId && sel.threadId === sprite.threadId;
      sprite.tick(lay, this.layout.modules, t, dt, selected, this.zoom);
    }
    for (const station of this.stations.values()) {
      const env = state.envs[station.envId];
      if (env) station.drawLights(env, this.crew, this.layout, t, this.zoom, sel);
    }
    this.drawEdgeIndicators(t);
  }

  /** Arrows on the screen edge pointing at off-screen crew who need you. */
  private drawEdgeIndicators(t: number): void {
    const g = this.edge.clear();
    for (const child of this.edgeHits.removeChildren()) child.destroy();
    const { width, height } = this.app.screen;
    const margin = 26;
    const top = 64;
    for (const sprite of this.crew.values()) {
      if (sprite.state !== "alert" && sprite.state !== "question") continue;
      const sx = this.camera.x + sprite.pos.x * this.zoom;
      const sy = this.camera.y + sprite.pos.y * this.zoom;
      if (sx > margin && sx < width - margin && sy > top && sy < height - margin) continue;
      const cx = width / 2;
      const cy = (height + top) / 2;
      const dx = sx - cx;
      const dy = sy - cy;
      const scale = Math.min((width / 2 - margin) / Math.abs(dx || 1e-6), ((height - top) / 2 - margin) / Math.abs(dy || 1e-6));
      const ex = cx + dx * scale;
      const ey = cy + dy * scale;
      const a = Math.atan2(dy, dx);
      const color = STATUS[sprite.state];
      const pulse = 1 + Math.sin(t * 6) * 0.15;
      const tip = (r: number, da: number) => [ex + Math.cos(a + da) * r, ey + Math.sin(a + da) * r];
      g.poly([...tip(14 * pulse, 0), ...tip(10, 2.5), ...tip(10, -2.5)]).fill(color).stroke({ color: 0x000000, width: 1.5 });
      const station = this.layout.stations.get(sprite.envId);
      if (station) g.circle(ex - Math.cos(a) * 6, ey - Math.sin(a) * 6, 3).fill(station.color);
      const hit = new Container();
      hit.eventMode = "static";
      hit.cursor = "pointer";
      hit.hitArea = new Rectangle(ex - 16, ey - 16, 32, 32);
      const envId = sprite.envId;
      const threadId = sprite.threadId;
      hit.on("pointertap", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        sfx.select();
        const s = { kind: "unit" as const, envId, threadId };
        setSelection(s);
        this.focus(s);
      });
      this.edgeHits.addChild(hit);
    }
  }
}

/** The live map, for hotkeys and panels that need to move the camera. */
export const worldRef: { current: World | null } = { current: null };
