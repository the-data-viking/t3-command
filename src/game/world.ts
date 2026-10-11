// The fleet map, rendered with PixiJS. A view of the game store: it reads state, and clicks
// become store selections. All art is procedural so a sprite set can replace it later without
// touching layout or behavior.
//
// FTL-style: every project is a station seen in cross-section, and everyone working on it, from
// any environment, works side by side in its rooms. Each environment is a ship docked to the
// station; its crew wear its team color. Crew walk room to room through doors to use the system
// their open tool call needs.
//
// Rule borrowed from StarNet: the map never shows activity T3 can't prove. Consoles and system
// icons light up only for real work, crew walk only for real tool calls, a docked ship's engine
// glows only while its crew are working, and idle crew stand still.

import { Application, Container, Graphics, Rectangle, Text, TilingSprite, type FederatedPointerEvent, type TextStyleOptions } from "pixi.js";
import { setSelection, unitKey, useGame, type GameState, type Selection } from "../store";
import { isHistory, unitState, type UnitState } from "../t3/derive";
import { telemetry, type Telemetry } from "../t3/telemetry";
import type { ThreadShell } from "../t3/types";
import { computeFleetLayout, route, TILE, type CrewLayout, type DockLayout, type FleetLayout, type Point, type Rect, type RoomKind, type StationLayout, type SystemRoom } from "./layout";
import { sfx } from "./sfx";
import { HUD, modelTier, PROVIDER_VISOR, providerSilhouette, STATUS, type Silhouette, type Tier } from "./theme";

const FONT = "'Chakra Petch', 'IBM Plex Mono', ui-monospace, monospace";
const MONO = "'IBM Plex Mono', ui-monospace, monospace";

/** FTL-ish palette. */
const SHIP = {
  hull: 0x5d6873,
  hullDark: 0x3c444d,
  hullLight: 0x8a95a0,
  hullLine: 0x2a3036,
  floor: 0xb9bfc6,
  floorLine: 0x9aa1a9,
  wall: 0x15191d,
  door: 0xe39a2c,
  doorDark: 0x8a5a14,
  icon: 0x59626c,
  iconOn: 0x6fe37a,
};

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

