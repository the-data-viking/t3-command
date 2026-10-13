// The fleet map, rendered with PixiJS from the hand-authored pixel-art kit (src/art). A view of
// the game store: it reads state, and clicks become store selections. Flight Deck switches
// between warm plating and Night Shift; everything re-textures from the same sprites.
//
// FTL-style: every project is a station seen in cross-section, and everyone working on it, from
// any environment, works side by side in its commons. Each participating environment has a
// separate compute/engine node directly attached to the project; crew wear its team color. Crew walk room
// to room through doors to use the system their open tool call needs.
//
// Rule borrowed from StarNet: the map never shows activity T3 can't prove. Screens and system
// icons light up only for real work, crew walk only for real tool calls, and supply lines carry
// packets only while crew are working. Engineering gauges show measured whole-host load.

import { Application, Container, Graphics, Rectangle, Sprite, TilingSprite, type FederatedPointerEvent } from "pixi.js";
import { PixelText } from "./pixel-text";
import { cells, fitText, STATUS_GLYPHS } from "../art/pixelfont";
import * as A from "../art/sprites";
import { ENGINEERING_SPOTS, FLIGHT_KIT } from "../art/flightdeck";
import type { Arms, Legs } from "../art/render";
import { openHost, setSelection, unitKey, useGame, type GameState, type Selection } from "../store";
import { isHistory, unitState, type UnitState } from "../t3/derive";
import { telemetry, type Telemetry } from "../t3/telemetry";
import type { OrchestrationThread, ThreadShell } from "../t3/types";
import { computeFleetLayout, fingerprint, nodeDrawKey, QUARTERS_SHOWN, stationDrawKey, TILE, type CrewLayout, type FleetLayout, type Point, type Rect, type RoomKind, type EnvironmentNodeLayout, type StationLayout, type SystemRoom } from "./layout";
import { sfx } from "./sfx";
import { endGesture, gesturing, holdTaps } from "./gesture";
import { isPhone } from "../ui/phone";
import { CrewMotion, doorState } from "./crew-motion";
import { RenderLoop } from "./render-loop";
import { ControlCenterSprite } from "./control-center";
import { HERMES_COLOR } from "../t3/bots";
import { hostView, type HostState } from "../t3/host";
import { quietness } from "../t3/progress";
import { freeLabel, storageSummary } from "../t3/storage";
import type { StorageView } from "../../shared/storage";
import { crewTex, currentStyle, PX, tex } from "./textures";
import { contextLevel, GAUGE, HUD, hudMaterials, modelTier, PROVIDER_VISOR, providerSilhouette, STATUS, type Silhouette, type Tier } from "./theme";


/** Map labels share the sprites' pixel world. */
function label(size: number, fill: number): PixelText {
  return new PixelText(size, fill);
}

/**
 * Size a label for the zoom: world-scaled when that's at least one screen pixel per font pixel,
 * otherwise held at exactly one (crisp, not sub-pixel mush), shortened to fit `width` world px.
 */
