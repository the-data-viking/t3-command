// The fleet map, rendered with PixiJS from the hand-authored pixel-art kit (src/art). A view of
// the game store: it reads state, and clicks become store selections. Flight Deck switches
// between warm plating and Night Shift; everything re-textures from the same sprites.
//
// FTL-style: every project is a station seen in cross-section, and everyone working on it, from
// any environment, works side by side in its rooms. Each environment is one ship in the fleet
// row, with supply lines to the stations it crews; its crew wear its team color. Crew walk room
// to room through doors to use the system their open tool call needs.
//
// Rule borrowed from StarNet: the map never shows activity T3 can't prove. Screens and system
// icons light up only for real work, crew walk only for real tool calls, a ship's engine burns
// and its supply lines carry packets only while its crew are working, and idle crew stand still.

import { Application, Container, Graphics, Rectangle, Sprite, Text, TilingSprite, type FederatedPointerEvent, type TextStyleOptions } from "pixi.js";
import * as A from "../art/sprites";
import type { Arms, Legs } from "../art/render";
import { setSelection, unitKey, useGame, type GameState, type Selection } from "../store";
import { isHistory, unitState, type UnitState } from "../t3/derive";
import { telemetry, type Telemetry } from "../t3/telemetry";
import type { ThreadShell } from "../t3/types";
import { computeFleetLayout, QUARTERS_SHOWN, TILE, type CrewLayout, type FleetLayout, type Point, type Rect, type RoomKind, type ShipLayout, type StationLayout, type SystemRoom } from "./layout";
import { sfx } from "./sfx";
import { CrewMotion } from "./crew-motion";
import { RenderLoop } from "./render-loop";
import { crewTex, currentStyle, PX, tex } from "./textures";
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

/** Fixed supply-line geometry is independent of the animated packets travelling along it. */
function linkPoint(from: Point, to: Point, k: number): Point {
  const u = 1 - k;
  const midY = (from.y + to.y) / 2;
  return {
    x: u * u * u * from.x + 3 * u * u * k * from.x + 3 * u * k * k * to.x + k * k * k * to.x,
    y: u * u * u * from.y + 3 * u * u * k * midY + 3 * u * k * k * midY + k * k * k * to.y,
  };
}

function sprite(texture: ReturnType<typeof tex>, x: number, y: number, ax = 0, ay = 0, scale = PX): Sprite {
  const s = new Sprite(texture);
  s.anchor.set(ax, ay);
  s.scale.set(scale);
  s.position.set(Math.round(x), Math.round(y));
  return s;
}

/** Zoom below which crew are drawn larger and labels hold a minimum on-screen size. */
const STRATEGIC_ZOOM = 0.55;
const WALK_SPEED = 75; // px per second, constant like FTL crew
const SCREEN_OFF = 0x1c2228;

/** Console screen color for a crew member's state; blinks and flicker alternate per frame. */
function screenColor(state: UnitState, frame: number, atConsole: boolean): number {
  switch (state) {
    case "working":
      return atConsole ? (frame % 2 ? 0x59e1ff : 0x9ff0ff) : 0x2a6f80;
    case "monitoring":
      return 0x7a5fb8;
    case "alert":
      return frame % 2 ? 0xff4655 : 0x7a1820;
    case "question":
      return frame % 2 ? 0xffd23f : 0x7a6418;
    case "done":
      return 0x5dff9a;
    case "error":
      return 0xff7a3d;
    default:
      return SCREEN_OFF;
  }
}

const BADGES: Partial<Record<UnitState, A.Grid>> = {
  alert: A.BADGE_ALERT,
  question: A.BADGE_QUESTION,
  done: A.BADGE_DONE,
  error: A.BADGE_ERROR,
  monitoring: A.BADGE_MONITOR,
};

// ---- Crew ------------------------------------------------------------------------------

class CrewSprite extends Container {
  readonly key: string;
  readonly envId: string;
  readonly threadId: string;
  private seed: number;
  private ring = new Graphics();
  private figure = new Sprite();
  private badge = new Sprite();
  private fx = new Graphics();
  private nameText = label(7, HUD.text, { stroke: { color: 0x000000, width: 3 } });
  private motion: CrewMotion;
  private hasTelemetry = false;
  get pos(): Point { return this.motion.pos; }
  get room(): RoomKind { return this.motion.room; }
  state: UnitState = "idle";
  thread!: ThreadShell;
  info?: Telemetry;
  tier: Tier = "standard";
  silhouette: Silhouette = "round";
  team = 0xffffff;
  hovered = false;
  /** At their own console (vs. walking, at a system room, or in quarters). */
  atConsole = true;
  /** At the system room their current work needs. */
  atStation = false;