/** Zoom below which crew are drawn larger and labels hold a minimum on-screen size. */
const STRATEGIC_ZOOM = 0.55;
const TIER_SCALE: Record<Tier, number> = { light: 0.8, standard: 1, heavy: 1.25, reviewer: 0.95 };
const WALK_SPEED = 75; // px per second, constant like FTL crew

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
  private nameText = label(7, HUD.text, { stroke: { color: 0x000000, width: 3 } });
  pos: Point;
  state: UnitState = "idle";
  thread!: ThreadShell;
  info?: Telemetry;
  tier: Tier = "standard";
  silhouette: Silhouette = "round";
  team = 0xffffff;
  hovered = false;
  /** Room the crew member is in (updated when a walk finishes). */
  room: RoomKind;
  private path: Point[] = [];
  private goal = "";
  private goalRoom: RoomKind;
  private facing = 1;
  /** At their own console (vs. walking, at a system room, or in quarters). */
  atConsole = true;
  /** At the system room their current work needs. */
  atStation = false;

  constructor(layout: CrewLayout) {
    super();
    this.key = layout.key;
    this.envId = layout.envId;
    this.threadId = layout.threadId;
    this.seed = hash(layout.key);
    this.pos = { ...layout.home };
    this.room = layout.homeRoom;
    this.goalRoom = layout.homeRoom;
    this.nameText.anchor.set(0.5, 0);
    this.nameText.y = 7;
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

  /** Where this crew member needs to be, and in which room. */
  private desired(layout: CrewLayout, s: StationLayout): { room: RoomKind; point: Point } {
    if (layout.sleeping) return { room: "quarters", point: layout.home };
    let system: SystemRoom | undefined;
    if (this.state === "working" && this.info && this.info.workstation !== "console") system = this.info.workstation;
    if (this.state === "monitoring") system = "comms";
    if (system && s.rooms[system]) {
      const spot = s.workstations[system];
      const r = s.rooms[system]!.rect;
      // Spread several crew using the same room across it.
      return { room: system, point: { x: spot.x + (this.seed - 0.5) * Math.min(r.w - 24, 70), y: spot.y } };
    }
    return { room: "bridge", point: layout.home };
  }

  tick(layout: CrewLayout, s: StationLayout, t: number, dt: number, selected: boolean, zoom: number): void {
    const want = this.desired(layout, s);
    const goal = `${want.room}:${Math.round(want.point.x)}:${Math.round(want.point.y)}`;
    if (goal !== this.goal) {
      this.goal = goal;
      this.goalRoom = want.room;
      this.path = s.rooms[this.room] ? route(s, this.room, want.room, want.point, this.pos) : [want.point];
    }
    let budget = WALK_SPEED * dt;
    let moving = false;
    while (budget > 0 && this.path.length) {
      const next = this.path[0];
      const dx = next.x - this.pos.x;
      const dy = next.y - this.pos.y;
      const d = Math.hypot(dx, dy);
      if (d <= budget) {
        this.pos = { ...next };
        this.path.shift();
        budget -= d;
      } else {
        this.pos.x += (dx / d) * budget;
        this.pos.y += (dy / d) * budget;
        if (Math.abs(dx) > 0.5) this.facing = dx > 0 ? 1 : -1;
        budget = 0;
      }
      moving = true;
    }
    if (!this.path.length) this.room = this.goalRoom;
    this.atConsole = !moving && !layout.sleeping && this.room === "bridge";
    this.atStation = !moving && this.room !== "bridge" && this.room !== "quarters";
    this.position.set(this.pos.x, this.pos.y);
    this.zIndex = this.pos.y;

    const boost = zoom < STRATEGIC_ZOOM ? Math.min(2, STRATEGIC_ZOOM / zoom) : 1;
    this.scale.set(boost);
    this.body.scale.set(layout.sleeping ? 1 : TIER_SCALE[this.tier] * this.facing, layout.sleeping ? 1 : TIER_SCALE[this.tier]);

    this.drawBody(t, moving, layout.sleeping);
    this.drawFx(t, selected, zoom, layout.sleeping);
    this.drawRing(selected, t, layout.sleeping);
    this.nameText.visible = !layout.sleeping && (selected || this.hovered || zoom > 1.7);
  }

  private drawBody(t: number, moving: boolean, sleeping: boolean): void {
    const b = this.body.clear();
    const s = this.shadow.clear();
    const accent = PROVIDER_VISOR[this.thread.modelSelection.instanceId] ?? 0x9fb3d1;
    const team = this.team;
    const ink = { color: 0x101418, width: 1 };
    if (sleeping) {
      b.roundRect(-11, -5, 22, 10, 3).fill(0x2c3a52).stroke(ink);
      b.rect(-2, -5, 3, 10).fill({ color: team, alpha: 0.8 });
      b.circle(-7, 0, 3.5).fill(0xe6ebf0).stroke(ink);
      return;
    }
    s.ellipse(0, 1, 7, 2.5).fill({ color: 0x000000, alpha: 0.35 });
    const step = moving ? Math.sin(t * 16 + this.seed * 9) : 0;
    const typing = this.state === "working" && (this.atConsole || this.atStation) ? Math.sin(t * 22 + this.seed * 5) * 0.8 : 0;
    const suit = this.tier === "heavy" ? 0xc7d0da : 0xdde4ec;

    b.rect(-4, -4 + Math.max(0, step) * 1.5, 3, 4).fill(0x8f9aa6).stroke(ink);
    b.rect(1, -4 + Math.max(0, -step) * 1.5, 3, 4).fill(0x8f9aa6).stroke(ink);

    if (this.tier === "light") {
      b.rect(-7, -11, 2, 4).fill(0x8995a3).stroke(ink);
      if (moving) b.rect(-7, -7, 2, 2).fill({ color: HUD.cyan, alpha: 0.9 });
    } else if (this.tier === "heavy") {
      b.rect(-9, -15, 4, 10).fill(0x6d7886).stroke(ink);
      b.moveTo(-8, -15).lineTo(-8, -26).stroke({ color: 0x3a4250, width: 1 });
      b.circle(-8, -27, 1.4).fill({ color: HUD.amber, alpha: 0.5 + Math.sin(t * 4 + this.seed * 8) * 0.5 });
    } else if (this.tier === "standard") {
      b.rect(-8, -13, 3, 8).fill(0x8995a3).stroke(ink);
    }

    if (this.silhouette === "round") b.roundRect(-6, -14, 12, 11, 4).fill(suit).stroke(ink);
    else b.poly([-6, -14, 6, -14, 5, -3, -5, -3]).fill(suit).stroke(ink);
    b.rect(-5.5, -11, 11, 2.5).fill(team);

    if (this.tier === "heavy") {
      if (this.silhouette === "round") {
        b.circle(-6.5, -13, 3.2).fill(team).stroke(ink);
        b.circle(6.5, -13, 3.2).fill(team).stroke(ink);
      } else {
        b.rect(-10, -16, 5, 5).fill(team).stroke(ink);
        b.rect(5, -16, 5, 5).fill(team).stroke(ink);
      }
    }

    b.rect(5, -12 + typing, 2, 5).fill(0xc9d2dc).stroke({ color: 0x101418, width: 0.6 });
    b.rect(-5, -12 - typing, 2, 5).fill(0xc9d2dc).stroke({ color: 0x101418, width: 0.6 });

    if (this.silhouette === "round") {
      b.circle(0, -19, 6).fill(0xeef2f6).stroke(ink);
      b.roundRect(-1, -22, 6, 5, 2.5).fill(accent);
      b.rect(1, -21, 2, 1).fill({ color: 0xffffff, alpha: 0.6 });
      b.rect(-1.5, -26.5, 3, 3).fill(team).stroke({ color: 0x101418, width: 0.6 });
    } else {
      b.poly([-5, -25, 5, -25, 6, -23, 6, -14, -6, -14, -6, -23]).fill(0xe6ebf0).stroke(ink);
      b.rect(-4, -21, 10, 3.5).fill(accent);
      b.rect(-5, -25, 10, 2).fill(team);
    }

    if (this.tier === "reviewer") {
      b.circle(7, -19, 2.5).fill(0x1b2530).stroke({ color: HUD.amber, width: 1 });
      if (this.state === "working") {
        const sweep = Math.sin(t * 3 + this.seed * 4) * 0.5;
        b.poly([7, -19, 22, -26 + sweep * 10, 22, -12 + sweep * 10]).fill({ color: HUD.cyan, alpha: 0.2 });
      }
    }
  }

  private drawFx(t: number, selected: boolean, zoom: number, sleeping: boolean): void {
    const f = this.fx.clear();
    if (sleeping) {
      const drift = (t * 0.5 + this.seed) % 1;
      f.rect(6 + drift * 6, -8 - drift * 12, 3, 1).fill({ color: 0xffffff, alpha: 1 - drift });
      return;
    }
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
        f.circle(0, y + 2, 5).fill(STATUS.done).stroke({ color: 0x101418, width: 1 });
        f.moveTo(-2.5, y + 2).lineTo(-0.5, y + 4).lineTo(3, y - 0.5).stroke({ color: 0x08210f, width: 1.5 });
        break;
      case "error":
        f.circle(0, y + 2, 5).fill(STATUS.error).stroke({ color: 0x101418, width: 1 });
        f.moveTo(-2, y).lineTo(2, y + 4).moveTo(2, y).lineTo(-2, y + 4).stroke({ color: 0x2a0d00, width: 1.5 });
        break;
      case "working": {
        const a = t * 5 + this.seed * 6;
        f.arc(0, y + 2, 4, a, a + Math.PI * 1.3).stroke({ color: 0x0e7fa0, width: 2 });
        break;
      }
      case "monitoring": {
        const a = t * 1.6 + this.seed * 6;
        f.circle(0, y + 2, 5).stroke({ color: STATUS.monitoring, width: 1.2 });
        f.moveTo(0, y + 2).lineTo(Math.cos(a) * 5, y + 2 + Math.sin(a) * 5).stroke({ color: STATUS.monitoring, width: 1.5 });
        break;
      }
    }
    const tasks = Math.min(4, this.info?.tasks ?? 0);
    for (let i = 0; i < tasks; i++) {
      const a = t * 2.2 + (i / tasks) * Math.PI * 2;
      f.circle(Math.cos(a) * 14, -13 + Math.sin(a) * 6, 2).fill(STATUS.working).stroke({ color: 0x101418, width: 0.8 });
    }
    const ctx = this.info?.context;
    if (ctx !== undefined && (selected || this.hovered || zoom > 1.3)) {
      const left = 1 - ctx;
      const color = left > 0.4 ? 0x6fe37a : left > 0.15 ? STATUS.question : STATUS.alert;
      for (let i = 0; i < 8; i++) f.rect(-10 + i * 2.6, 4, 2, 3).fill(i / 8 < left ? color : 0x2a3036);
    }
  }

  private drawRing(selected: boolean, t: number, sleeping: boolean): void {
    const r = this.ring.clear();
    if (sleeping) {
      if (selected) r.roundRect(-13, -7, 26, 14, 3).stroke({ color: 0x6fe37a, width: 1.5 });
      return;
    }
    const w = 12 * TIER_SCALE[this.tier];
    if (selected) {
      r.ellipse(0, 1, w, w * 0.42).stroke({ color: 0x6fe37a, width: 2 });
    } else if (this.state === "alert" || this.state === "question") {
      const g = (t * 1.1 + this.seed) % 1;
      r.ellipse(0, 1, 8 + g * 20, 3 + g * 8).stroke({ color: STATUS[this.state], width: 1.5, alpha: 1 - g });
    } else if (this.hovered) {
      r.ellipse(0, 1, w - 1, (w - 1) * 0.42).stroke({ color: 0x101418, width: 1.5, alpha: 0.7 });
    }
  }
}

