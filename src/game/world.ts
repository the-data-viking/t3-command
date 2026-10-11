// The fleet map, rendered with PixiJS. A view of the game store: it reads state, and clicks
// become store selections. All art is procedural (vector "tactical display" style) so a sprite
// set can replace it later without touching layout or behavior.
//
// The map is project-centric: each repository is a hub, every environment working on it docks a
// team-colored bay there, and environments themselves are home ships in orbit, linked to their bays.
//
// Rule borrowed from StarNet: the map never shows activity T3 can't prove. Consoles light up
// only during a real turn, crew walk to a workstation only for a real open tool call, data links
// pulse only while that bay has crew working, and idle crew stand still.

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
import { computeFleetLayout, type CrewLayout, type FleetLayout, type HubLayout, type ModuleLayout, type Point, type Rect, type StationLayout } from "./layout";
import { sfx } from "./sfx";
import { HUD, modelTier, PROVIDER_VISOR, providerSilhouette, STATUS, type Silhouette, type Tier } from "./theme";

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

function bezier(a: Point, b: Point, t: number): Point {
  // Vertical S-curve between a station and a bay port.
  const c1 = { x: a.x, y: a.y + (b.y - a.y) * 0.55 };
  const c2 = { x: b.x, y: b.y - (b.y - a.y) * 0.55 };
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}