  /** Sleepers' decorative drift doesn't keep an otherwise idle fleet rendering. */
  get animated(): boolean {
    return this.motion.moving || this.state === "working" || this.state === "monitoring"
      || this.state === "alert" || this.state === "question" || !!this.info?.tasks;
  }

  constructor(layout: CrewLayout) {
    super();
    this.key = layout.key;
    this.envId = layout.envId;
    this.threadId = layout.threadId;
    this.seed = hash(layout.key);
    this.motion = new CrewMotion(layout);
    this.figure.anchor.set(0.5, 1);
    this.badge.anchor.set(0, 1);
    this.badge.scale.set(PX);
    this.nameText.anchor.set(0.5, 0);
    this.nameText.y = 6;
    this.addChild(this.ring, this.figure, this.badge, this.fx, this.nameText);
    this.eventMode = "static";
    this.cursor = "pointer";
    this.hitArea = new Rectangle(-16, -44, 32, 48);
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
    if (info && !this.hasTelemetry) {
      this.hasTelemetry = true;
      this.motion.hydrate();
    }
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
      return { room: system, point: { x: spot.x + Math.round((this.seed - 0.5) * Math.min(r.w * 0.3, 40)), y: spot.y } };
    }
    return { room: "bridge", point: layout.home };
  }

  tick(layout: CrewLayout, s: StationLayout, t: number, dt: number, frame: number, selected: boolean, zoom: number): void {
    const want = this.desired(layout, s);
    this.motion.step(layout, s, want, dt, WALK_SPEED);
    const moving = this.motion.moving;
    this.atConsole = !moving && !layout.sleeping && this.room === "bridge";
    this.atStation = !moving && this.room !== "bridge" && this.room !== "quarters";
    // Snap to whole sprite pixels so the art stays crisp.
    this.position.set(Math.round(this.pos.x / PX) * PX, Math.round(this.pos.y / PX) * PX);
    this.zIndex = this.pos.y;

    const boost = zoom < STRATEGIC_ZOOM ? Math.min(2, STRATEGIC_ZOOM / zoom) : 1;
    this.scale.set(boost);

    const visor = PROVIDER_VISOR[this.thread.modelSelection.instanceId] ?? 0x9fb3d1;
    if (layout.sleeping) {
      this.figure.texture = tex(A.BUNK_SLEEPER, { team: this.team, visor });
      this.figure.anchor.set(0.5, 0.5);
      this.figure.scale.set(PX);
      this.badge.visible = false;
    } else {
      const working = this.state === "working" && (this.atConsole || this.atStation);
      const legs: Legs = moving ? (frame % 2 ? "walkA" : "walkB") : "idle";
      const arms: Arms = working ? (frame % 2 ? "typeA" : "typeB") : "idle";
      this.figure.texture = crewTex(this.silhouette, this.tier, legs, arms, this.team, visor);
      this.figure.anchor.set(0.5, 1);
      this.figure.scale.set(PX * this.motion.facing, PX);
      const badge = BADGES[this.state];
      this.badge.visible = !!badge;
      if (badge) {
        this.badge.texture = tex(badge, { visor: STATUS.monitoring });
        const bob = this.state === "alert" || this.state === "question" ? (frame % 2) * PX : 0;
        this.badge.position.set(8, -40 - bob);
      }
    }

    this.drawFx(t, selected, zoom, layout.sleeping);
    this.drawRing(selected, t, layout.sleeping);
    this.nameText.visible = !layout.sleeping && (selected || this.hovered || zoom > 1.7);
  }

  private drawFx(t: number, selected: boolean, zoom: number, sleeping: boolean): void {
    const f = this.fx.clear();
    if (sleeping) {
      const drift = (t * 0.5 + this.seed) % 1;
      f.rect(Math.round(10 + drift * 8), Math.round(-12 - drift * 14), 4, 2).fill({ color: 0xffffff, alpha: 1 - drift });
      return;
    }
    if (this.state === "working") {
      // Spinning pip: busy, no attention needed.
      const a = Math.floor(t * 8) % 4;
      const pts = [[0, -6], [6, 0], [0, 6], [-6, 0]];
      pts.forEach(([x, y], i) => f.rect(12 + x / 2, -40 + y / 2, 3, 3).fill({ color: i === a ? 0x59e1ff : 0x1d4a57 }));
    }
    const tasks = Math.min(4, this.info?.tasks ?? 0);
    for (let i = 0; i < tasks; i++) {
      const a = t * 2.2 + (i / tasks) * Math.PI * 2;
      f.rect(Math.round(Math.cos(a) * 18) - 2, Math.round(-22 + Math.sin(a) * 7) - 2, 4, 4).fill(0x59e1ff).stroke({ color: 0x101418, width: 1 });
    }
    const ctx = this.info?.context;
    if (ctx !== undefined && (selected || this.hovered || zoom > 1.3)) {
      const left = 1 - ctx;
      const color = left > 0.4 ? 0x6fe37a : left > 0.15 ? STATUS.question : STATUS.alert;
      for (let i = 0; i < 8; i++) f.rect(-16 + i * 4, 4, 3, 4).fill(i / 8 < left ? color : 0x2a3036);
    }
  }

  private drawRing(selected: boolean, t: number, sleeping: boolean): void {
    const r = this.ring.clear();
    if (sleeping) {
      if (selected) r.rect(-26, -10, 52, 20).stroke({ color: 0x6fe37a, width: 2 });
      return;
    }
    if (selected) {
      r.ellipse(0, 0, 16, 6).stroke({ color: 0x6fe37a, width: 2 });
    } else if (this.state === "alert" || this.state === "question") {
      const g = (t * 1.1 + this.seed) % 1;
      r.ellipse(0, 0, 10 + g * 22, 4 + g * 8).stroke({ color: STATUS[this.state], width: 2, alpha: 1 - g });
    } else if (this.hovered) {
      r.ellipse(0, 0, 15, 5).stroke({ color: 0x101418, width: 1.5, alpha: 0.7 });
    }
  }
}