// ---- Stations --------------------------------------------------------------------------

/** One project station with its docked ships. Static geometry is rebuilt on layout changes. */
class StationSprite {
  readonly key: string;
  readonly root = new Container();
  private labels: Text[] = [];
  private plateTexts: Text[] = [];

  constructor(key: string) {
    this.key = key;
  }

  build(s: StationLayout, fleet: FleetLayout, state: GameState): void {
    for (const child of this.root.removeChildren()) child.destroy({ children: true });
    this.labels = [];
    this.plateTexts = [];
    const g = new Graphics();
    this.root.addChild(g);
    const docks = s.docks.map((k) => fleet.docks.get(k)!).filter(Boolean);

    // Docked ships first so the station hull overlaps their airlocks.
    for (const d of docks) this.buildDock(g, d, state);

    g.poly(s.hull).fill(SHIP.hull).stroke({ color: SHIP.hullLine, width: 3 });
    const i = s.interior;
    for (let x = i.x + 40; x < i.x + i.w; x += 80) {
      g.moveTo(x, i.y - 20).lineTo(x, i.y - 4).stroke({ color: SHIP.hullDark, width: 1 });
      g.moveTo(x, i.y + i.h + 4).lineTo(x, i.y + i.h + 20).stroke({ color: SHIP.hullDark, width: 1 });
    }
    g.moveTo(s.hull[0], s.hull[1] + 3).lineTo(s.hull[2], s.hull[3] + 3).stroke({ color: SHIP.hullLight, width: 2 });
    // Antenna mast on the roof.
    g.moveTo(i.x + i.w - 40, i.y - 22).lineTo(i.x + i.w - 40, i.y - 50).stroke({ color: SHIP.hullLine, width: 3 });
    g.circle(i.x + i.w - 40, i.y - 52, 3).fill(SHIP.hullLight);
    // Docking collars where each ship's airlock meets the hull.
    for (const d of docks) g.rect(d.airlock[0].x - 14, d.airlock[0].y - 6, 28, 8).fill(SHIP.hullDark).stroke({ color: d.color, width: 2 });

    this.buildInterior(g, s);

    // Nameplate.
    const shared = docks.length > 1;
    const title = label(18, 0xf2f4f6, { fontWeight: "700", letterSpacing: 3, stroke: { color: 0x000000, width: 4 } });
    title.text = s.name.toUpperCase();
    title.position.set(s.nameplate.x, s.nameplate.y);
    this.root.addChild(title);
    this.labels.push(title);
    const sub = new Text({
      text: [shared ? `SHARED · ${docks.length} SHIPS DOCKED` : "1 SHIP DOCKED", s.repo].filter(Boolean).join("  ·  "),
      style: { fontFamily: MONO, fontSize: 10, fill: 0x9aa7bd, letterSpacing: 1 },
    });
    sub.resolution = 3;
    sub.position.set(s.nameplate.x + 2, s.nameplate.y + 26);
    this.root.addChild(sub);
    this.labels.push(sub);
    const nameHit = new Container();
    nameHit.eventMode = "static";
    nameHit.cursor = "pointer";
    nameHit.hitArea = new Rectangle(s.nameplate.x, s.nameplate.y, 420, 40);
    nameHit.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      sfx.building();
      worldRef.current?.focusRect(s.bounds);
    });
    this.root.addChild(nameHit);

    if (s.rooms.archive) {
      const a = s.rooms.archive.rect;
      const hit = new Container();
      hit.eventMode = "static";
      hit.cursor = "pointer";
      hit.hitArea = new Rectangle(a.x, a.y, a.w, a.h);
      const first = docks[0];
      hit.on("pointertap", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        sfx.building();
        if (first) setSelection({ kind: "library", envId: first.envId, projectId: first.projectId });
      });
      this.root.addChild(hit);
    }
  }

  private buildInterior(g: Graphics, s: StationLayout): void {
    const T = TILE;
    const r = s.interior;
    g.rect(r.x, r.y, r.w, r.h).fill(SHIP.floor);
    for (let x = r.x + T; x < r.x + r.w; x += T) g.moveTo(x, r.y).lineTo(x, r.y + r.h).stroke({ color: SHIP.floorLine, width: 1 });
    for (let y = r.y + T; y < r.y + r.h; y += T) g.moveTo(r.x, y).lineTo(r.x + r.w, y).stroke({ color: SHIP.floorLine, width: 1 });

    for (const room of Object.values(s.rooms)) {
      if (!room) continue;
      const rr = room.rect;
      if (room.kind === "quarters") {
        for (let x = rr.x; x < rr.x + rr.w - 1; x += T) {
          for (let y = rr.y; y < rr.y + rr.h - 1; y += T) {
            g.roundRect(x + 4, y + 8, T - 8, T - 14, 3).fill(0x46505c).stroke({ color: SHIP.wall, width: 1 });
            g.rect(x + 5, y + 9, 6, T - 16).fill(0xd8dde2);
          }
        }
      } else if (room.kind === "archive") {
        for (let x = rr.x + 6; x < rr.x + rr.w - 8; x += 9) g.rect(x, rr.y + 6, 6, rr.h - 12).fill(0x3f6a8f).stroke({ color: SHIP.wall, width: 1 });
      }
    }
    for (const p of s.consoles) {
      g.roundRect(p.x - 14, p.y - 9, 28, 12, 2).fill(0x39424c).stroke({ color: SHIP.wall, width: 1.5 });
      g.rect(p.x - 4, p.y + 15, 8, 6).fill(0x5f6a76).stroke({ color: SHIP.wall, width: 1 });
    }
    for (const room of Object.values(s.rooms)) {
      if (room) g.rect(room.rect.x, room.rect.y, room.rect.w, room.rect.h).stroke({ color: SHIP.wall, width: 3 });
    }
    for (const d of s.doors) {
      if (d.vertical) g.rect(d.x - 3, d.y - 9, 6, 18).fill(SHIP.door).stroke({ color: SHIP.doorDark, width: 1 });
      else g.rect(d.x - 9, d.y - 3, 18, 6).fill(SHIP.door).stroke({ color: SHIP.doorDark, width: 1 });
    }
  }

  /** A small FTL ship for one environment, docked below the station. */
  private buildDock(g: Graphics, d: DockLayout, state: GameState): void {
    const h = d.hull;
    const [a, b] = d.airlock;
    g.rect(a.x - 7, a.y, 14, b.y - a.y + 4).fill(SHIP.hullDark).stroke({ color: SHIP.hullLine, width: 2 });
    for (let y = a.y + 8; y < b.y; y += 8) g.moveTo(a.x - 7, y).lineTo(a.x + 7, y).stroke({ color: SHIP.hullLine, width: 1 });
    // Hull: stern on the left (engine), bow on the right.
    const bow = 26;
    g.poly([h.x, h.y + 6, h.x + h.w - bow, h.y, h.x + h.w, h.y + h.h / 2, h.x + h.w - bow, h.y + h.h, h.x, h.y + h.h - 6])
      .fill(SHIP.hull)
      .stroke({ color: SHIP.hullLine, width: 2.5 });
    g.rect(h.x - 14, h.y + h.h / 2 - 9, 14, 18).fill(SHIP.hullDark).stroke({ color: SHIP.hullLine, width: 2 });
    // Team-colored stripe and cockpit window.
    g.rect(h.x + 8, h.y + h.h / 2 - 3, h.w - bow - 20, 6).fill(d.color);
    g.poly([h.x + h.w - bow - 4, h.y + 12, h.x + h.w - 10, h.y + h.h / 2, h.x + h.w - bow - 4, h.y + h.h - 12]).fill(0x1d3446).stroke({ color: SHIP.hullLine, width: 1.5 });

    // Nameplate: the environment's name.
    const p = d.plate;
    g.rect(p.x, p.y, p.w, p.h).fill({ color: 0x0b0e12, alpha: 0.92 }).stroke({ color: d.color, width: 1.5 });
    g.rect(p.x, p.y, 5, p.h).fill(d.color);
    const name = label(9, 0xf2f4f6, { letterSpacing: 1.5 });
    name.text = truncate((state.envs[d.envId]?.summary.label ?? "?").toUpperCase(), 16);
    name.anchor.set(0, 0.5);
    name.position.set(p.x + 11, p.y + p.h / 2);
    this.root.addChild(name);
    this.plateTexts.push(name);

    // Clicking the ship selects this environment's bay (recruit there, see its roster).
    const hit = new Container();
    hit.eventMode = "static";
    hit.cursor = "pointer";
    hit.hitArea = new Rectangle(h.x - 14, h.y, h.w + 14, p.y + p.h - h.y);
    hit.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      sfx.building();
      setSelection({ kind: "building", envId: d.envId, projectId: d.projectId });
    });
    this.root.addChild(hit);
  }

  setZoom(zoom: number): void {
    for (const l of this.labels) l.scale.set(Math.max(1, 0.7 / zoom));
    for (const t of this.plateTexts) t.visible = zoom > 0.3;
  }

  destroy(): void {
    this.root.destroy({ children: true });
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
  private stationLayer = new Container();
  private lights = new Graphics();
  private crewLayer = new Container();
  private overlay = new Graphics();
  private edge = new Graphics();
  private edgeHits = new Container();
  private stations = new Map<string, StationSprite>();
  private crew = new Map<string, CrewSprite>();
  private layout: FleetLayout = { stations: new Map(), docks: new Map(), crew: new Map(), bounds: { x: 0, y: 0, w: 0, h: 0 } };
  private zoom = 1;
  private time = 0;
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
    this.camera.addChild(this.grid, this.stationLayer, this.lights, this.crewLayer, this.overlay);
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
    const topInset = 64;
    const z = Math.min(maxZoom, Math.min(usableW / (rect.w + 120), (height - topInset) / (rect.h + 120)));
    this.setZoom(z);
    this.camera.position.set(leftInset + usableW / 2 - (rect.x + rect.w / 2) * this.zoom, topInset + (height - topInset) / 2 - (rect.y + rect.h / 2) * this.zoom);
  }

  fitAll(): void {
    if (!this.initialized) return;
    this.frame(this.layout.bounds, 1.2, 0, Math.min(300, this.app.screen.width * 0.2));
  }

  focusRect(rect: Rect): void {
    if (!this.initialized) return;
    this.userMoved = true;
    this.frame(rect, 1.8, Math.min(460, this.app.screen.width * 0.3), Math.min(300, this.app.screen.width * 0.2));
  }

  /** Frame every station an environment's ships are docked at. */
  focusStation(envId: string): void {
    let rect: Rect | undefined;
    for (const d of this.layout.docks.values()) {
      if (d.envId !== envId) continue;
      const s = this.layout.stations.get(d.stationKey);
      if (!s) continue;
      const r = s.bounds;
      if (!rect) rect = r;
      else {
        const x = Math.min(rect.x, r.x);
        const y = Math.min(rect.y, r.y);
        rect = { x, y, w: Math.max(rect.x + rect.w, r.x + r.w) - x, h: Math.max(rect.y + rect.h, r.y + r.h) - y };
      }
    }
    if (rect) this.focusRect(rect);
  }

  centerOn(x: number, y: number): void {
    if (!this.initialized) return;
    this.userMoved = true;
    const { width, height } = this.app.screen;
    this.camera.position.set(width / 2 - x * this.zoom, height / 2 - y * this.zoom);
  }

  /** Center the camera on a unit, docked ship or archive, leaving room for the side panel. */
  focus(selection: Selection): void {
    if (!selection || !this.initialized) return;
    let p: Point | undefined;
    if (selection.kind === "unit") p = this.crew.get(unitKey(selection.envId, selection.threadId))?.pos;
    else {
      const d = this.layout.docks.get(`${selection.envId}:${selection.projectId}`);
      const s = d && this.layout.stations.get(d.stationKey);
      const r = selection.kind === "library" ? s?.rooms.archive?.rect : d?.hull;
      if (r) p = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    }
    if (!p) return;
    this.userMoved = true;
    const { width, height } = this.app.screen;
    this.setZoom(Math.max(this.zoom, 1.7));
    this.camera.position.set(width * 0.4 - p.x * this.zoom, height / 2 + 20 - p.y * this.zoom);
  }

  minimap(): MinimapData | undefined {
    if (!this.initialized) return undefined;
    const { width, height } = this.app.screen;
    const view = { x: -this.camera.x / this.zoom, y: -this.camera.y / this.zoom, w: width / this.zoom, h: height / this.zoom };
    const state = useGame.getState();
    return {
      bounds: this.layout.bounds,
      hubs: [...this.layout.stations.values()].map((s) => s.interior),
      stations: [...this.layout.docks.values()].map((d) => ({ rect: d.hull, color: d.color, live: state.envs[d.envId]?.connection === "live" })),
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
      for (const [key, station] of this.layout.stations) {
        seen.add(key);
        let sprite = this.stations.get(key);
        if (!sprite) {
          sprite = new StationSprite(key);
          this.stations.set(key, sprite);
          this.stationLayer.addChild(sprite.root);
        }
        sprite.build(station, this.layout, state);
      }
      for (const [key, sprite] of this.stations) {
        if (seen.has(key)) continue;
        sprite.destroy();
        this.stations.delete(key);
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
          sprite = new CrewSprite(lay);
          this.crew.set(key, sprite);
          this.crewLayer.addChild(sprite);
        }
        const team = this.layout.docks.get(lay.dockKey)?.color ?? 0xffffff;
        const detail = state.details[key];
        sprite.update(thread, detail ? telemetry(detail.thread) : undefined, team);
      }
    }
    for (const [key, sprite] of this.crew) {
      if (seenCrew.has(key)) continue;
      sprite.destroy({ children: true });
      this.crew.delete(key);
    }

    if (layoutChanged && !this.userMoved && Object.values(state.envs).some((e) => e.synced)) this.fitAll();
  }

  private drawGrid(): void {
    const g = this.grid.clear();
    const b = this.layout.bounds;
    const step = 400;
    const pad = 2400;
    const x0 = Math.floor((b.x - pad) / step) * step;
    const y0 = Math.floor((b.y - pad) / step) * step;
    for (let x = x0; x < b.x + b.w + pad; x += step) {
      for (let y = y0; y < b.y + b.h + pad; y += step) {
        g.rect(x - 3, y, 7, 1).fill({ color: HUD.cyan, alpha: 0.14 });
        g.rect(x, y - 3, 1, 7).fill({ color: HUD.cyan, alpha: 0.14 });
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

    for (const [key, sprite] of this.crew) {
      const lay = this.layout.crew.get(key);
      const s = lay && this.layout.stations.get(lay.stationKey);
      if (!lay || !s) continue;
      const selected = sel?.kind === "unit" && sel.envId === sprite.envId && sel.threadId === sprite.threadId;
      sprite.tick(lay, s, t, dt, selected, this.zoom);
    }
    this.drawLights(state, sel, t);
    for (const station of this.stations.values()) station.setZoom(this.zoom);
    this.drawEdgeIndicators(t);
  }

  /** Everything that changes frame to frame: screens, system icons, engines, plates, alerts. */
  private drawLights(state: GameState, sel: Selection, t: number): void {
    const g = this.lights.clear();
    const o = this.overlay.clear();

    // Per-station and per-dock tallies from the crew.
    const stationUse = new Map<string, Record<SystemRoom, boolean> & { attention: boolean; monitoringOnly: boolean }>();
    const dockStates = new Map<string, UnitState[]>();
    for (const sprite of this.crew.values()) {
      const lay = this.layout.crew.get(sprite.key);
      if (!lay) continue;
      const u = stationUse.get(lay.stationKey) ?? { terminal: false, files: false, comms: false, attention: false, monitoringOnly: true };
      if (sprite.atStation) {
        if (sprite.state === "monitoring") u.comms = true;
        else if (sprite.info?.workstation && sprite.info.workstation !== "console") {
          u[sprite.info.workstation] = true;
          if (sprite.info.workstation === "comms") u.monitoringOnly = false;
        }
      }
      if (sprite.state === "alert" || sprite.state === "question") u.attention = true;
      stationUse.set(lay.stationKey, u);
      if (!lay.sleeping) dockStates.set(lay.dockKey, [...(dockStates.get(lay.dockKey) ?? []), sprite.state]);
    }

    for (const s of this.layout.stations.values()) {
      const u = stationUse.get(s.key);
      const bridge = s.rooms.bridge?.rect;
      if (bridge && u?.attention) g.rect(bridge.x, bridge.y, bridge.w, bridge.h).fill({ color: STATUS.alert, alpha: 0.12 + Math.sin(t * 5) * 0.08 });

      for (const kind of ["terminal", "files", "comms"] as const) {
        const room = s.rooms[kind];
        if (!room) continue;
        const cx = room.rect.x + room.rect.w / 2;
        const cy = room.rect.y + room.rect.h * 0.32;
        const on = !!u?.[kind];
        const color = on ? (kind === "comms" && u?.monitoringOnly ? STATUS.monitoring : SHIP.iconOn) : SHIP.icon;
        g.circle(cx, cy, 9).fill({ color: 0x15191d, alpha: 0.85 }).stroke({ color, width: 2 });
        if (kind === "terminal") {
          g.moveTo(cx - 5, cy - 3).lineTo(cx - 1, cy).lineTo(cx - 5, cy + 3).stroke({ color, width: 1.5 });
          g.rect(cx, cy + 2, 5, 1.5).fill({ color, alpha: on ? 0.6 + Math.sin(t * 8) * 0.4 : 1 });
        } else if (kind === "files") {
          g.rect(cx - 4, cy - 5, 7, 9).stroke({ color, width: 1.2 });
          g.rect(cx - 2, cy - 3, 7, 9).fill({ color: 0x15191d }).stroke({ color, width: 1.2 });
        } else {
          const a = on ? t * 3 : -Math.PI / 4;
          g.circle(cx, cy, 5).stroke({ color, width: 1 });
          g.moveTo(cx, cy).lineTo(cx + Math.cos(a) * 5, cy + Math.sin(a) * 5).stroke({ color, width: 1.5 });
        }
      }
    }

    // Console screens show what the crew member at that console is doing.
    for (const sprite of this.crew.values()) {
      const lay = this.layout.crew.get(sprite.key);
      if (!lay?.console) continue;
      const live = state.envs[sprite.envId]?.connection === "live";
      const p = lay.console;
      let color = 0x1c2228;
      let alpha = 1;
      switch (sprite.state) {
        case "working":
          color = 0x59e1ff;
          alpha = sprite.atConsole ? 0.8 + Math.sin(t * 18 + p.x) * 0.15 : 0.35;
          break;
        case "monitoring":
          color = STATUS.monitoring;
          alpha = 0.45;
          break;
        case "alert":
        case "question":
          color = STATUS[sprite.state];
          alpha = 0.5 + Math.sin(t * 6) * 0.4;
          break;
        case "done":
          color = 0x6fe37a;
          alpha = 0.7;
          break;
        case "error":
          color = STATUS.error;
          alpha = 0.7;
          break;
      }
      if (!live) alpha *= 0.25;
      g.rect(p.x - 11, p.y - 7, 22, 7).fill({ color, alpha });
      // A team-colored tab on each console shows whose desk it is.
      g.rect(p.x - 14, p.y - 9, 3, 12).fill(sprite.team);
    }

    // Docked ships: connection light, engine glow while their crew work, FTL power bar.
    for (const d of this.layout.docks.values()) {
      const env = state.envs[d.envId];
      const live = env?.connection === "live";
      const states = dockStates.get(d.key) ?? [];
      const working = states.includes("working");
      const h = d.hull;
      if (working && live) {
        const flicker = 0.7 + Math.sin(t * 30 + h.x) * 0.15;
        g.poly([h.x - 14, h.y + h.h / 2 - 7, h.x - 34 - flicker * 10, h.y + h.h / 2, h.x - 14, h.y + h.h / 2 + 7]).fill({ color: 0x59e1ff, alpha: 0.5 + flicker * 0.3 });
      }
      const p = d.plate;
      const lightColor = live ? 0x6fe37a : env?.connection === "reconnecting" || env?.connection === "connecting" ? STATUS.question : 0x59626c;
      g.circle(p.x + p.w - 9, p.y + p.h / 2, 3.5).fill({ color: lightColor, alpha: live ? 1 : 0.5 + Math.sin(t * 4) * 0.4 });
      const segs = states.slice(0, 8);
      segs.forEach((s, k) => g.rect(h.x + 10 + k * 8, h.y + 8, 6, 9).fill(STATUS[s]).stroke({ color: 0x101418, width: 1 }));
      if (!live) o.poly([h.x, h.y + 6, h.x + h.w - 26, h.y, h.x + h.w, h.y + h.h / 2, h.x + h.w - 26, h.y + h.h, h.x, h.y + h.h - 6]).fill({ color: 0x05070a, alpha: 0.6 });
      if (sel && sel.kind === "building" && `${sel.envId}:${sel.projectId}` === d.key) {
        o.rect(h.x - 20, h.y - 6, h.w + 26, p.y + p.h - h.y + 12).stroke({ color: 0x6fe37a, width: 2.5 });
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