/** Zoom below which fine detail fades and labels/banners hold a minimum on-screen size. */
const STRATEGIC_ZOOM = 0.55;
const TIER_SCALE: Record<Tier, number> = { light: 0.8, standard: 1, heavy: 1.28, reviewer: 0.95 };

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
  tier: Tier = "standard";
  silhouette: Silhouette = "round";
  team = 0xffffff;
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
    this.hitArea = new Rectangle(-11, -30, 22, 36);
    this.on("pointerover", () => (this.hovered = true));
    this.on("pointerout", () => (this.hovered = false));
    this.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      sfx.select();
      setSelection({ kind: "unit", envId: this.envId, threadId: this.threadId });
    });
  }

  update(thread: ThreadShell, info: Telemetry | undefined, team: number): void {
    this.thread = thread;
    this.state = unitState(thread);
    this.info = info;
    this.team = team;
    this.tier = modelTier(thread.modelSelection.model);
    this.silhouette = providerSilhouette(thread.modelSelection.instanceId);
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
    const boost = zoom < STRATEGIC_ZOOM ? Math.min(2.2, STRATEGIC_ZOOM / zoom) : 1;
    this.scale.set(boost);
    this.body.scale.set(this.state === "sleeping" ? 1 : TIER_SCALE[this.tier]);

    this.drawBody(t, moving);
    this.drawFx(t, selected, zoom);
    this.drawRing(selected, t);
    this.nameText.visible = !layout.sleeping && (selected || this.hovered || zoom > 1.6);
  }

  private drawBody(t: number, moving: boolean): void {
    const b = this.body.clear();
    const s = this.shadow.clear();
    const accent = PROVIDER_VISOR[this.thread.modelSelection.instanceId] ?? 0x9fb3d1;
    const team = this.team;
    if (this.state === "sleeping") {
      // Lying in a bunk with the lights off; a team-colored blanket stripe.
      b.roundRect(-7, -4, 14, 6, 3).fill(0x3b4352);
      b.rect(-1, -4, 2, 6).fill({ color: team, alpha: 0.5 });
      b.circle(-5, -2, 3).fill(0x59616f);
      return;
    }
    const scale = TIER_SCALE[this.tier];
    s.ellipse(0, 1, 7 * scale, 2.5 * scale).fill({ color: 0x000000, alpha: 0.5 });
    const step = moving ? Math.sin(t * 16 + this.seed * 9) : 0;
    const typing = this.state === "working" && this.atConsole ? Math.sin(t * 22 + this.seed * 5) * 0.8 : 0;
    const suit = this.tier === "heavy" ? 0xc7d0da : 0xdde4ec;
    const limb = 0xaeb8c4;

    // Legs
    b.rect(-4, -4 + Math.max(0, step) * 1.5, 3, 4).fill(limb);
    b.rect(1, -4 + Math.max(0, -step) * 1.5, 3, 4).fill(limb);

    // Pack: scouts carry a tiny thruster, specialists a pack, heavies a big pack with an antenna.
    if (this.tier === "light") {
      b.rect(-7, -11, 2, 4).fill(0x8995a3);
      if (moving) b.rect(-7, -7, 2, 2).fill({ color: HUD.cyan, alpha: 0.8 });
    } else if (this.tier === "heavy") {
      b.rect(-9, -15, 4, 10).fill(0x7d8896);
      b.moveTo(-8, -15).lineTo(-8, -26).stroke({ color: 0x8995a3, width: 1 });
      b.circle(-8, -27, 1.3).fill({ color: HUD.amber, alpha: 0.5 + Math.sin(t * 4 + this.seed * 8) * 0.5 });
    } else if (this.tier === "standard") {
      b.rect(-8, -13, 3, 8).fill(0x9aa5b2);
    }

    // Torso + team chest stripe
    if (this.silhouette === "round") b.roundRect(-6, -14, 12, 11, 4).fill(suit);
    else b.poly([-6, -14, 6, -14, 5, -3, -5, -3]).fill(suit);
    b.rect(-6, -11, 12, 2).fill(team);

    // Heavy armor plates on the shoulders
    if (this.tier === "heavy") {
      if (this.silhouette === "round") {
        b.circle(-6.5, -13, 3.2).fill(0xaab4c0).stroke({ color: team, width: 1 });
        b.circle(6.5, -13, 3.2).fill(0xaab4c0).stroke({ color: team, width: 1 });
      } else {
        b.rect(-10, -16, 5, 5).fill(0xaab4c0).stroke({ color: team, width: 1 });
        b.rect(5, -16, 5, 5).fill(0xaab4c0).stroke({ color: team, width: 1 });
      }
    }

    // Arms (typing at the console moves them)
    b.rect(5, -12 + typing, 2, 5).fill(0xc9d2dc);
    b.rect(-5, -12 - typing, 2, 5).fill(0xc9d2dc);

    // Helmet: bubble + visor for Claude, boxy + visor band for Codex; team crest on top.
    if (this.silhouette === "round") {
      b.circle(0, -19, 6).fill(0xeef2f6);
      b.roundRect(-1, -22, 6, 5, 2.5).fill(accent);
      b.rect(1, -21, 2, 1).fill({ color: 0xffffff, alpha: 0.6 });
      b.rect(-1, -26, 2, 2.5).fill(team);
    } else {
      b.poly([-5, -25, 5, -25, 6, -23, 6, -14, -6, -14, -6, -23]).fill(0xe6ebf0);
      b.rect(-4, -21, 10, 3.5).fill(accent);
      b.rect(-5, -25, 10, 1.5).fill(team);
    }

    // Inspectors (review models) carry a scanner that sweeps while they work.
    if (this.tier === "reviewer") {
      b.circle(7, -19, 2.5).fill(0x1b2530).stroke({ color: HUD.amber, width: 1 });
      if (this.state === "working") {
        const sweep = Math.sin(t * 3 + this.seed * 4) * 0.5;
        b.poly([7, -19, 22, -26 + sweep * 10, 22, -12 + sweep * 10]).fill({ color: HUD.cyan, alpha: 0.18 });
      }
    }
  }

  private drawFx(t: number, selected: boolean, zoom: number): void {
    const f = this.fx.clear();
    const y = -32 * TIER_SCALE[this.tier] - 4;
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
      f.circle(Math.cos(a) * 14, -13 + Math.sin(a) * 6, 1.8).fill(STATUS.working);
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
    const w = 12 * TIER_SCALE[this.tier];
    if (selected) {
      r.ellipse(0, 1, w, w * 0.42).stroke({ color: HUD.amber, width: 1.5 });
    } else if (this.state === "alert" || this.state === "question") {
      const g = (t * 1.1 + this.seed) % 1;
      r.ellipse(0, 1, 8 + g * 20, 3 + g * 8).stroke({ color: STATUS[this.state], width: 1.5, alpha: 1 - g });
    } else if (this.hovered) {
      r.ellipse(0, 1, w - 1, (w - 1) * 0.42).stroke({ color: 0xffffff, width: 1, alpha: 0.6 });
    }
  }
}

// ---- Project hubs ----------------------------------------------------------------------

/** Static geometry for one project hub and its bays (redrawn only when the layout changes). */
class HubSprite {
  readonly key: string;
  readonly root = new Container();
  /** Labels that keep a minimum on-screen size when zoomed out. */
  private labels: Text[] = [];