function fitLabel(label: PixelText, full: string, width: number, zoom: number): void {
  const screen = label.unit * zoom;
  label.scale.set(screen < 1 ? 1 / screen : 1);
  label.text = fitText(full, width * zoom, Math.max(1, screen));
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
function linkPoint(from: Point, to: Point, k: number, via?: Point[]): Point {
  const midX = (from.x + to.x) / 2;
  const points = [from, ...(via ?? [{ x: midX, y: from.y }, { x: midX, y: to.y }]), to];
  const progress = k * (points.length - 1);
  const i = Math.min(points.length - 2, Math.floor(progress));
  const a = points[i], b = points[i + 1], t = progress - i;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
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
/** Side-by-side spacing for crew sharing one system room. */
const CREW_SPACING = 34;
/** Recruitment beam-in and camera moves; both are skipped under prefers-reduced-motion. */
const BEAM_SECONDS = 0.9;
const CAMERA_SECONDS = 0.35;
/** Rooms nobody is using sit in this much shadow; crew and lit rooms stay bright. */
const ROOM_SHADOW = 0.32;
/** A crew member this new appearing on an already-loaded station was just recruited. */
const RECRUIT_WINDOW_MS = 120_000;

const clampZoom = (z: number) => Math.min(3, Math.max(0.12, z));

const DOOR_ART = { closed: A.DOOR_H, half: A.DOOR_H_HALF, open: A.DOOR_H_OPEN };

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
const SCREEN_OFF = 0x1c2228;

/** Console screen color for a crew member's state; blinks and flicker alternate per frame. */
function screenColor(state: UnitState, frame: number, atConsole: boolean): number {
  switch (state) {
    case "working":
      return atConsole ? (frame % 2 ? STATUS.working : 0x9ff0ff) : 0x2a6f80;
    case "monitoring":
      return 0x7a5fb8;
    case "alert":
      return frame % 2 ? STATUS.alert : 0x7a1820;
    case "question":
      return frame % 2 ? STATUS.question : 0x7a6418;
    case "done":
      return STATUS.done;
    case "error":
      return STATUS.error;
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
  private nameText = label(7, HUD.text);
  private motion: CrewMotion;
  private hasTelemetry = false;
  get pos(): Point { return this.motion.pos; }
  get room(): RoomKind { return this.motion.room; }
  state: UnitState = "idle";
  thread!: ThreadShell;
  info?: Telemetry;
  /** Followed thread detail, for spotting a turn that has gone quiet. */
  private detail?: OrchestrationThread;
  private quiet = false;
  private quietCheckedAt = 0;
  tier: Tier = "standard";
  silhouette: Silhouette = "round";
  team = 0xffffff;
  hovered = false;
  /** At their own console (vs. walking, at a system room, or in quarters). */
  atConsole = true;
  /** At the system room their current work needs. */
  atStation = false;
  /** Seconds left of a recruitment beam-in. */
  private arriving = 0;

  /** Sleepers' decorative drift doesn't keep an otherwise idle fleet rendering. */
  get animated(): boolean {
    if (reducedMotion()) return this.motion.moving;
    return this.motion.moving || this.arriving > 0 || this.state === "working" || this.state === "monitoring"
      || this.state === "alert" || this.state === "question" || !!this.info?.tasks;
  }

  get moving(): boolean { return this.motion.moving; }

  /** A newly recruited crew member materializes at their seat. */
  beamIn(): void {
    if (!reducedMotion()) this.arriving = BEAM_SECONDS;
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
      if (gesturing()) return;
      sfx.select();
      setSelection({ kind: "unit", envId: this.envId, threadId: this.threadId });
    });
  }

  update(thread: ThreadShell, info: Telemetry | undefined, team: number, detail?: OrchestrationThread): void {
    this.thread = thread;
    if (detail !== this.detail) { this.detail = detail; this.quietCheckedAt = 0; }
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
  /** The system room this crew member's current work takes them to, if any. */
  systemRoom(layout: CrewLayout, s: StationLayout): SystemRoom | undefined {
    if (layout.sleeping) return undefined;
    let system: SystemRoom | undefined;
    if (this.state === "working" && this.info && this.info.workstation !== "console") system = this.info.workstation;
    if (this.state === "monitoring") system = "comms";
    return system && s.rooms[system] ? system : undefined;
  }

  /** Position among crew sharing the same system room, set by the world each frame. */
  slot = { index: 0, count: 1 };

  private desired(layout: CrewLayout, s: StationLayout): { room: RoomKind; point: Point } {
    if (layout.sleeping) return { room: "quarters", point: layout.home };
    const system = this.systemRoom(layout, s);
    if (system) {
      const spot = s.workstations[system];
      const r = s.rooms[system]!.rect;
      // Crew sharing a room stand side by side at the workstation instead of on one spot.
      const spacing = Math.min(CREW_SPACING, (r.w - 24) / Math.max(1, this.slot.count));
      const x = spot.x + (this.slot.index - (this.slot.count - 1) / 2) * spacing;
      return { room: system, point: { x: Math.round(Math.max(r.x + 12, Math.min(r.x + r.w - 12, x))), y: spot.y } };
    }
    return { room: "bridge", point: layout.home };
  }

  /** World-space box of the name label, when shown. */
  labelBox(): Rect | undefined {
    if (!this.nameText.visible) return undefined;
    const k = this.scale.x;
    const w = this.nameText.naturalWidth * k;
    return { x: this.position.x - w / 2, y: this.position.y + 6 * k, w, h: 9 * k };
  }

  /** Push the name label down by `dy` world px to clear a neighbor's. */
  setLabelOffset(dy: number): void {
    this.nameText.y = 6 + dy / this.scale.x;
  }

  tick(layout: CrewLayout, s: StationLayout, t: number, dt: number, frame: number, selected: boolean, zoom: number): void {
    const want = this.desired(layout, s);
    // Under reduced motion crew are placed at their destination instead of walking there.
    this.motion.step(layout, s, want, dt, reducedMotion() ? Infinity : WALK_SPEED);
    const moving = this.motion.moving;
    // Lie down only once the walk to quarters is over.
    const resting = layout.sleeping && this.motion.arrived;
    this.atConsole = !moving && !layout.sleeping && this.room === "bridge";
    this.atStation = !moving && this.room !== "bridge" && this.room !== "quarters";
    // Snap to whole sprite pixels so the art stays crisp.
    this.position.set(Math.round(this.pos.x / PX) * PX, Math.round(this.pos.y / PX) * PX);
    this.zIndex = this.pos.y;

    const boost = zoom < STRATEGIC_ZOOM ? Math.min(2, STRATEGIC_ZOOM / zoom) : 1;
    this.scale.set(boost);

    const visor = PROVIDER_VISOR[this.thread.modelSelection.instanceId] ?? 0x9fb3d1;
    if (resting) {
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

    this.arriving = Math.max(0, this.arriving - dt);
    this.figure.alpha = this.arriving ? 1 - this.arriving / BEAM_SECONDS : 1;
    this.drawFx(t, selected, zoom, resting);
    this.drawRing(selected, t, resting);
    this.nameText.visible = !resting && (selected || this.hovered || zoom > 1.7);
  }

  private drawFx(t: number, selected: boolean, zoom: number, sleeping: boolean): void {
    const f = this.fx.clear();
    if (this.arriving) {
      // Teleporter column in the crew member's team color, fading as they solidify.
      const fade = this.arriving / BEAM_SECONDS;
      f.rect(-12, -56, 24, 58).fill({ color: this.team, alpha: 0.18 * fade });
      for (const x of [-10, -4, 2, 8]) {
        const y = -56 + ((t * 90 + x * 7 + this.seed * 50) % 52);
        f.rect(x, Math.round(y), 2, 4).fill({ color: 0xffffff, alpha: 0.8 * fade });
      }
      f.rect(-14, -2, 28, 4).fill({ color: this.team, alpha: 0.6 * fade });
    }
    if (sleeping) {
      const drift = (t * 0.5 + this.seed) % 1;
      f.rect(Math.round(10 + drift * 8), Math.round(-12 - drift * 14), 4, 2).fill({ color: 0xffffff, alpha: 1 - drift });
      return;
    }
    if (this.state === "working") {
      // Re-checked every few seconds rather than per frame: it scans the turn's activity.
      const now = Date.now();
      if (this.detail && now - this.quietCheckedAt > 5000) {
        this.quietCheckedAt = now;
        this.quiet = quietness(this.thread, this.detail, now)?.kind === "quiet";
      }
      if (this.quiet) {
        // Quiet turn: three steady amber dots where the busy pip spins.
        for (const x of [8, 12, 16]) f.rect(x, -40, 3, 3).fill(GAUGE.high);
      } else {
        // Spinning pip: busy, no attention needed.
        const a = Math.floor(t * 8) % 4;
        const pts = [[0, -6], [6, 0], [0, 6], [-6, 0]];
        pts.forEach(([x, y], i) => f.rect(12 + x / 2, -40 + y / 2, 3, 3).fill({ color: i === a ? STATUS.working : 0x1d4a57 }));
      }
      // Plan pips over the head: done, current (blinking), still to do.
      const plan = this.thread.planProgress;
      if (plan && plan.totalSteps > 0) {
        const n = Math.min(plan.totalSteps, 10);
        const done = Math.round((plan.completedSteps / plan.totalSteps) * n);
        const x0 = -Math.round((n * 4 - 1) / 2);
        for (let i = 0; i < n; i++) {
          const color = i < done ? STATUS.done : i === done ? (Math.floor(t * 2) % 2 ? STATUS.working : 0x1d4a57) : hudMaterials(useGame.getState().artStyle).meter;
          f.rect(x0 + i * 4, -50, 3, 2).fill(color);
        }
      }
    }
    const tasks = Math.min(4, this.info?.tasks ?? 0);
    for (let i = 0; i < tasks; i++) {
      const a = t * 2.2 + (i / tasks) * Math.PI * 2;
      f.rect(Math.round(Math.cos(a) * 18) - 2, Math.round(-22 + Math.sin(a) * 7) - 2, 4, 4).fill(STATUS.working).stroke({ color: 0x101418, width: 1 });
    }
    const ctx = this.info?.context;
    if (ctx !== undefined && (selected || this.hovered || zoom > 1.3)) {
      const left = 1 - ctx;
      const color = GAUGE[contextLevel(ctx)];
      for (let i = 0; i < 8; i++) f.rect(-16 + i * 4, 4, 3, 4).fill(i / 8 < left ? color : hudMaterials(useGame.getState().artStyle).meter);
    }
  }

  private drawRing(selected: boolean, t: number, sleeping: boolean): void {
    const r = this.ring.clear();
    if (sleeping) {
      if (selected) r.rect(-26, -10, 52, 20).stroke({ color: STATUS.done, width: 2 });
      return;
    }
    if (selected) {
      r.ellipse(0, 0, 16, 6).stroke({ color: STATUS.done, width: 2 });
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
  private title?: PixelText;
  private sub?: PixelText;
  private titleText = "";
  private subText = "";
  private fitWidth = 0;
  private drawn?: string;
  /** Console sprites by "x,y" of their layout point, so screens can be updated live. */
  readonly consoles = new Map<string, Sprite>();
  /** Door sprites at their layout points, opened by approaching crew. */
  doors: Array<{ sprite: Sprite; x: number; y: number; open: A.Grid }> = [];

  constructor(key: string) {
    this.key = key;
  }

  /** Rebuild only if the layout, nameplate or art style changed. */
  sync(s: StationLayout, state: GameState): void {
    const drawn = stationDrawKey(state, s);
    if (drawn === this.drawn) return;
    this.drawn = drawn;
    this.build(s, state);
  }

  build(s: StationLayout, state: GameState): void {
    for (const child of this.root.removeChildren()) child.destroy({ children: true });
    this.consoles.clear();
    this.doors = [];
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
    // Antenna mast and the side port to the operations network.
    g.rect(i.x + i.w - 42, hullTop - 28, 4, 28).fill(c.k);
    g.rect(i.x + i.w - 44, hullTop - 32, 8, 6).fill(c.a);
    g.rect(s.port.x - 5, s.port.y - 18, 10, 36).fill(c.D).stroke({ color: c.k, width: 2 });

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
      this.doors.push({ sprite: door, x: d.x, y: d.y, open: A.DOOR_H });
    }

    // Own the hit area on the rendered facility, rather than an empty child container.
    const first = s.members[0];
    this.root.eventMode = 'static';
    this.root.cursor = 'pointer';
    this.root.hitArea = new Rectangle(s.bounds.x, s.bounds.y, s.bounds.w, s.bounds.h);
    this.root.removeAllListeners('pointertap');
    this.root.on('pointertap', (e: FederatedPointerEvent) => {
      e.stopPropagation();
      if (gesturing()) return;
      if (e.pointerType === 'touch' && worldRef.current?.tapNearbyCrew(e.global.x, e.global.y)) return;
      sfx.building();
      const point = e.getLocalPosition(this.root);
      if (point.y < i.y) worldRef.current?.focusRect(s.bounds);
      else if (first && ar && point.x >= ar.x && point.x <= ar.x + ar.w && point.y >= ar.y && point.y <= ar.y + ar.h)
        setSelection({ kind: 'library', envId: first.envId, projectId: first.projectId });
      else if (first) setSelection({ kind: 'building', envId: first.envId, projectId: first.projectId });
    });

    // Nameplate: the title grows upward from its baseline, away from the hull.
    const machines = new Set(s.members.map((m) => m.envId)).size;
    const title = new PixelText(18, 0xf2f4f6);
    title.text = s.name.toUpperCase();
    title.anchor.set(0, 1);
    title.position.set(s.nameplate.x, s.nameplate.y + 16);
    const sub = new PixelText(10, 0x9aa7bd);
    sub.text = [machines > 1 ? `SHARED · ${machines} MACHINES` : state.envs[first?.envId ?? ""]?.summary.label.toUpperCase(), s.settledHidden ? `+${s.settledHidden} SETTLED` : ""]
      .filter(Boolean)
      .join(" · ");
    sub.position.set(s.nameplate.x + 2, s.nameplate.y + 22);
    this.root.addChild(title, sub);
    this.title = title;
    this.sub = sub;
    this.titleText = title.text;
    this.subText = sub.text;
    this.fitWidth = s.bounds.w;
  }

  /**
   * Zoomed out, labels hold exactly one screen pixel per font pixel so they stay crisp, and are
   * shortened with "…" to fit their facility rather than running into neighbors. Subtitles drop
   * out far away.
   */
  setZoom(zoom: number): void {
    if (this.title) fitLabel(this.title, this.titleText, this.fitWidth, zoom);
    if (this.sub) {
      this.sub.visible = zoom >= 0.45;
      if (this.sub.visible) fitLabel(this.sub, this.subText, this.fitWidth, zoom);
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}

// ---- Environment service nodes -----------------------------------------------------------------------------

/** Separate compute/engine node directly attached to a project module. */
class EnvironmentNodeSprite {
  readonly envId: string;
  readonly root = new Container();
  private name?: PixelText;
  /** Measured host load: rack LEDs (CPU) and the coolant level (RAM). Redrawn per sample. */
  private meters?: Graphics;
  /** Observed crew activity in the core cells, and the bay's light. Redrawn every frame. */
  private cells?: Graphics;
  /** "+N" on the bay wall for scratch crew beyond its standing room. */
  private overflowText?: PixelText;
  private cpuText?: PixelText;
  private memoryText?: PixelText;
  private caption?: PixelText;
  /** Fullest disk holding this machine's checkouts, on the status plate after any caption. */
  private diskText?: PixelText;
  private storage?: StorageView;
  /** Crew glyphs fill the plate from the right; past five, the disk readout drops free space. */
  private crowded = false;
  private hull?: Rect;
  private drawn?: string;

  constructor(envId: string) {
    this.envId = envId;
  }

  /** Rebuild only if the chassis layout, name or art style changed; lights update separately. */
  sync(node: EnvironmentNodeLayout, state: GameState): void {
    const drawn = nodeDrawKey(state, node);
    if (drawn === this.drawn) return;
    this.drawn = drawn;
    this.build(node, state);
  }

  build(node: EnvironmentNodeLayout, state: GameState): void {
    for (const child of this.root.removeChildren()) child.destroy({ children: true });
    const h = node.hull, c = currentStyle().colors;
    this.hull = h;
    // Docking hatch above the deck, where bridge collars and conduits attach.
    const hatch = new Graphics().rect(h.x+h.w/2-18,h.y-4,36,8).fill(c.D).stroke({color:c.k,width:2});
    this.root.addChild(hatch, sprite(tex(FLIGHT_KIT.ENGINEERING_DECK, { team: node.color }), h.x, h.y));
    this.meters = new Graphics();
    this.cells = new Graphics();
    this.name=label(10,node.color);
    this.name.text=truncate((state.envs[node.envId]?.summary.label??'?').toUpperCase(),24);
    this.name.position.set(h.x+14,h.y+12);
    const at = (spot: { x: number; y: number }) => ({ x: h.x + spot.x * PX, y: h.y + spot.y * PX });
    this.cpuText = label(9, GAUGE.unknown); this.cpuText.position.copyFrom(at(ENGINEERING_SPOTS.cpuLabel));
    this.memoryText = label(9, GAUGE.unknown); this.memoryText.position.copyFrom(at(ENGINEERING_SPOTS.memoryLabel));
    const plate = at(ENGINEERING_SPOTS.plate);
    this.caption = label(7,0xa7bdcb); this.caption.position.set(plate.x + 8, plate.y + 6);
    this.diskText = label(7, GAUGE.unknown); this.diskText.position.set(plate.x + 8, plate.y + 6);
    const hidden = node.scratch?.overflow.length ?? 0;
    this.overflowText = label(7, HUD.text);
    this.overflowText.text = hidden ? `+${hidden}` : "";
    this.overflowText.position.copyFrom(at(ENGINEERING_SPOTS.bayCount));
    this.root.addChild(this.meters, this.cells, this.name, this.cpuText, this.memoryText, this.caption, this.diskText, this.overflowText);
    this.updateResources(node, state.hosts[node.envId], state.envs[node.envId]?.connection ?? "offline");
    this.updateStorage(state.storage[node.envId]);
    this.root.eventMode = 'static';
    this.root.cursor = 'pointer';
    this.root.hitArea = new Rectangle(h.x, h.y, h.w, h.h);
    this.root.removeAllListeners('pointertap');
    this.root.on('pointertap', (e: FederatedPointerEvent) => {
      e.stopPropagation();
      if (gesturing()) return;
      sfx.building();
      openHost(node.envId);
      worldRef.current?.focusEngineering(node.envId);
    });
  }

  /** Rack LEDs fill with measured CPU load and the coolant column with RAM used. */
  updateResources(node: EnvironmentNodeLayout, state: HostState | undefined, connection: string): void {
    const view = hostView(state, connection);
    const h = node.hull;
    this.cpuText!.text = view.cpuFraction === undefined ? "CPU —" : `CPU ${Math.round(view.cpuFraction * 100)}%`;
    this.memoryText!.text = view.memoryFraction === undefined ? "RAM —" : `RAM ${Math.round(view.memoryFraction * 100)}%`;
    this.cpuText!.fill = view.stale ? HUD.muted : view.cpuColor;
    this.memoryText!.fill = view.stale ? HUD.muted : view.memoryColor;
    // Only speak up when the readings can't be trusted.
    this.caption!.text = view.stale ? "STALE SAMPLE" : view.snapshot ? "" : "NO HOST METRICS";
    const alpha = view.stale ? 0.35 : 1;
    const g = this.meters!.clear();
    const rect = (s: { x: number; y: number; w: number; h: number }) => g.rect(h.x + s.x * PX, h.y + s.y * PX, s.w * PX, s.h * PX);
    const leds = ENGINEERING_SPOTS.leds;
    if (view.cpuFraction !== undefined) {
      leds.forEach((led, k) => { if (view.cpuFraction! * leds.length > k + 0.5) rect(led).fill({ color: view.cpuColor, alpha }); });
    }
    if (view.memoryFraction !== undefined) {
      const glass = ENGINEERING_SPOTS.coolant;
      const level = Math.round(view.memoryFraction * glass.h);
      if (level > 0) {
        rect({ ...glass, y: glass.y + glass.h - level, h: level }).fill({ color: view.memoryColor, alpha });
        rect({ ...glass, y: glass.y + glass.h - level, h: 1 }).fill({ color: 0xffffff, alpha: 0.35 * alpha });
      }
    }
  }

  /** Disk use of the fullest checkout volume; free space too when the plate has room. */
  updateStorage(view: StorageView | undefined): void {
    this.storage = view;
    const disk = storageSummary(view);
    const caption = this.caption!.text;
    const short = !!caption || this.crowded;
    this.diskText!.text = disk.usedFraction === undefined ? (view?.latest?.error ? "DISK —" : "")
      : `DISK ${Math.round(disk.usedFraction * 100)}%${short ? "" : ` · ${freeLabel(disk.volume!.availableBytes)} FREE`}`;
    this.diskText!.fill = disk.color;
    this.diskText!.x = this.caption!.x + (caption ? this.caption!.width + 8 : 0);
  }

  /**
   * Core cells: one per working crew member (pulsing), then monitoring crew (steady). The bay sits
   * in shadow until scratch crew are aboard; its wall terminal glows while one of them works.
   */
  setActivity(states: UnitState[], live: boolean, frame: number, bay: UnitState[]): void {
    const crowded = states.length > 5;
    if (crowded !== this.crowded) { this.crowded = crowded; this.updateStorage(this.storage); }
    const g = this.cells?.clear();
    if (!g || !this.hull) return;
    const h = this.hull;
    const box = (s: { x: number; y: number; w: number; h: number }) => g.rect(h.x + s.x * PX, h.y + s.y * PX, s.w * PX, s.h * PX);
    if (!live || !bay.length) box(ENGINEERING_SPOTS.bay).fill({ color: 0x000000, alpha: ROOM_SHADOW });
    if (!live) return;
    const screen = bay.includes("working") ? STATUS.working : bay.includes("monitoring") ? STATUS.monitoring : undefined;
    if (screen !== undefined) box(ENGINEERING_SPOTS.bayScreen).fill({ color: screen, alpha: screen === STATUS.working && frame % 2 ? 0.55 : 0.9 });
    const working = states.filter((s) => s === "working").length;
    const monitoring = states.filter((s) => s === "monitoring").length;
    ENGINEERING_SPOTS.cells.forEach((cell, i) => {
      const color = i < working ? STATUS.working : i < working + monitoring ? STATUS.monitoring : undefined;
      if (color === undefined) return;
      const alpha = i < working ? ((frame + i) % 2 ? 1 : 0.55) : 0.7;
      g.rect(this.hull!.x + cell.x * PX, this.hull!.y + cell.y * PX, cell.w * PX, cell.h * PX).fill({ color, alpha });
    });
  }

  /** Deck text can't grow past its sprite, so it hides once it would turn sub-pixel. */
  setZoom(zoom: number): void {
    const legible = zoom >= 0.8;
    for (const text of [this.name, this.cpuText, this.memoryText, this.caption, this.diskText, this.overflowText]) if (text) text.visible = legible;
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}

// ---- World -----------------------------------------------------------------------------

export interface MinimapData {
  bounds: Rect;
  hubs: Rect[];
  controlCenter?: Rect;
  stations: Array<{ rect: Rect; color: number; live: boolean }>;
  dots: Array<{ x: number; y: number; state: UnitState; color: number; big: boolean }>;
  view: Rect;
}

/** The world point at the center of the screen, and the zoom around it. */
interface CameraView { cx: number; cy: number; zoom: number }

export class World {
  private app = new Application();
  private sky?: TilingSprite;
  private camera = new Container();
  private grid = new Graphics();
  private operations = new Container();
  private links = new Graphics();
  private packets = new Graphics();
  private stationLayer = new Container();
  private environmentLayer = new Container();
  private lights = new Graphics();
  private crewLayer = new Container();
  private overlay = new Graphics();
  private edge = new Graphics();
  private edgeHits = new Container();
  private stations = new Map<string, StationSprite>();
  private environmentNodes = new Map<string, EnvironmentNodeSprite>();
  private controlCenter?: ControlCenterSprite;
  private lastCatalog?: GameState["hermesCatalog"];
  private crew = new Map<string, CrewSprite>();
  private layout: FleetLayout = { stations: new Map(), bays: new Map(), environmentNodes: new Map(), crew: new Map(), bounds: { x: 0, y: 0, w: 0, h: 0 } };
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
  private lastHosts?: GameState["hosts"];
  private lastStorage?: GameState["storage"];
  private lastStyle?: GameState["artStyle"];
  private drawnCenter?: string;
  private drawnGrid?: string;
  private drawnLinks?: string;
  private fittedBounds?: string;
  /** Eased camera move in progress, as the world point at screen center plus zoom. */
  private tween?: { from: CameraView; to: CameraView; elapsed: number };
  /** The first fit after loading snaps; later moves ease. */
  private framed = false;
  /** Environments whose crew were already aboard; crew new to them after that beam in. */
  private seeded = new Set<string>();
  /** A door is still open, so keep rendering until it closes. */
  private doorsOpen = false;

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
    this.camera.addChild(this.grid, this.operations, this.links, this.packets, this.stationLayer, this.environmentLayer, this.lights, this.crewLayer, this.overlay);
    this.app.stage.addChild(this.sky, this.camera, this.edge, this.edgeHits);
    this.setupCamera();

    this.renderLoop = new RenderLoop((dt) => {
      this.sync(useGame.getState());
      const animated = this.tick(dt);
      this.app.render();
      return animated;
    });
    this.unsubscribe = useGame.subscribe((s, prev) => {
      if (s.envs !== prev.envs || s.details !== prev.details || s.hosts !== prev.hosts || s.selection !== prev.selection || s.hermesCatalog !== prev.hermesCatalog || s.artStyle !== prev.artStyle) this.invalidate();
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
    // Two fingers down: pinch to zoom about their midpoint, and pan as the midpoint moves.
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: { distance: number; x: number; y: number } | null = null;
    const pinchState = () => {
      const [a, b] = [...touches.values()];
      return { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };
    const lift = (e: FederatedPointerEvent) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
      // Lifting the fingers after a pinch isn't a tap on whatever is under them.
      if (touches.size === 0) endGesture();
    };
    stage.on("pointerdown", (e: FederatedPointerEvent) => {
      this.tween = undefined;
      if (e.pointerType === "touch") touches.set(e.pointerId, { x: e.global.x, y: e.global.y });
      if (touches.size === 2) {
        pinch = pinchState();
        holdTaps(Infinity);
        drag = null;
        return;
      }
      drag = { x: e.global.x, y: e.global.y, camX: this.camera.x, camY: this.camera.y, moved: false };
    });
    stage.on("globalpointermove", (e: FederatedPointerEvent) => {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.global.x, y: e.global.y });
      if (pinch && touches.size === 2) {
        const next = pinchState();
        this.userMoved = true;
        this.camera.position.set(this.camera.x + next.x - pinch.x, this.camera.y + next.y - pinch.y);
        this.zoomAt(next.x, next.y, next.distance / pinch.distance);
        pinch = next;
        return;
      }
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
      if (drag && !drag.moved && e.target === stage && !gesturing() && !(e.pointerType === "touch" && this.tapNearbyCrew(e.global.x, e.global.y))) setSelection(null);
      // A pan that ends over a crew member or module isn't a tap on it (taps fire after this).
      if (drag?.moved) holdTaps(50);
      drag = null;
      lift(e);
    });
    stage.on("pointerupoutside", (e: FederatedPointerEvent) => {
      drag = null;
      lift(e);
    });
    this.app.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.userMoved = true;
        this.tween = undefined;
        const rect = this.app.canvas.getBoundingClientRect();
        this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );
  }

  private setZoom(z: number): void {
    this.zoom = clampZoom(z);
    this.camera.scale.set(this.zoom);
  }

  private view(): CameraView {
    const { width, height } = this.app.screen;
    return { cx: (width / 2 - this.camera.x) / this.zoom, cy: (height / 2 - this.camera.y) / this.zoom, zoom: this.zoom };
  }

  private applyView(v: CameraView): void {
    const { width, height } = this.app.screen;
    this.setZoom(v.zoom);
    this.camera.position.set(width / 2 - v.cx * this.zoom, height / 2 - v.cy * this.zoom);
  }

  /** Put the camera at (x, y) and `zoom`, easing there unless motion is reduced. */
  private moveCamera(x: number, y: number, zoom: number, animate = true): void {
    const { width, height } = this.app.screen;
    const z = clampZoom(zoom);
    const to = { cx: (width / 2 - x) / z, cy: (height / 2 - y) / z, zoom: z };
    if (!animate || reducedMotion()) { this.tween = undefined; this.applyView(to); }
    else this.tween = { from: this.view(), to, elapsed: 0 };
    this.invalidate();
  }

  /** Advance an eased camera move; returns whether one is still running. */
  private stepCamera(dt: number): boolean {
    if (!this.tween) return false;
    const tw = this.tween;
    tw.elapsed += dt;
    const k = Math.min(1, tw.elapsed / CAMERA_SECONDS);
    const e = 1 - (1 - k) ** 3;
    // Zoom eases geometrically so zooming in and out feel the same speed.
    this.applyView({ cx: tw.from.cx + (tw.to.cx - tw.from.cx) * e, cy: tw.from.cy + (tw.to.cy - tw.from.cy) * e,
      zoom: tw.from.zoom * (tw.to.zoom / tw.from.zoom) ** e });
    if (k >= 1) this.tween = undefined;
    return !!this.tween;
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
    // Phones open panels full screen, so only the top bar and the crew dock cover the map.
    const phone = isPhone();
    if (phone) rightInset = leftInset = 0;
    const usableW = width - rightInset - leftInset;
    const topInset = phone ? 60 : 64;
    const usableH = height - topInset - (phone ? 56 : 0);
    const margin = phone ? 40 : 120;
    const z = clampZoom(Math.min(maxZoom, Math.min(usableW / (rect.w + margin), usableH / (rect.h + margin))));
    this.moveCamera(leftInset + usableW / 2 - (rect.x + rect.w / 2) * z, topInset + usableH / 2 - (rect.y + rect.h / 2) * z, z, this.framed);
    this.framed = true;
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

  private focusControlCenter(): void {
    const center = this.layout.controlCenter;
    if (!center || !this.initialized) return;
    this.userMoved = true;
    const width = this.app.screen.width;
    this.frame(center.bounds, 1.4, width >= 1000 ? 526 : 0, width >= 1000 ? Math.min(260, width * 0.2) : 0);
  }

  /** Frame all service nodes and project modules belonging to an environment. */
  focusStation(envId: string): void {
    if (this.layout.controlCenter?.envIds.includes(envId)) { this.focusControlCenter(); return; }
    const nodes = [...this.layout.environmentNodes.values()].filter(node => node.envId === envId);
    if (!nodes.length) return;
    let rect: Rect = { ...nodes[0].hull };
    const include=(r:Rect)=>{const x=Math.min(rect.x,r.x),y=Math.min(rect.y,r.y);
      rect={x,y,w:Math.max(rect.x+rect.w,r.x+r.w)-x,h:Math.max(rect.y+rect.h,r.y+r.h)-y};};
    for(const node of nodes){
      include(node.hull);
      for(const link of node.links){const project=this.layout.stations.get(link.stationKey);if(project)include(project.bounds);}
    }

    this.focusRect(rect);
  }

  /** Zoom in on the host gauges, leaving room for the resource panel. */
  focusEngineering(envId: string): void {
    const node = [...this.layout.environmentNodes.values()].find((n) => n.envId === envId);
    if (node) this.focusRect(node.hull);
  }

  /**
   * Crew are small at fleet zoom; a finger that lands just beside one (on the module or empty
   * space) selects the closest within 24 screen pixels. Returns whether one was selected.
   */
  tapNearbyCrew(x: number, y: number): boolean {
    let best: CrewSprite | undefined;
    let bestDistance = 24;
    for (const sprite of this.crew.values()) {
      if (!sprite.visible) continue;
      const center = sprite.toGlobal({ x: 0, y: -20 });
      const distance = Math.hypot(center.x - x, center.y - y);
      if (distance < bestDistance) { best = sprite; bestDistance = distance; }
    }
    if (!best) return false;
    sfx.select();
    setSelection({ kind: "unit", envId: best.envId, threadId: best.threadId });
    return true;
  }

  /** Where a crew member is aboard: a project station or an engineering bay. */
  private crewStation(lay: CrewLayout): StationLayout | undefined {
    return this.layout.stations.get(lay.stationKey) ?? this.layout.bays.get(lay.stationKey);
  }

  /** The station holding a given environment's project. */
  stationFor(envId: string, projectId: string): StationLayout | undefined {
    for (const s of this.layout.stations.values()) if (s.members.some((m) => m.envId === envId && m.projectId === projectId)) return s;
    return undefined;
  }

  /** Center on a world point; minimap drags follow the pointer directly, clicks ease. */
  centerOn(x: number, y: number, animate = true): void {
    if (!this.initialized) return;
    this.userMoved = true;
    const { width, height } = this.app.screen;
    this.moveCamera(width / 2 - x * this.zoom, height / 2 - y * this.zoom, this.zoom, animate);
  }

  /** Center the camera on a unit, station or archive, leaving room for the side panel. */
  focus(selection: Selection): void {
    if (!selection || !this.initialized) return;
    let p: Point | undefined;
    const center = this.layout.controlCenter;
    if (selection.kind === "hermes") {
      if (center) this.focusControlCenter();
      return;
    }
    if (selection.kind === "unit") {
      p = this.crew.get(unitKey(selection.envId, selection.threadId))?.pos;
      const workstation = center?.operators.find(o => o.bot.sessions.some(s => s.envId === selection.envId && s.thread.id === selection.threadId))?.workstation;
      if (workstation) { this.focusControlCenter(); return; }
    } else {
      const s = this.stationFor(selection.envId, selection.projectId);
      const r = selection.kind === "library" ? s?.rooms.archive?.rect : s?.interior;
      if (r) p = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    }
    if (!p) return;
    this.userMoved = true;
    const { width, height } = this.app.screen;
    const z = clampZoom(Math.max(this.zoom, 2));
    this.moveCamera(width * 0.4 - p.x * z, height / 2 + 20 - p.y * z, z);
  }

  minimap(): MinimapData | undefined {
    if (!this.initialized) return undefined;
    const { width, height } = this.app.screen;
    const view = { x: -this.camera.x / this.zoom, y: -this.camera.y / this.zoom, w: width / this.zoom, h: height / this.zoom };
    const state = useGame.getState();
    return {
      bounds: this.layout.bounds,
      controlCenter: this.layout.controlCenter?.hull,
      hubs: [...this.layout.stations.values()].map((s) => s.interior),
      stations: [...this.layout.environmentNodes.values()].map((sh) => ({ rect: sh.hull, color: sh.color, live: state.envs[sh.envId]?.connection === "live" })),
      dots: [...this.crew.values()]
        .filter((c) => c.state !== "sleeping")
        .map((c) => ({ x: c.pos.x, y: c.pos.y, state: c.state, color: STATUS[c.state], big: c.state === "alert" || c.state === "question" })),
      view,
    };
  }

  // ---- Sync with the store ----

  private sync(state: GameState): void {
    if (state.hosts !== this.lastHosts || state.envs !== this.lastEnvs || state.storage !== this.lastStorage) {
      this.lastHosts = state.hosts;
      this.lastStorage = state.storage;
      for (const [key, sprite] of this.environmentNodes) {
        const node = this.layout.environmentNodes.get(key);
        if (!node) continue;
        sprite.updateResources(node, state.hosts[node.envId], state.envs[node.envId]?.connection ?? "offline");
        sprite.updateStorage(state.storage[node.envId]);
      }
    }
    const styleChanged = state.artStyle !== this.lastStyle;
    if (state.envs === this.lastEnvs && state.hermesCatalog === this.lastCatalog && state.details === this.lastDetails && !styleChanged) return;
    const layoutChanged = state.envs !== this.lastEnvs || state.hermesCatalog !== this.lastCatalog;
    this.lastCatalog = state.hermesCatalog;
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
        sprite.sync(station, state);
      }
      for (const [key, sprite] of this.stations) {
        if (seen.has(key)) continue;
        sprite.destroy();
        this.stations.delete(key);
      }
      for (const [envId, node] of this.layout.environmentNodes) {
        let sprite = this.environmentNodes.get(envId);
        if (!sprite) {
          sprite = new EnvironmentNodeSprite(node.envId);
          this.environmentNodes.set(envId, sprite);
          this.environmentLayer.addChild(sprite.root);
        }
        sprite.sync(node, state);
      }
      for (const [envId, sprite] of this.environmentNodes) {
        if (this.layout.environmentNodes.has(envId)) continue;
        sprite.destroy();
        this.environmentNodes.delete(envId);
      }
      if (this.layout.controlCenter) {
        if (!this.controlCenter) {
          this.controlCenter = new ControlCenterSprite();
          this.environmentLayer.addChild(this.controlCenter.root);
          this.drawnCenter = undefined;
        }
        const center = this.layout.controlCenter;
        const live = center.envIds.some(id => state.envs[id]?.connection === 'live');
        const endpoints = [...this.layout.environmentNodes.values()].filter(n => state.envs[n.envId]?.connection === 'live').length;
        // Sessions change with every Hermes thread update; desks only draw these operator fields.
        const drawn = fingerprint(state.artStyle, center.hull, center.envId, live, endpoints, center.operators.map(({ bot, workstation }) =>
          [bot.name, bot.title, bot.observed, bot.state, bot.provider, bot.model, workstation]));
        if (drawn !== this.drawnCenter) {
          this.drawnCenter = drawn;
          this.controlCenter.build(center, live, endpoints);
        }
      } else { this.controlCenter?.destroy(); this.controlCenter = undefined; }
      const grid = fingerprint(this.layout.hub, [...this.layout.stations.values()].map((s) => s.port), this.layout.bounds);
      if (grid !== this.drawnGrid) {
        this.drawnGrid = grid;
        this.drawGrid();
      }
      const links = fingerprint(state.artStyle, this.layout.controlCenter?.links,
        [...this.layout.environmentNodes.values()].map((n) => [n.color, n.links, state.envs[n.envId]?.connection === "live"]),
        this.layout.controlCenter?.links.map((l) => state.envs[l.envId]?.connection === "live"));
      if (links !== this.drawnLinks) {
        this.drawnLinks = links;
        this.drawLinks(state);
      }
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
          // Crew already aboard when the map loads are just placed; a fresh recruit beams in.
          if (this.seeded.has(env.summary.id) && Date.now() - Date.parse(thread.createdAt) < RECRUIT_WINDOW_MS) sprite.beamIn();
        }
        const detail = state.details[key];
        sprite.update(thread, detail ? telemetry(detail.thread) : undefined, lay.color, detail?.thread);
      }
      if (env.synced) this.seeded.add(env.summary.id);
    }
    for (const [key, sprite] of this.crew) {
      if (seenCrew.has(key)) continue;
      sprite.destroy({ children: true });
      this.crew.delete(key);
    }

    // Keep framing the fleet as it grows or shrinks, not on every thread update.
    const bounds = fingerprint(this.layout.bounds);
    if (bounds !== this.fittedBounds && !this.userMoved && Object.values(state.envs).some((e) => e.synced)) {
      this.fittedBounds = bounds;
      this.fitAll();
    }
  }

  private drawGrid(): void {
    const g = this.grid.clear();
    for(const child of this.operations.removeChildren())child.destroy({children:true});
    const hub=this.layout.hub;
    if(hub){
      g.roundRect(hub.x,hub.y,hub.w,hub.h,12).fill(0x172c3c).stroke({color:0x698d9f,width:2});
      const title=label(12,0xc9e1e8);title.text='OPERATIONS';title.position.set(hub.x+18,hub.y+22);this.operations.addChild(title);
      const count=label(8,0x7eaaa8);count.text=`${this.layout.stations.size} PROJECT MODULES`;count.position.set(hub.x+18,hub.y+48);this.operations.addChild(count);
      for(const station of this.layout.stations.values()){
        const left=station.port.x<hub.x, lane=left?hub.x-50:hub.x+hub.w+50;
        const targetY=hub.y+hub.h/2;
        g.moveTo(station.port.x,station.port.y).lineTo(lane,station.port.y).lineTo(lane,targetY).lineTo(left?hub.x:hub.x+hub.w,targetY).stroke({color:0x547388,width:2,alpha:.6});
      }
    }
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
    const c = currentStyle().colors;
    for (const link of this.layout.controlCenter?.links ?? []) {
      const online = state.envs[link.envId]?.connection === 'live';
      const lane = link.laneX;
      // Physical docking collars fit the engineering nodes' existing top hatches.
      g.rect(lane - 20, link.from.y, 40, link.to.y - link.from.y).fill(c.D).stroke({ color: c.k, width: 2 });
      g.moveTo(lane - 12, link.from.y).lineTo(lane - 12, link.to.y)
        .moveTo(lane + 12, link.from.y).lineTo(lane + 12, link.to.y)
        .stroke({ color: HERMES_COLOR, width: 2, alpha: online ? 0.55 : 0.15 });
    }
    for (const node of this.layout.environmentNodes.values()) {
      const live = state.envs[node.envId]?.connection === "live";
      for (const link of node.links) {
        const points: number[] = [];
        for (let k = 0; k <= 24; k++) {
          const p = linkPoint(link.from, link.to, k / 24, link.via);
          points.push(p.x, p.y);
        }
        g.poly(points, false).stroke({ color: node.color, width: 5, alpha: live ? 0.1 : 0.04 });
        g.poly(points, false).stroke({ color: node.color, width: 2, alpha: live ? 0.6 : 0.15 });
      }
    }
  }

  // ---- Frame ----

  private tick(dt: number): boolean {
    this.time += dt;
    const state = useGame.getState();
    // Reduced motion freezes the animation clock: no blinking, pulsing, drifting or flowing
    // packets. State still shows through color, shape and position.
    const still = reducedMotion();
    const t = still ? 0 : this.time;
    const frame = still ? 0 : Math.floor(t * 5); // sprite animation rate
    const sel = state.selection;
    const panning = this.stepCamera(dt);

    if (this.sky) {
      this.sky.width = this.app.screen.width;
      this.sky.height = this.app.screen.height;
      this.sky.tilePosition.set(this.camera.x * 0.15, this.camera.y * 0.15);
    }

    // Crew heading to the same system room take evenly spaced slots, in a stable order.
    const sharing = new Map<string, CrewSprite[]>();
    for (const [key, sprite] of this.crew) {
      const lay = this.layout.crew.get(key);
      const s = lay && this.crewStation(lay);
      const system = lay && s ? sprite.systemRoom(lay, s) : undefined;
      if (!system) { sprite.slot = { index: 0, count: 1 }; continue; }
      const group = `${lay!.stationKey}|${system}`;
      sharing.set(group, [...(sharing.get(group) ?? []), sprite]);
    }
    for (const group of sharing.values()) {
      group.sort((a, b) => a.key.localeCompare(b.key)).forEach((sprite, index) => { sprite.slot = { index, count: group.length }; });
    }
    for (const [key, sprite] of this.crew) {
      const lay = this.layout.crew.get(key);
      const s = lay && this.crewStation(lay);
      if (!lay || !s) continue;
      const selected = sel?.kind === "unit" && sel.envId === sprite.envId && sel.threadId === sprite.threadId;
      sprite.tick(lay, s, t, dt, frame, selected, this.zoom);
    }
    this.separateLabels();
    this.drawLights(state, sel, t, frame);
    if (this.layout.controlCenter) this.controlCenter?.update(this.layout.controlCenter, sel, this.zoom, frame);
    for (const station of this.stations.values()) station.setZoom(this.zoom);
    for (const node of this.environmentNodes.values()) node.setZoom(this.zoom);
    this.drawEdgeIndicators(t);
    if (still) return panning || this.doorsOpen || [...this.crew.values()].some((crew) => crew.animated);
    return panning || this.doorsOpen || !!this.controlCenter?.animated || [...this.crew.values()].some((crew) => crew.animated)
      || Object.values(state.envs).some((env) => env.connection === "connecting" || env.connection === "reconnecting");
  }

  /** Visible crew name labels never print over each other: later ones step down into free space. */
  private separateLabels(): void {
    const placed: Rect[] = [];
    const labeled = [...this.crew.values()].map((sprite) => ({ sprite, box: sprite.labelBox() }))
      .filter((l): l is { sprite: CrewSprite; box: Rect } => !!l.box)
      .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    for (const { sprite, box } of labeled) {
      let dy = 0;
      const hits = (r: Rect) => placed.some((p) => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y);
      while (dy < box.h * 4 && hits({ ...box, y: box.y + dy })) dy += box.h + 1;
      sprite.setLabelOffset(dy);
      placed.push({ ...box, y: box.y + dy });
    }
  }

  /** Everything that changes frame to frame: screens, system icons, engines, plates, alerts. */
  private drawLights(state: GameState, sel: Selection, t: number, frame: number): void {
    const g = this.lights.clear();
    const o = this.overlay.clear();

    // Per-station and per-node tallies from the crew.
    const stationUse = new Map<string, Record<SystemRoom, boolean> & { attention: boolean; monitoringOnly: boolean }>();
    const environmentStates = new Map<string, UnitState[]>();
    const workingAt = new Set<string>(); // envId|stationKey with crew working
    let doorsOpen = false;
    const onDuty = new Set<string>(); // stations with awake crew on a live connection
    const walkers = new Map<string, CrewSprite[]>(); // stationKey → crew walking right now
    for (const sprite of this.crew.values()) {
      const lay = this.layout.crew.get(sprite.key);
      if (!lay) continue;
      if (!lay.sleeping && state.envs[sprite.envId]?.connection === "live") onDuty.add(lay.stationKey);
      if (sprite.moving) walkers.set(lay.stationKey, [...(walkers.get(lay.stationKey) ?? []), sprite]);
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
        const key = lay.envId;
        let states = environmentStates.get(key);
        if (!states) environmentStates.set(key, (states = []));
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
      // Lighting follows observed use: the bridge while crew are on duty, a system room while
      // someone works there. Everything else (idle rooms, quarters, archive) sits in shadow.
      for (const [kind, room] of Object.entries(s.rooms) as Array<[RoomKind, StationLayout["rooms"][RoomKind]]>) {
        if (!room) continue;
        const lit = kind === "bridge" ? onDuty.has(s.key) : kind === "terminal" || kind === "files" || kind === "comms" ? !!u?.[kind] : false;
        const r = room.rect;
        if (!lit) { g.rect(r.x, r.y, r.w, r.h).fill({ color: 0x000000, alpha: ROOM_SHADOW }); continue; }
        if (kind === "bridge") continue;
        // Screen glow spilling from the system's fixture into its room.
        const glow = kind === "comms" && u?.monitoringOnly ? STATUS.monitoring : STATUS.working;
        const fx = r.x + r.w * 0.3, fy = r.y + r.h - 26;
        g.rect(fx - 30, fy - 20, 60, 36).fill({ color: glow, alpha: 0.04 });
        g.rect(fx - 18, fy - 12, 36, 22).fill({ color: glow, alpha: 0.05 });
      }
      if (bridge && u?.attention) g.rect(bridge.x, bridge.y, bridge.w, bridge.h).fill({ color: STATUS.alert, alpha: 0.1 + (frame % 2) * 0.08 });
      // Doors slide open for crew walking through them, and close once they've passed.
      const sprite = this.stations.get(s.key);
      for (const door of sprite?.doors ?? []) {
        let nearest = Infinity;
        for (const crew of walkers.get(s.key) ?? []) nearest = Math.min(nearest, Math.hypot(crew.pos.x - door.x, crew.pos.y - door.y));
        const open = DOOR_ART[doorState(nearest)];
        if (open !== door.open) { door.open = open; door.sprite.texture = tex(open); }
        if (open !== A.DOOR_H) doorsOpen = true;
      }
      // FTL-style system indicators in each room's corner: lit while in use.
      for (const kind of ["terminal", "files", "comms"] as const) {
        const room = s.rooms[kind];
        if (!room) continue;
        const on = !!u?.[kind];
        const color = on ? (kind === "comms" && u?.monitoringOnly ? STATUS.monitoring : STATUS.done) : 0x59626c;
        const x = room.rect.x + room.rect.w - 16;
        const y = room.rect.y + 8;
        g.rect(x - 6, y - 2, 12, 12).fill(0x15191d).stroke({ color, width: 2 });
        g.rect(x - 2, y + 2, 4, 4).fill({ color, alpha: on && frame % 2 ? 1 : 0.6 });
      }
    }


    this.doorsOpen = doorsOpen;

    // Supply lines: one per (node, station it crews); packets flow while that crew is working.
    const l = this.packets.clear();
    for (const node of this.layout.environmentNodes.values()) {
      const live = state.envs[node.envId]?.connection === "live";
      for (const link of node.links) {
        if (live && workingAt.has(`${node.envId}|${link.stationKey}`)) {
          for (let k = 0; k < 4; k++) {
            const p = linkPoint(link.from, link.to, (t * 0.3 + k / 4) % 1, link.via);
            l.rect(Math.round(p.x) - 3, Math.round(p.y) - 3, 6, 6).fill(node.color);

          }
        }
      }
    }

    // Environment nodes: environment-wide live engine cells and connection/state indicators.
    for (const node of this.layout.environmentNodes.values()) {
      const env = state.envs[node.envId];
      const live = env?.connection === "live";
      // Scratch crew past the bay's standing room still count as this machine's crew.
      const overflow = (node.scratch?.overflow ?? []).flatMap((id) => env?.threads[id] ? [unitState(env.threads[id])] : []);
      const states = [...(environmentStates.get(node.envId) ?? []), ...overflow];
      const bayStates = [...this.crew.values()].filter((c) => this.layout.crew.get(c.key)?.stationKey === node.scratch?.stationKey).map((c) => c.state);
      const deck = this.environmentNodes.get(node.key);
      if (deck) {
        deck.root.alpha = live ? 1 : 0.45;
        deck.setActivity(states, live, frame, [...bayStates, ...overflow]);
      }
      const p = node.plate;
      const lightColor = live ? STATUS.done : env?.connection === "reconnecting" || env?.connection === "connecting" ? STATUS.question : 0x59626c;
      g.rect(p.x + p.w - 13, p.y + p.h / 2 - 4, 8, 8).fill({ color: lightColor, alpha: live || frame % 2 ? 1 : 0.4 });
      // One glyph per crew member: shape and color both carry the state.
      states.slice(0, 8).forEach((st, k) => {
        const x = p.x + p.w - 24 - (Math.min(8, states.length) - k) * 12, y = p.y + 5;
        for (const [cx, cy] of cells(STATUS_GLYPHS[st])) g.rect(x + cx * 2, y + cy * 2, 2, 2).fill(STATUS[st]);
      });
    }

    // Selected project: outline its station.
    if (sel && sel.kind === "building") {
      const s = this.stationFor(sel.envId, sel.projectId);
      if (s) o.poly(s.hull).stroke({ color: STATUS.done, width: 4 });
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
          if (gesturing()) return;
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