// ---- Stations --------------------------------------------------------------------------

/** One project station. Static geometry is rebuilt on layout or art-style changes. */
class StationSprite {
  readonly key: string;
  readonly root = new Container();
  private labels: Text[] = [];
  /** Console sprites by "x,y" of their layout point, so screens can be updated live. */
  readonly consoles = new Map<string, Sprite>();

  constructor(key: string) {
    this.key = key;
  }

  build(s: StationLayout, state: GameState): void {
    for (const child of this.root.removeChildren()) child.destroy({ children: true });
    this.labels = [];
    this.consoles.clear();
    const style = currentStyle();
    const c = style.colors;
    const g = new Graphics();
    this.root.addChild(g);

    // Hull plating: outline, fill, a highlight along the top, shadow along the bottom.
    g.poly(s.hull).fill(c.H).stroke({ color: c.k, width: 4 });
    const i = s.interior;
    const hullTop = s.hull[1];
    const hullBottom = s.hull[11];
    g.rect(s.hull[0], hullTop + 2, s.hull[2] - s.hull[0], 4).fill(c.h);
    g.rect(s.hull[10], hullBottom - 6, s.hull[8] - s.hull[10], 4).fill(c.D);
    for (let x = i.x + 48; x < i.x + i.w; x += 96) {
      g.rect(x, hullTop + 10, 2, i.y - hullTop - 14).fill(c.D);
      g.rect(x, i.y + i.h + 4, 2, hullBottom - i.y - i.h - 12).fill(c.D);
    }
    // Antenna mast and the supply port where ships' lines arrive.
    g.rect(i.x + i.w - 42, hullTop - 28, 4, 28).fill(c.k);
    g.rect(i.x + i.w - 44, hullTop - 32, 8, 6).fill(c.a);
    g.rect(s.port.x - 18, s.port.y - 6, 36, 10).fill(c.D).stroke({ color: c.k, width: 2 });

    // Deck plating.
    const floor = new TilingSprite({ texture: tex(A.FLOOR), width: i.w, height: i.h });
    floor.tileScale.set(PX);
    floor.position.set(i.x, i.y);
    this.root.addChild(floor);
    for (const [kind, grid] of [["bridge", A.FLOOR_BRIDGE], ["quarters", A.FLOOR_QUARTERS]] as const) {
      const room = s.rooms[kind]?.rect;
      if (!room) continue;
      const deck = new TilingSprite({ texture: tex(grid), width: room.w, height: room.h });
      deck.tileScale.set(PX);
      deck.position.set(room.x, room.y);
      this.root.addChild(deck);
    }
    const fixtures = new Container();
    this.root.addChild(fixtures);

    // Systems, each against the left side of its room.
    const sys: Array<[SystemRoom, A.Grid]> = [
      ["terminal", A.TERMINAL],
      ["files", A.FILES],
      ["comms", A.COMMS],
    ];
    for (const [kind, grid] of sys) {
      const r = s.rooms[kind]?.rect;
      if (r) fixtures.addChild(sprite(tex(grid), r.x + r.w * 0.3, r.y + r.h - 6, 0.5, 1));
    }
    // Bridge consoles with chairs (screens update live).
    for (const p of s.consoles) {
      fixtures.addChild(sprite(tex(A.CHAIR), p.x, p.y + 22, 0.5, 1));
      const con = sprite(tex(A.CONSOLE, { screen: SCREEN_OFF }), p.x, p.y - 26, 0.5, 0);
      fixtures.addChild(con);
      this.consoles.set(`${p.x},${p.y}`, con);
    }
    // Quarters: three bunks (sleepers are drawn by their crew sprites).
    const q = s.rooms.quarters?.rect;
    if (q) {
      for (let k = 0; k < QUARTERS_SHOWN; k++) fixtures.addChild(sprite(tex(A.BUNK_EMPTY), q.x + TILE * 1.5 + k * TILE * 1.5, q.y + q.h - TILE / 2, 0.5, 0.5));
    }
    // Archive shelves.
    const ar = s.rooms.archive?.rect;
    if (ar) {
      const teams = [0x3f6a8f, 0xf0a33a, 0x3ec7b3, 0x9b7bff];
      let k = 0;
      for (let y = ar.y + 8; y + 18 <= ar.y + ar.h - 4; y += 26) {
        for (let x = ar.x + 4; x + 28 <= ar.x + ar.w - 2; x += 30) fixtures.addChild(sprite(tex(A.SHELF, { team: teams[k++ % teams.length] }), x, y));
      }
    }

    // Walls, then doors on top of them.
    const walls = new Graphics();
    for (const room of Object.values(s.rooms)) {
      if (room) walls.rect(room.rect.x, room.rect.y, room.rect.w, room.rect.h).stroke({ color: style.wall, width: 4, alignment: 0.5 });
    }
    walls.rect(i.x - 2, i.y - 2, i.w + 4, i.h + 4).stroke({ color: style.wall, width: 4 });
    this.root.addChild(walls);
    for (const d of s.doors) {
      const door = sprite(tex(A.DOOR_H), d.x, d.y, 0.5, 0.5);
      if (d.vertical) door.rotation = Math.PI / 2;
      this.root.addChild(door);
    }

    // The whole interior opens the project panel (recruit on any member environment there).
    const first = s.members[0];
    const interior = new Container();
    interior.eventMode = "static";
    interior.cursor = "pointer";
    interior.hitArea = new Rectangle(i.x, i.y, i.w, i.h);
    interior.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      sfx.building();
      if (first) setSelection({ kind: "building", envId: first.envId, projectId: first.projectId });
    });
    this.root.addChild(interior);

    // Nameplate.
    const machines = new Set(s.members.map((m) => m.envId)).size;
    const title = label(18, 0xf2f4f6, { fontWeight: "700", letterSpacing: 3, stroke: { color: 0x000000, width: 4 } });
    title.text = s.name.toUpperCase();
    title.position.set(s.nameplate.x, s.nameplate.y);
    this.root.addChild(title);
    this.labels.push(title);
    const sub = new Text({
      text: [machines > 1 ? `SHARED · ${machines} MACHINES` : state.envs[first?.envId ?? ""]?.summary.label.toUpperCase(), s.settledHidden ? `+${s.settledHidden} SETTLED` : ""]
        .filter(Boolean)
        .join("  ·  "),
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

    if (ar && first) {
      const hit = new Container();
      hit.eventMode = "static";
      hit.cursor = "pointer";
      hit.hitArea = new Rectangle(ar.x, ar.y, ar.w, ar.h);
      hit.on("pointertap", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        sfx.building();
        setSelection({ kind: "library", envId: first.envId, projectId: first.projectId });
      });
      this.root.addChild(hit);
    }
  }

  setZoom(zoom: number): void {
    for (const l of this.labels) l.scale.set(Math.max(1, 0.7 / zoom));
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}