  constructor(key: string) {
    this.key = key;
  }

  build(hub: HubLayout, fleet: FleetLayout, state: GameState): void {
    for (const child of this.root.removeChildren()) child.destroy({ children: true });
    this.labels = [];
    const g = new Graphics();
    this.root.addChild(g);
    const modules = hub.modules.map((k) => fleet.modules.get(k)!).filter(Boolean);

    // Spine: the hub's backbone, with docking corridors up to each bay.
    const s = hub.spine;
    for (const m of modules) {
      const [a, b] = m.corridor;
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: HUD.hullEdge, width: 24 });
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: HUD.hull, width: 18 });
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color: m.color, width: 2, alpha: 0.6 });
    }
    g.rect(s.x - 6, s.y - 6, s.w + 12, s.h + 12).fill(HUD.hullEdge);
    g.rect(s.x, s.y, s.w, s.h).fill(HUD.hull).stroke({ color: HUD.amber, width: 1.5, alpha: 0.7 });
    for (let x = s.x + 10; x < s.x + s.w - 10; x += 26) g.rect(x, s.y + s.h - 9, 14, 3).fill({ color: HUD.amberDim, alpha: 0.8 });
    // Team color pips on the spine: one per station docked here.
    modules.forEach((m, i) => g.rect(s.x + 12 + i * 12, s.y + 8, 8, 8).fill(m.color));

    const shared = modules.length > 1;
    const title = label(15, HUD.amber, { fontWeight: "700", letterSpacing: 3 });
    title.text = hub.name.toUpperCase();
    title.anchor.set(0, 0.5);
    title.position.set(s.x + 16 + modules.length * 12, s.y + s.h / 2 - 2);
    this.root.addChild(title);
    this.labels.push(title);
    if (shared || hub.repo) {
      const sub = new Text({
        text: [shared ? `SHARED · ${modules.length} STATIONS` : "1 STATION", hub.repo].filter(Boolean).join("  ·  "),
        style: { fontFamily: MONO, fontSize: 9, fill: HUD.muted, letterSpacing: 1 },
      });
      sub.resolution = 3;
      sub.anchor.set(0, 0);
      sub.position.set(s.x + 6, s.y + s.h + 10);
      this.root.addChild(sub);
      this.labels.push(sub);
    }
    const spineHit = new Container();
    spineHit.eventMode = "static";
    spineHit.cursor = "pointer";
    spineHit.hitArea = new Rectangle(s.x, s.y, s.w, s.h);
    spineHit.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      sfx.building();
      worldRef.current?.focusRect(hub.bounds);
    });
    this.root.addChild(spineHit);

    for (const m of modules) this.buildBay(g, m, state);
  }

  private buildBay(g: Graphics, m: ModuleLayout, state: GameState): void {
    const r = m.room;
    const team = m.color;
    // Hull walls, floor tiles, team frame.
    g.rect(r.x - 6, r.y - 6, r.w + 12, r.h + 12).fill(HUD.hullEdge);
    g.rect(r.x - 3, r.y - 3, r.w + 6, r.h + 6).fill(HUD.hull).stroke({ color: team, width: 1.5, alpha: 0.7 });
    g.rect(r.x, r.y, r.w, r.h).fill(HUD.floor);
    for (let x = r.x + 12; x < r.x + r.w; x += 24) g.moveTo(x, r.y).lineTo(x, r.y + r.h).stroke({ color: HUD.floorTile, width: 1 });
    for (let y = r.y + 12; y < r.y + r.h; y += 24) g.moveTo(r.x, y).lineTo(r.x + r.w, y).stroke({ color: HUD.floorTile, width: 1 });
    g.rect(r.x - 3, r.y - 3, r.w + 6, 4).fill(team);
    // Data port where the station's link plugs in.
    g.rect(m.port.x - 7, m.port.y - 2, 14, 6).fill(HUD.hullEdge).stroke({ color: team, width: 1 });

    // Workstation strip: terminal, file archive, comms dish.
    g.rect(r.x, r.y, r.w, 40).fill({ color: 0x0b0f15, alpha: 0.8 });
    g.moveTo(r.x, r.y + 40).lineTo(r.x + r.w, r.y + 40).stroke({ color: HUD.amberDim, width: 1, alpha: 0.8 });
    const { terminal, files, comms } = m.workstations;
    g.roundRect(terminal.x - 11, terminal.y - 12, 22, 14, 2).fill(0x202a36).stroke({ color: 0x3a4757, width: 1 });
    g.rect(terminal.x - 8, terminal.y - 9, 16, 8).fill(0x06231a);
    g.rect(files.x - 9, files.y - 14, 18, 18).fill(0x2a3240).stroke({ color: 0x3a4757, width: 1 });
    for (let i = 0; i < 3; i++) g.rect(files.x - 7, files.y - 12 + i * 6, 14, 4).fill(0x3a4554);
    g.moveTo(comms.x, comms.y + 2).lineTo(comms.x, comms.y - 6).stroke({ color: 0x5b6676, width: 2 });
    g.arc(comms.x, comms.y - 6, 9, Math.PI * 1.05, Math.PI * 1.95).stroke({ color: 0xaeb8c4, width: 2.5 });
    g.circle(comms.x, comms.y - 10, 1.5).fill(HUD.amber);

    // Console desks (screens are drawn live).
    for (const p of m.consoles) {
      g.roundRect(p.x - 15, p.y - 4, 30, 9, 2).fill(0x232c38).stroke({ color: 0x334051, width: 1 });
      g.rect(p.x - 12, p.y - 13, 24, 9).fill(0x0a0e13);
      g.rect(p.x - 4, p.y + 13, 8, 5).fill(0x2b3442);
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
      this.root.addChild(hit);
    }

    // The whole bay selects it.
    const room = new Container();
    room.eventMode = "static";
    room.cursor = "pointer";
    room.hitArea = new Rectangle(r.x - 6, r.y - 6, r.w + 12, r.h + 12);
    room.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      sfx.building();
      setSelection({ kind: "building", envId: m.envId, projectId: m.projectId });
    });
    this.root.addChildAt(room, 0);

    // Bay label: which station this bay belongs to.
    const env = state.envs[m.envId];
    const name = label(8, team, { letterSpacing: 1.5 });
    name.text = truncate((env?.summary.label ?? "?").toUpperCase(), 24) + (m.archived ? `  ·  ARCHIVE ${m.archived}` : "");
    name.anchor.set(0, 1);
    name.position.set(r.x - 2, r.y - 9);
    this.root.addChild(name);
    this.labels.push(name);
  }

  setZoom(zoom: number): void {
    for (const l of this.labels) {
      l.visible = zoom > 0.25;
      l.scale.set(Math.max(1, 0.9 / zoom));
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}

// ---- Stations --------------------------------------------------------------------------

/** One environment's home ship in orbit, with its screen-space banner. */
class StationSprite {
  readonly envId: string;
  readonly root = new Container();
  readonly banner = new Container();
  private ship = new Graphics();
  private bannerBg = new Graphics();
  private bannerName = label(13, HUD.text, { fontWeight: "700", letterSpacing: 2 });
  private bannerStatus = new Text({ text: "", style: { fontFamily: MONO, fontSize: 11, fill: HUD.muted, letterSpacing: 0.5 } });
  layout!: StationLayout;

  constructor(envId: string) {
    this.envId = envId;
    this.bannerStatus.resolution = 3;
    this.bannerName.position.set(14, 6);
    this.bannerStatus.position.set(14, 25);
    this.banner.addChild(this.bannerBg, this.bannerName, this.bannerStatus);
    this.root.addChild(this.ship);
    for (const target of [this.banner, this.root]) {
      target.eventMode = "static";
      target.cursor = "pointer";
      target.on("pointertap", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        sfx.building();
        worldRef.current?.focusStation(envId);
      });
    }
  }

  build(layout: StationLayout): void {
    this.layout = layout;
    this.root.hitArea = new Rectangle(layout.bounds.x, layout.bounds.y, layout.bounds.w, layout.bounds.h);
  }

  draw(env: EnvWorld, counts: { working: number; attention: number; done: number; total: number }, t: number, zoom: number): void {
    const L = this.layout;
    const live = env.connection === "live";
    const c = L.center;
    const r = L.coreRadius;
    const g = this.ship.clear();
    const oct = (radius: number) => {
      const pts: number[] = [];
      for (let i = 0; i < 8; i++) {
        const a = Math.PI / 8 + (i * Math.PI) / 4;
        pts.push(c.x + Math.cos(a) * radius, c.y + Math.sin(a) * radius);
      }
      return pts;
    };
    // Solar wings, hull and core.
    g.rect(c.x - r - 34, c.y - 7, 30, 14).fill(0x1b2a44).stroke({ color: 0x334a70, width: 1 });
    g.rect(c.x + r + 4, c.y - 7, 30, 14).fill(0x1b2a44).stroke({ color: 0x334a70, width: 1 });
    for (const dx of [-r - 26, -r - 18, r + 12, r + 20]) g.moveTo(c.x + dx, c.y - 7).lineTo(c.x + dx, c.y + 7).stroke({ color: 0x334a70, width: 1 });
    g.poly(oct(r + 5)).fill(HUD.hullEdge);
    g.poly(oct(r)).fill(HUD.hull).stroke({ color: live ? L.color : 0x3a4250, width: 2.5 });
    g.poly(oct(r - 12)).fill(HUD.floor).stroke({ color: HUD.hullLight, width: 1 });
    const glow = live ? L.color : env.connection === "reconnecting" || env.connection === "connecting" ? STATUS.question : 0x3a4250;
    g.circle(c.x, c.y, 13 + (live ? Math.sin(t * 2) * 1.5 : 0)).fill({ color: glow, alpha: live ? 0.25 : 0.12 });
    g.circle(c.x, c.y, 6).fill({ color: glow, alpha: live ? 0.95 : 0.4 });
    this.root.alpha = live ? 1 : 0.5;

    // Banner: constant on-screen size, above the ship. Zoomed out it's a compact name tag;
    // the full status line appears once there's room for it.
    const s = 1 / zoom;
    const compact = zoom < 0.9;
    const scale = s * (compact ? 0.85 : 0.9);
    this.banner.scale.set(scale);
    this.bannerName.text = compact ? truncate(env.summary.label.toUpperCase(), 16) : env.summary.label.toUpperCase();
    this.bannerStatus.visible = !compact;
    this.bannerStatus.text = live
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
    this.bannerStatus.style.fill = !live ? STATUS.question : counts.attention ? STATUS.alert : HUD.muted;
    const w = (compact ? this.bannerName.width + 14 : Math.max(this.bannerName.width, this.bannerStatus.width)) + 28;
    const h = compact ? 28 : 44;
    this.banner.position.set(c.x - (w * scale) / 2, c.y - r - 14 * s - h * scale);
    const b = this.bannerBg.clear();
    b.rect(0, 0, w, h).fill({ color: 0x05080d, alpha: 0.88 }).stroke({ color: live ? L.color : 0x3a4250, width: 1, alpha: 0.8 });
    b.rect(0, 0, 4, h).fill(live ? L.color : 0x3a4250);
    b.moveTo(w - 10, 0).lineTo(w, 0).lineTo(w, 10).stroke({ color: HUD.amber, width: 1.5 });
    b.moveTo(w, h - 10).lineTo(w, h).lineTo(w - 10, h).stroke({ color: HUD.amber, width: 1.5 });
    if (compact) {
      // Status pip: red if anything needs you, cyan if working, team color if idle, gray if offline.
      const pip = !live ? 0x3a4250 : counts.attention ? STATUS.alert : counts.working ? STATUS.working : L.color;
      b.rect(w - 22, 10, 8, 8).fill(pip);
    } else if (counts.attention && live) {
      b.rect(w - 8, 18, 4, 8).fill(STATUS.alert);
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
    this.banner.destroy({ children: true });
  }
}

// ---- World -----------------------------------------------------------------------------

export interface MinimapData {
  bounds: Rect;
  hubs: Rect[];
  stations: Array<{ rect: Rect; color: number; live: boolean }>;
  dots: Array<{ x: number; y: number; color: number; big: boolean }>;
  view: Rect;
}

export class World {
  private app = new Application();
  private sky?: TilingSprite;
  private camera = new Container();
  private grid = new Graphics();
  private links = new Graphics();
  private hubLayer = new Container();
  private stationLayer = new Container();
  private lights = new Graphics();
  private crewLayer = new Container();
  private banners = new Container();
  private edge = new Graphics();
  private edgeHits = new Container();
  private hubs = new Map<string, HubSprite>();
  private stations = new Map<string, StationSprite>();
  private crew = new Map<string, CrewSprite>();
  private layout: FleetLayout = { stations: new Map(), hubs: new Map(), modules: new Map(), crew: new Map(), bounds: { x: 0, y: 0, w: 0, h: 0 } };
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
    this.camera.addChild(this.grid, this.links, this.hubLayer, this.stationLayer, this.lights, this.crewLayer, this.banners);
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
    // Faint nebula puffs.
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

  private frame(rect: Rect, maxZoom: number, rightInset = 0, leftInset = 0): void {
    const { width, height } = this.app.screen;
    const usableW = width - rightInset - leftInset;
    const topInset = 70;
    // Padding leaves room for banners and labels that extend past the geometry.
    const z = Math.min(maxZoom, Math.min(usableW / (rect.w + 320), (height - topInset) / (rect.h + 260)));
    this.setZoom(z);
    this.camera.position.set(leftInset + usableW / 2 - (rect.x + rect.w / 2) * this.zoom, topInset / 2 + 40 + height / 2 - (rect.y + rect.h / 2) * this.zoom);
  }

  fitAll(): void {
    if (!this.initialized) return;
    // Leave room for the inbox on the left.
    this.frame(this.layout.bounds, 1.1, 0, Math.min(320, this.app.screen.width * 0.2));
  }

  focusRect(rect: Rect): void {
    if (!this.initialized) return;
    this.userMoved = true;
    this.frame(rect, 1.6, Math.min(460, this.app.screen.width * 0.3));
  }

  /** Frame a station together with all of its bays. */
  focusStation(envId: string): void {
    const s = this.layout.stations.get(envId);
    if (!s) return;
    let rect = s.bounds;
    for (const m of this.layout.modules.values()) {
      if (m.envId !== envId) continue;
      const x = Math.min(rect.x, m.room.x);
      const y = Math.min(rect.y, m.room.y);
      rect = { x, y, w: Math.max(rect.x + rect.w, m.room.x + m.room.w) - x, h: Math.max(rect.y + rect.h, m.room.y + m.room.h) - y };
    }
    this.focusRect(rect);
  }

  centerOn(x: number, y: number): void {
    if (!this.initialized) return;
    this.userMoved = true;
    const { width, height } = this.app.screen;
    this.camera.position.set(width / 2 - x * this.zoom, height / 2 - y * this.zoom);
  }

  /** Center the camera on a unit, bay or archive, leaving room for the side panel. */
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
      hubs: [...this.layout.modules.values()].map((m) => m.room),
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
      const seenHubs = new Set<string>();
      for (const [key, hub] of this.layout.hubs) {
        seenHubs.add(key);
        let sprite = this.hubs.get(key);
        if (!sprite) {
          sprite = new HubSprite(key);
          this.hubs.set(key, sprite);
          this.hubLayer.addChild(sprite.root);
        }
        sprite.build(hub, this.layout, state);
      }
      for (const [key, sprite] of this.hubs) {
        if (seenHubs.has(key)) continue;
        sprite.destroy();
        this.hubs.delete(key);
      }
      const seenStations = new Set<string>();
      for (const [envId, sl] of this.layout.stations) {
        seenStations.add(envId);
        let station = this.stations.get(envId);
        if (!station) {
          station = new StationSprite(envId);
          this.stations.set(envId, station);
          this.stationLayer.addChild(station.root);
          this.banners.addChild(station.banner);
        }
        station.build(sl);
      }
      for (const [envId, station] of this.stations) {
        if (seenStations.has(envId)) continue;
        station.destroy();
        this.stations.delete(envId);
      }
      this.drawGrid();
    }

    const seenCrew = new Set<string>();
    for (const env of Object.values(state.envs)) {
      const team = this.layout.stations.get(env.summary.id)?.color ?? 0xffffff;
      for (const thread of Object.values(env.threads)) {
        if (isHistory(thread)) continue;
        const key = unitKey(env.summary.id, thread.id);
        const lay = this.layout.crew.get(key);
        if (!lay) continue;
        seenCrew.add(key);
        let sprite = this.crew.get(key);
        if (!sprite) {
          // New crew arrive through their bay's data port; on first load everyone starts at their post.
          const port = this.layout.modules.get(lay.moduleKey)?.port;
          sprite = new CrewSprite(lay, this.fitted && port ? { x: port.x, y: port.y + 30 } : lay.home);
          this.crew.set(key, sprite);
          this.crewLayer.addChild(sprite);
        }
        const detail = state.details[key];
        sprite.update(thread, detail ? telemetry(detail.thread) : undefined, team);
      }
    }
    for (const [key, sprite] of this.crew) {
      if (seenCrew.has(key)) continue;
      sprite.destroy({ children: true });
      this.crew.delete(key);
    }

    if (Object.values(state.envs).some((e) => e.synced)) {
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

    // Crew first: their positions and states feed the lights below.
    const perStation = new Map<string, { working: number; attention: number; done: number; total: number }>();
    const workingByModule = new Map<string, number>();
    const terminalBusy = new Set<string>();
    for (const [key, sprite] of this.crew) {
      const lay = this.layout.crew.get(key);
      if (!lay) continue;
      const selected = sel?.kind === "unit" && sel.envId === sprite.envId && sel.threadId === sprite.threadId;
      sprite.tick(lay, this.layout.modules, t, dt, selected, this.zoom);
      const c = perStation.get(sprite.envId) ?? { working: 0, attention: 0, done: 0, total: 0 };
      c.total++;
      if (sprite.state === "working") {
        c.working++;
        workingByModule.set(lay.moduleKey, (workingByModule.get(lay.moduleKey) ?? 0) + 1);
        if (sprite.info?.workstation === "terminal") terminalBusy.add(lay.moduleKey);
      }
      if (sprite.state === "alert" || sprite.state === "question") c.attention++;
      if (sprite.state === "done") c.done++;
      perStation.set(sprite.envId, c);
    }

    this.drawLinks(state, workingByModule, t);
    this.drawLights(state, terminalBusy, sel, t);
    for (const hub of this.hubs.values()) hub.setZoom(this.zoom);
    for (const station of this.stations.values()) {
      const env = state.envs[station.envId];
      if (env) station.draw(env, perStation.get(station.envId) ?? { working: 0, attention: 0, done: 0, total: 0 }, t, this.zoom);
    }
    this.drawEdgeIndicators(t);
  }

  /** Data links from each station to its bays; packets flow only while that bay has crew working. */
  private drawLinks(state: GameState, workingByModule: Map<string, number>, t: number): void {
    const g = this.links.clear();
    for (const station of this.layout.stations.values()) {
      const live = state.envs[station.envId]?.connection === "live";
      for (const link of station.links) {
        const pts: number[] = [];
        for (let i = 0; i <= 24; i++) {
          const p = bezier(link.from, link.to, i / 24);
          pts.push(p.x, p.y);
        }
        g.poly(pts, false).stroke({ color: station.color, width: 6, alpha: live ? 0.08 : 0.03 });
        g.poly(pts, false).stroke({ color: station.color, width: 1.5, alpha: live ? 0.55 : 0.15 });
        const working = live ? (workingByModule.get(link.moduleKey) ?? 0) : 0;
        for (let i = 0; i < Math.min(3, working) * 2; i++) {
          const p = bezier(link.from, link.to, (t * 0.35 + i / (Math.min(3, working) * 2)) % 1);
          g.circle(p.x, p.y, 2.5).fill({ color: station.color, alpha: 0.95 });
        }
      }
    }
  }

  /** Console screens, terminals and selection frames. */
  private drawLights(state: GameState, terminalBusy: Set<string>, sel: Selection, t: number): void {
    const g = this.lights.clear();
    for (const m of this.layout.modules.values()) {
      const live = state.envs[m.envId]?.connection === "live";
      const p = m.workstations.terminal;
      g.rect(p.x - 8, p.y - 9, 16, 8).fill({ color: 0x3dff8a, alpha: terminalBusy.has(m.key) && live ? 0.5 + Math.sin(t * 20) * 0.3 : 0.08 });
      if (sel && sel.kind !== "unit" && `${sel.envId}:${sel.projectId}` === m.key) {
        const r = m.room;
        g.rect(r.x - 9, r.y - 9, r.w + 18, r.h + 18).stroke({ color: HUD.amber, width: 2 });
      }
    }
    for (const sprite of this.crew.values()) {
      const lay = this.layout.crew.get(sprite.key);
      if (!lay?.console) continue;
      const live = state.envs[sprite.envId]?.connection === "live";
      const p = lay.console;
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
      g.circle(ex - Math.cos(a) * 6, ey - Math.sin(a) * 6, 3).fill(sprite.team);
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