// ---- Ships -----------------------------------------------------------------------------

/** One environment's ship in the fleet row. */
class ShipSprite {
  readonly envId: string;
  readonly root = new Container();
  hullSprite?: Sprite;
  private name?: Text;

  constructor(envId: string) {
    this.envId = envId;
  }

  build(ship: ShipLayout, state: GameState): void {
    for (const child of this.root.removeChildren()) child.destroy({ children: true });
    const h = ship.hull;
    this.hullSprite = sprite(tex(A.SHIP, { team: ship.color }), h.x, h.y, 0, 0, 3);
    this.root.addChild(this.hullSprite);

    const g = new Graphics();
    const p = ship.plate;
    g.rect(p.x, p.y, p.w, p.h).fill({ color: 0x0b0e12, alpha: 0.92 }).stroke({ color: ship.color, width: 2 });
    g.rect(p.x, p.y, 5, p.h).fill(ship.color);
    this.root.addChild(g);
    this.name = label(9, 0xf2f4f6, { letterSpacing: 1.5 });
    this.name.text = truncate((state.envs[ship.envId]?.summary.label ?? "?").toUpperCase(), 16);
    this.name.anchor.set(0, 0.5);
    this.name.position.set(p.x + 11, p.y + p.h / 2);
    this.root.addChild(this.name);

    // Clicking a ship frames every station it crews.
    const hit = new Container();
    hit.eventMode = "static";
    hit.cursor = "pointer";
    hit.hitArea = new Rectangle(h.x - 14, h.y, h.w + 14, p.y + p.h - h.y);
    hit.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      sfx.building();
      worldRef.current?.focusStation(ship.envId);
    });
    this.root.addChild(hit);
  }

  setZoom(zoom: number): void {
    if (this.name) this.name.visible = zoom > 0.3;
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
  private links = new Graphics();
  private packets = new Graphics();
  private stationLayer = new Container();
  private shipLayer = new Container();
  private lights = new Graphics();
  private crewLayer = new Container();
  private overlay = new Graphics();
  private edge = new Graphics();
  private edgeHits = new Container();
  private stations = new Map<string, StationSprite>();
  private ships = new Map<string, ShipSprite>();
  private crew = new Map<string, CrewSprite>();
  private layout: FleetLayout = { stations: new Map(), ships: new Map(), crew: new Map(), bounds: { x: 0, y: 0, w: 0, h: 0 } };
  private zoom = 1;
  private time = 0;
  /** Set once the user pans, zooms or jumps somewhere; until then the view keeps fitting the fleet. */
  private userMoved = false;
  private destroyed = false;
  /** Pixi finished initializing; until then the camera API is a no-op. */
  private initialized = false;
  private unsubscribe?: () => void;
  private ready: Promise<void>;
  private renderLoop?: RenderLoop;
  private resizeObserver?: ResizeObserver;
  private edgeTargets = new Map<string, Container>();
  private lastEnvs?: GameState["envs"];
  private lastDetails?: GameState["details"];
  private lastStyle?: GameState["artStyle"];

  constructor(host: HTMLElement) {
    this.ready = this.init(host);
  }

  private async init(host: HTMLElement): Promise<void> {
    // Pixel art needs one backing pixel per CSS pixel, not a Retina-sized framebuffer.
    await this.app.init({ width: host.clientWidth, height: host.clientHeight, background: currentStyle().space, antialias: false, autoDensity: true, resolution: 1, autoStart: false, powerPreference: "low-power" });
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
    this.camera.addChild(this.grid, this.links, this.packets, this.stationLayer, this.shipLayer, this.lights, this.crewLayer, this.overlay);
    this.app.stage.addChild(this.sky, this.camera, this.edge, this.edgeHits);
    this.setupCamera();

    this.renderLoop = new RenderLoop((dt) => {
      this.sync(useGame.getState());
      const animated = this.tick(dt);
      this.app.render();
      return animated;
    });
    this.unsubscribe = useGame.subscribe((s, prev) => {
      if (s.envs !== prev.envs || s.details !== prev.details || s.selection !== prev.selection || s.artStyle !== prev.artStyle) this.invalidate();
    });
    this.resizeObserver = new ResizeObserver(() => {
      if (this.destroyed) return;
      this.app.renderer.resize(host.clientWidth, host.clientHeight);
      this.invalidate();
    });
    this.resizeObserver.observe(host);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.onVisibility();
  }

  private invalidate = (): void => { this.renderLoop?.invalidate(); };

  private onVisibility = (): void => { this.renderLoop?.setVisible(!document.hidden); };

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe?.();
    this.renderLoop?.destroy();
    this.resizeObserver?.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    void this.ready.then(() => {
      if (this.app.renderer) this.app.destroy(true, { children: true });
    });
  }

  private makeStarTexture() {
    const size = 1024;
    const g = new Graphics();
    g.rect(0, 0, size, size).fill(currentStyle().space);
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
    const texture = this.app.renderer.generateTexture({ target: g, frame: new Rectangle(0, 0, size, size) });
    g.destroy();
    return texture;
  }

  // ---- Camera ----

  private setupCamera(): void {
    const stage = this.app.stage;
    stage.eventMode = "static";
    stage.hitArea = this.app.screen;
    stage.on("pointermove", this.invalidate);
    stage.on("pointerover", this.invalidate);
    stage.on("pointerout", this.invalidate);
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
        this.invalidate();
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
    this.invalidate();
  }

  private frame(rect: Rect, maxZoom: number, rightInset = 0, leftInset = 0): void {
    const { width, height } = this.app.screen;
    const usableW = width - rightInset - leftInset;
    const topInset = 64;
    const z = Math.min(maxZoom, Math.min(usableW / (rect.w + 120), (height - topInset) / (rect.h + 120)));
    this.setZoom(z);
    this.camera.position.set(leftInset + usableW / 2 - (rect.x + rect.w / 2) * this.zoom, topInset + (height - topInset) / 2 - (rect.y + rect.h / 2) * this.zoom);
    this.invalidate();
  }

  fitAll(): void {
    if (!this.initialized) return;
    this.frame(this.layout.bounds, 1.2, 0, Math.min(300, this.app.screen.width * 0.2));
  }

  focusRect(rect: Rect): void {
    if (!this.initialized) return;
    this.userMoved = true;
    this.frame(rect, 2, Math.min(460, this.app.screen.width * 0.3), Math.min(300, this.app.screen.width * 0.2));
  }

  /** Frame an environment's ship and every station it crews. */
  focusStation(envId: string): void {
    const ship = this.layout.ships.get(envId);
    if (!ship) return;
    let rect: Rect = { ...ship.hull, h: ship.plate.y + ship.plate.h - ship.hull.y };
    for (const link of ship.links) {
      const r = this.layout.stations.get(link.stationKey)?.bounds;
      if (!r) continue;
      const x = Math.min(rect.x, r.x);
      const y = Math.min(rect.y, r.y);
      rect = { x, y, w: Math.max(rect.x + rect.w, r.x + r.w) - x, h: Math.max(rect.y + rect.h, r.y + r.h) - y };
    }
    this.focusRect(rect);
  }

  /** The station holding a given environment's project. */
  stationFor(envId: string, projectId: string): StationLayout | undefined {
    for (const s of this.layout.stations.values()) if (s.members.some((m) => m.envId === envId && m.projectId === projectId)) return s;
    return undefined;
  }

  centerOn(x: number, y: number): void {
    if (!this.initialized) return;
    this.userMoved = true;
    const { width, height } = this.app.screen;
    this.camera.position.set(width / 2 - x * this.zoom, height / 2 - y * this.zoom);
    this.invalidate();
  }

  /** Center the camera on a unit, station or archive, leaving room for the side panel. */
  focus(selection: Selection): void {
    if (!selection || !this.initialized) return;
    let p: Point | undefined;
    if (selection.kind === "unit") p = this.crew.get(unitKey(selection.envId, selection.threadId))?.pos;
    else {
      const s = this.stationFor(selection.envId, selection.projectId);
      const r = selection.kind === "library" ? s?.rooms.archive?.rect : s?.interior;
      if (r) p = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    }
    if (!p) return;
    this.userMoved = true;
    const { width, height } = this.app.screen;
    this.setZoom(Math.max(this.zoom, 2));
    this.camera.position.set(width * 0.4 - p.x * this.zoom, height / 2 + 20 - p.y * this.zoom);
    this.invalidate();
  }

  minimap(): MinimapData | undefined {
    if (!this.initialized) return undefined;
    const { width, height } = this.app.screen;
    const view = { x: -this.camera.x / this.zoom, y: -this.camera.y / this.zoom, w: width / this.zoom, h: height / this.zoom };
    const state = useGame.getState();
    return {
      bounds: this.layout.bounds,
      hubs: [...this.layout.stations.values()].map((s) => s.interior),
      stations: [...this.layout.ships.values()].map((sh) => ({ rect: sh.hull, color: sh.color, live: state.envs[sh.envId]?.connection === "live" })),
      dots: [...this.crew.values()]
        .filter((c) => c.state !== "sleeping")
        .map((c) => ({ x: c.pos.x, y: c.pos.y, color: STATUS[c.state], big: c.state === "alert" || c.state === "question" })),
      view,
    };
  }

  // ---- Sync with the store ----

  private sync(state: GameState): void {
    const styleChanged = state.artStyle !== this.lastStyle;
    if (state.envs === this.lastEnvs && state.details === this.lastDetails && !styleChanged) return;
    const layoutChanged = state.envs !== this.lastEnvs;
    this.lastEnvs = state.envs;
    this.lastDetails = state.details;
    this.lastStyle = state.artStyle;

    if (styleChanged && this.initialized && this.sky) {
      this.app.renderer.background.color = currentStyle().space;
      const previous = this.sky.texture;
      this.sky.texture = this.makeStarTexture();
      previous.destroy(true);
    }

    if (layoutChanged || styleChanged) {
      if (layoutChanged) this.layout = computeFleetLayout(state);
      const seen = new Set<string>();
      for (const [key, station] of this.layout.stations) {
        seen.add(key);
        let sprite = this.stations.get(key);
        if (!sprite) {
          sprite = new StationSprite(key);
          this.stations.set(key, sprite);
          this.stationLayer.addChild(sprite.root);
        }
        sprite.build(station, state);
      }
      for (const [key, sprite] of this.stations) {
        if (seen.has(key)) continue;
        sprite.destroy();
        this.stations.delete(key);
      }
      for (const [envId, ship] of this.layout.ships) {
        let sprite = this.ships.get(envId);
        if (!sprite) {
          sprite = new ShipSprite(envId);
          this.ships.set(envId, sprite);
          this.shipLayer.addChild(sprite.root);
        }
        sprite.build(ship, state);
      }
      for (const [envId, sprite] of this.ships) {
        if (this.layout.ships.has(envId)) continue;
        sprite.destroy();
        this.ships.delete(envId);
      }
      this.drawGrid();
      this.drawLinks(state);
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
        const detail = state.details[key];
        sprite.update(thread, detail ? telemetry(detail.thread) : undefined, lay.color);
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

  private drawLinks(state: GameState): void {
    const g = this.links.clear();
    for (const ship of this.layout.ships.values()) {
      const live = state.envs[ship.envId]?.connection === "live";
      for (const link of ship.links) {
        const points: number[] = [];
        for (let k = 0; k <= 24; k++) {
          const p = linkPoint(link.from, link.to, k / 24);
          points.push(p.x, p.y);
        }
        g.poly(points, false).stroke({ color: ship.color, width: 5, alpha: live ? 0.1 : 0.04 });
        g.poly(points, false).stroke({ color: ship.color, width: 2, alpha: live ? 0.6 : 0.15 });
      }
    }
  }

  // ---- Frame ----

  private tick(dt: number): boolean {
    this.time += dt;
    const state = useGame.getState();
    const t = this.time;
    const frame = Math.floor(t * 5); // sprite animation rate
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
      sprite.tick(lay, s, t, dt, frame, selected, this.zoom);
    }
    this.drawLights(state, sel, t, frame);
    for (const station of this.stations.values()) station.setZoom(this.zoom);
    for (const ship of this.ships.values()) ship.setZoom(this.zoom);
    this.drawEdgeIndicators(t);
    return [...this.crew.values()].some((crew) => crew.animated)
      || Object.values(state.envs).some((env) => env.connection === "connecting" || env.connection === "reconnecting");
  }

  /** Everything that changes frame to frame: screens, system icons, engines, plates, alerts. */
  private drawLights(state: GameState, sel: Selection, t: number, frame: number): void {
    const g = this.lights.clear();
    const o = this.overlay.clear();

    // Per-station and per-ship tallies from the crew.
    const stationUse = new Map<string, Record<SystemRoom, boolean> & { attention: boolean; monitoringOnly: boolean }>();
    const shipStates = new Map<string, UnitState[]>();
    const workingAt = new Set<string>(); // envId|stationKey with crew working
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
      if (!lay.sleeping) {
        let states = shipStates.get(lay.envId);
        if (!states) shipStates.set(lay.envId, (states = []));
        states.push(sprite.state);
        if (sprite.state === "working") workingAt.add(`${lay.envId}|${lay.stationKey}`);
      }

      // Console screens show what the crew member at that console is doing.
      if (lay.console) {
        const con = this.stations.get(lay.stationKey)?.consoles.get(`${lay.console.x},${lay.console.y}`);
        if (con) {
          const live = state.envs[sprite.envId]?.connection === "live";
          con.texture = tex(A.CONSOLE, { screen: live ? screenColor(sprite.state, frame, sprite.atConsole) : SCREEN_OFF });
          // A team-colored tab on each console shows whose desk it is.
          g.rect(lay.console.x - 26, lay.console.y - 26, 4, 12).fill(sprite.team);
        }
      }
    }

    for (const s of this.layout.stations.values()) {
      const u = stationUse.get(s.key);
      const bridge = s.rooms.bridge?.rect;
      if (bridge && u?.attention) g.rect(bridge.x, bridge.y, bridge.w, bridge.h).fill({ color: STATUS.alert, alpha: 0.1 + (frame % 2) * 0.08 });
      // FTL-style system indicators in each room's corner: lit while in use.
      for (const kind of ["terminal", "files", "comms"] as const) {
        const room = s.rooms[kind];
        if (!room) continue;
        const on = !!u?.[kind];
        const color = on ? (kind === "comms" && u?.monitoringOnly ? STATUS.monitoring : 0x6fe37a) : 0x59626c;
        const x = room.rect.x + room.rect.w - 16;
        const y = room.rect.y + 8;
        g.rect(x - 6, y - 2, 12, 12).fill(0x15191d).stroke({ color, width: 2 });
        g.rect(x - 2, y + 2, 4, 4).fill({ color, alpha: on && frame % 2 ? 1 : 0.6 });
      }
    }

    // Supply lines: one per (ship, station it crews); packets flow while that crew is working.
    const l = this.packets.clear();
    for (const ship of this.layout.ships.values()) {
      const live = state.envs[ship.envId]?.connection === "live";
      for (const link of ship.links) {
        if (live && workingAt.has(`${ship.envId}|${link.stationKey}`)) {
          for (let k = 0; k < 4; k++) {
            const p = linkPoint(link.from, link.to, (t * 0.3 + k / 4) % 1);
            l.rect(Math.round(p.x) - 3, Math.round(p.y) - 3, 6, 6).fill(ship.color);
          }
        }
      }
    }

    // Ships: engine burn while their crew work, connection light, FTL power bar on the plate.
    for (const ship of this.layout.ships.values()) {
      const env = state.envs[ship.envId];
      const live = env?.connection === "live";
      const states = shipStates.get(ship.envId) ?? [];
      const h = ship.hull;
      const sprite = this.ships.get(ship.envId)?.hullSprite;
      if (sprite) sprite.alpha = live ? 1 : 0.45;
      if (states.includes("working") && live) {
        // Exhaust at the stern, in sprite pixels.
        const len = frame % 2 ? 24 : 18;
        g.rect(h.x - len, h.y + 15, len, 12).fill({ color: 0x59e1ff, alpha: 0.8 });
        g.rect(h.x - len / 2, h.y + 18, len / 2, 6).fill(0xffffff);
      }
      const p = ship.plate;
      const lightColor = live ? 0x6fe37a : env?.connection === "reconnecting" || env?.connection === "connecting" ? STATUS.question : 0x59626c;
      g.rect(p.x + p.w - 13, p.y + p.h / 2 - 4, 8, 8).fill({ color: lightColor, alpha: live || frame % 2 ? 1 : 0.4 });
      states.slice(0, 8).forEach((st, k) => g.rect(p.x + p.w - 22 - (Math.min(8, states.length) - k) * 8, p.y + 5, 6, p.h - 10).fill(STATUS[st]));
    }

    // Selected project: outline its station.
    if (sel && sel.kind === "building") {
      const s = this.stationFor(sel.envId, sel.projectId);
      if (s) o.poly(s.hull).stroke({ color: 0x6fe37a, width: 4 });
    }
  }

  /** Arrows on the screen edge pointing at off-screen crew who need you. */
  private drawEdgeIndicators(t: number): void {
    const g = this.edge.clear();
    const seen = new Set<string>();
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
      seen.add(sprite.key);
      let hit = this.edgeTargets.get(sprite.key);
      if (!hit) {
        hit = new Container();
        hit.eventMode = "static";
        hit.cursor = "pointer";
        hit.hitArea = new Rectangle(-16, -16, 32, 32);
        const { envId, threadId } = sprite;
        hit.on("pointertap", (e: FederatedPointerEvent) => {
          e.stopPropagation();
          sfx.select();
          const s = { kind: "unit" as const, envId, threadId };
          setSelection(s);
          this.focus(s);
        });
        this.edgeTargets.set(sprite.key, hit);
        this.edgeHits.addChild(hit);
      }
      hit.position.set(ex, ey);
    }
    for (const [key, hit] of this.edgeTargets) {
      if (seen.has(key)) continue;
      hit.destroy();
      this.edgeTargets.delete(key);
    }
  }
}

/** The live map, for hotkeys and panels that need to move the camera. */
export const worldRef: { current: World | null } = { current: null };
