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

import { Application, Container, Graphics, Rectangle, Sprite, type FederatedPointerEvent } from "pixi.js";
import { cells, STATUS_GLYPHS } from "../art/pixelfont";
import * as A from "../art/sprites";
import { setSelection, setSquad, unitKey, useGame, type GameState, type Selection, type SquadMember } from "../store";
import { isHistory, unitState, type UnitState } from "../t3/derive";
import { telemetry } from "../t3/telemetry";
import { computeFleetLayout, fingerprint, systemFixtureX, type CrewLayout, type FleetLayout, type Point, type Rect, type RoomKind, type StationLayout, type SystemRoom } from "./layout";
import { sfx } from "./sfx";
import { PixelText } from "./pixel-text";
import { endGesture, gesturing, holdTaps } from "./gesture";
import { isPhone } from "../ui/phone";
import { hudInsets } from "../ui/hud-insets";
import { waitingSince } from "../ui/queue";
import { doorState } from "./crew-motion";
import { RenderLoop, type DrawResult } from "./render-loop";
import { Backdrop } from "./backdrop";
import { consoleScreen, terminalScreen } from "./screens";
import { LightLayer, mixColor } from "./light";
import { dockedPrs, podSpot, stationMemory, tallyMark } from "./memory";
import { ControlCenterSprite } from "./control-center";
import { HERMES_COLOR } from "../t3/bots";
import { currentStyle, tex } from "./textures";
import { HUD, mapInk, SELECTION, STATUS, platingMaterials } from "./theme";
import { BROKEN_LINK, FLEET_VIEW_ZOOM, fitLabel, linkPath, pixelStamp, SIGNAL_GREY, UNPLUGGED, pixelArrow, pixelBox, pixelFrame, pixelPath, crispScale, floorZoom, snapZoom, label, linkPoint, CAMERA_SECONDS, FADE_SECONDS, RECRUIT_WINDOW_MS, clampZoom, DOOR_ART, reducedMotion, SCREEN_OFF, screenColor, lightSpill, shadeColor, steppedPlate, chamferOutline, pixelOval, hash } from "./map-common";
import { worldRef } from "./world-ref";
import { CrewSprite } from "./crew-sprite";
import { domeGlass, hullWindows, nacelles, pixelDisc, roomUnder, StationSprite } from "./station-sprite";
import { EnvironmentNodeSprite } from "./engineering-node";

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

/** How long a merged PR's pod takes to launch away. */
const LAUNCH_MS = 2200;

/** 7×7 stamps saying what a room is, for the fleet view's flat rooms. */
const ROOM_STAMPS: Record<RoomKind, string[]> = {
  bridge: ["#######", "#.....#", "#.....#", "#######", "...#...", "..###..", "......."],
  terminal: ["#######", "#.....#", "#.#...#", "#..#..#", "#.#.###", "#.....#", "#######"],
  files: [".#####.", ".#...#.", ".#####.", ".#...#.", ".#####.", ".#...#.", ".#####."],
  comms: ["#.....#", "#.....#", ".#...#.", "..###..", "...#...", "...#...", "..###.."],
  quarters: [".......", "#......", "#######", "#.....#", "#######", "#.....#", "......."],
  archive: ["#######", "##.#.##", "##.#.##", "#######", "#.##.##", "#.##.##", "#######"],
};

export class World {
  private app = new Application();
  private backdrop?: Backdrop;
  private camera = new Container();
  private grid = new Graphics();
  private operations = new Container();
  private links = new Graphics();
  private packets = new Graphics();
  /** The fleet view's room blocks and crew glyphs, drawn only when zoomed far out. */
  private fleetView = new Graphics();
  private stationLayer = new Container();
  private environmentLayer = new Container();
  private lights = new Graphics();
  /** Additive light: console pools and the spotlight on whoever waits on you. */
  private glow = new LightLayer();
  /** Each room's lamps as last seen (and since when), for switch-on and lights-out (see lampView). */
  private lampSeen = new Map<string, { lit: boolean; at: number; delay: number }>();
  private lampsMoving = false;
  private drawnLinkWidth = 0;
  private wasAwake = false;
  private lightsOutAt = -Infinity;
  /** Unlit rooms, multiplied by a theme-tinted dim tone. */
  private shade = Object.assign(new Graphics(), { blendMode: "multiply" as const });
  private crewLayer = new Container();
  /** Crew name labels, above every crew sprite (see CrewSprite.labelLayer). */
  private crewLabels = new Container();
  /** Fleet-view rollup lines under each station ("2 WORKING · 1 WAITING 22M · 1 PR"). */
  private fleetLabels = new Container();
  private fleetRollups = new Map<string, PixelText[]>();
  private overlay = new Graphics();
  private edge = new Graphics();
  private edgeHits = new Container();
  private stations = new Map<string, StationSprite>();
  private environmentNodes = new Map<string, EnvironmentNodeSprite>();
  private controlCenter?: ControlCenterSprite;
  private lastCatalog?: GameState["hermesCatalog"];
  private crew = new Map<string, CrewSprite>();
  /** The row offset each crew name label last settled on (see separateLabels). */
  private labelRows = new Map<string, number>();
  /** Continuous zoom the wheel/pinch is aiming for; the drawn zoom is its nearest crisp step. */
  private zoomGoal?: number;
  /** Screen-space rectangle of an in-progress shift-drag selection. */
  private selectBox?: Rect;
  /** The operations hub's labels: the title held crisp when zoomed out, the count hidden. */
  private opsLabels?: { title: PixelText; count: PixelText };
  /** Crew beaming out after their thread was archived or removed. */
  private departing = new Set<CrewSprite>();
  /** Each station's open PR numbers, newest first, as last drawn: a merge launches its pod. */
  private podsSeen = new Map<string, number[]>();
  /** Merged PRs leaving: the pod lifting off, then the new tally mark flashing on the hull. */
  private launches: Array<{ x: number; y: number; at: number; tally?: { x: number; y: number } }> = [];
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
  /** The previous theme's last frame, fading out over the new one. */
  private fade?: Sprite;
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
    await this.app.init({ width: host.clientWidth, height: host.clientHeight, background: currentStyle().space, antialias: false, autoDensity: true, resolution: 1, roundPixels: true, autoStart: false, powerPreference: "low-power" });
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

    this.backdrop = new Backdrop(this.app.renderer);
    this.backdrop.build(useGame.getState().artStyle, this.app.screen.width, this.app.screen.height);
    this.crewLayer.sortableChildren = true;
    this.camera.addChild(this.grid, this.operations, this.links, this.packets, this.stationLayer, this.environmentLayer, this.shade, this.glow.root, this.lights, this.fleetView, this.fleetLabels, this.crewLayer, this.crewLabels, this.overlay);
    this.app.stage.addChild(this.backdrop.root, this.camera, this.edge, this.edgeHits);
    this.setupCamera();

    this.renderLoop = new RenderLoop((dt) => {
      this.sync(useGame.getState());
      const animated = this.tick(dt);
      this.app.render();
      return animated;
    });
    this.unsubscribe = useGame.subscribe((s, prev) => {
      // Jumps usually follow a selection change; the view to go back to had the selection before it.
      if (s.selection !== prev.selection || s.hostPanel !== prev.hostPanel) this.before = { selection: prev.selection, hostPanel: prev.hostPanel, at: performance.now() };
      if (s.envs !== prev.envs || s.details !== prev.details || s.hosts !== prev.hosts || s.selection !== prev.selection || s.squad !== prev.squad || s.hermesCatalog !== prev.hermesCatalog || s.artStyle !== prev.artStyle) this.invalidate();
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

  // ---- Camera ----

  private setupCamera(): void {
    const stage = this.app.stage;
    stage.eventMode = "static";
    stage.hitArea = this.app.screen;
    stage.on("pointermove", this.invalidate);
    stage.on("pointerover", this.invalidate);
    stage.on("pointerout", this.invalidate);
    // Shift-drag draws a selection box instead of panning.
    let drag: { x: number; y: number; camX: number; camY: number; moved: boolean; box: boolean } | null = null;
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
      drag = { x: e.global.x, y: e.global.y, camX: this.camera.x, camY: this.camera.y, moved: false, box: e.shiftKey && e.pointerType !== "touch" };
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
      if (drag.moved && !drag.box) this.zoomGoal = undefined;
      if (drag.moved && drag.box) {
        this.selectBox = { x: Math.min(drag.x, e.global.x), y: Math.min(drag.y, e.global.y), w: Math.abs(dx), h: Math.abs(dy) };
        this.invalidate();
      } else if (drag.moved) {
        this.userMoved = true;
        this.camera.position.set(Math.round(drag.camX + dx), Math.round(drag.camY + dy));
        this.invalidate();
      }
    });
    stage.on("pointerup", (e: FederatedPointerEvent) => {
      if (drag?.box && drag.moved && this.selectBox) {
        this.boxSelect(this.selectBox);
        this.selectBox = undefined;
        this.invalidate();
      }
      if (drag && !drag.moved && e.target === stage && !gesturing() && !(e.pointerType === "touch" && this.tapNearbyCrew(e.global.x, e.global.y))) setSelection(null);
      // A pan that ends over a crew member or module isn't a tap on it (taps fire after this).
      if (drag?.moved) holdTaps(50);
      drag = null;
      lift(e);
    });
    stage.on("pointerupoutside", (e: FederatedPointerEvent) => {
      if (this.selectBox) { this.selectBox = undefined; this.invalidate(); }
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

  /** Whole screen pixels for the camera offset, so art pixels don't straddle screen pixels. */
  private snapCamera(): void {
    this.camera.position.set(Math.round(this.camera.x), Math.round(this.camera.y));
  }

  private view(): CameraView {
    const { width, height } = this.app.screen;
    return { cx: (width / 2 - this.camera.x) / this.zoom, cy: (height / 2 - this.camera.y) / this.zoom, zoom: this.zoom };
  }

  private applyView(v: CameraView): void {
    const { width, height } = this.app.screen;
    this.setZoom(v.zoom);
    this.camera.position.set(width / 2 - v.cx * this.zoom, height / 2 - v.cy * this.zoom);
    this.snapCamera();
  }

  /** Put the camera at (x, y) and `zoom`, easing there unless motion is reduced. */
  private moveCamera(x: number, y: number, zoom: number, animate = true): void {
    const { width, height } = this.app.screen;
    // Moves always settle on a crisp zoom step (the tween may pass through others on the way).
    const z = snapZoom(clampZoom(zoom));
    this.zoomGoal = undefined;
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

  /**
   * Wheel and pinch accumulate a continuous goal, but the map is drawn at the nearest crisp step,
   * so zooming clicks between sharp levels instead of passing through blurry ones.
   */
  private zoomAt(sx: number, sy: number, factor: number): void {
    const wx = (sx - this.camera.x) / this.zoom;
    const wy = (sy - this.camera.y) / this.zoom;
    this.zoomGoal = clampZoom((this.zoomGoal ?? this.zoom) * factor);
    this.setZoom(snapZoom(this.zoomGoal));
    this.camera.position.set(sx - wx * this.zoom, sy - wy * this.zoom);
    this.snapCamera();
    this.invalidate();
  }

  /**
   * The visible part of the map: the screen minus what the HUD covers right now. Measured after
   * the next render, so a panel opened by the same click is already in place.
   */
  private visibleArea(): { x: number; y: number; w: number; h: number } {
    const { width, height } = this.app.screen;
    const inset = hudInsets();
    const w = Math.max(120, width - inset.left - inset.right);
    const h = Math.max(120, height - inset.top - inset.bottom);
    return { x: inset.left, y: inset.top, w, h };
  }

  private frame(rect: Rect, maxZoom: number): void {
    requestAnimationFrame(() => {
      if (this.destroyed) return;
      const area = this.visibleArea();
      // Frame above the planet's horizon (at 80% of the screen), so the lowest station doesn't
      // sit half-landed on it.
      const horizon = this.app.screen.height * 0.8 - 8;
      const h = Math.max(120, Math.min(area.y + area.h, horizon) - area.y);
      const margin = isPhone() ? 40 : 80;
      const z = floorZoom(clampZoom(Math.min(maxZoom, Math.min(area.w / (rect.w + margin), h / (rect.h + margin)))));
      this.moveCamera(area.x + area.w / 2 - (rect.x + rect.w / 2) * z, area.y + h / 2 - (rect.y + rect.h / 2) * z, z, this.framed);
      this.framed = true;
    });
  }

  fitAll(): void {
    if (!this.initialized) return;
    this.frame(this.layout.bounds, 1.2);
  }

  focusRect(rect: Rect): void {
    if (!this.initialized) return;
    this.remember();
    this.userMoved = true;
    this.frame(rect, 2);
  }

  private focusControlCenter(): void {
    const center = this.layout.controlCenter;
    if (!center || !this.initialized) return;
    this.remember();
    this.userMoved = true;
    this.frame(center.bounds, 1.4);
  }

  /**
   * Where you were before a jump (Space, the roster, a link, the queue…): camera and what was
   * open. Backspace or Alt+← goes back, eight jumps deep, so triage never loses your place.
   */
  private views: Array<{ x: number; y: number; zoom: number; selection: Selection; hostPanel: string | null }> = [];
  private before?: { selection: Selection; hostPanel: string | null; at: number };

  private remember(): void {
    const s = useGame.getState();
    const recent = this.before && performance.now() - this.before.at < 300 ? this.before : undefined;
    const view = { x: this.camera.x, y: this.camera.y, zoom: this.zoom, selection: recent ? recent.selection : s.selection, hostPanel: recent ? recent.hostPanel : s.hostPanel };
    const top = this.views.at(-1);
    if (top && Math.abs(top.x - view.x) < 4 && Math.abs(top.y - view.y) < 4 && top.zoom === view.zoom && top.selection === view.selection) return;
    this.views.push(view);
    if (this.views.length > 8) this.views.shift();
  }

  /** Return to the view before the last jump. False when there's nowhere to go back to. */
  back(): boolean {
    const view = this.views.pop();
    if (!view) return false;
    this.userMoved = true;
    this.moveCamera(view.x, view.y, view.zoom, !reducedMotion());
    useGame.setState({ selection: view.selection, hostPanel: view.hostPanel });
    return true;
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

  /** Add every crew member inside a screen rectangle to the squad. */
  private boxSelect(box: Rect): void {
    const inside: SquadMember[] = [];
    for (const sprite of this.crew.values()) {
      if (!sprite.visible) continue;
      const c = sprite.toGlobal({ x: 0, y: -20 });
      if (c.x >= box.x && c.x <= box.x + box.w && c.y >= box.y && c.y <= box.y + box.h) inside.push({ envId: sprite.envId, threadId: sprite.threadId });
    }
    if (!inside.length) return;
    sfx.select();
    const { squad } = useGame.getState();
    const have = new Set(squad.map((m) => unitKey(m.envId, m.threadId)));
    setSquad([...squad, ...inside.filter((m) => !have.has(unitKey(m.envId, m.threadId)))]);
  }

  /** Frame a set of crew (a recalled control group). */
  frameCrew(members: SquadMember[]): void {
    this.remember();
    const keys = new Set(members.map((m) => unitKey(m.envId, m.threadId)));
    const points = [...this.crew.entries()].filter(([key]) => keys.has(key)).map(([, sprite]) => sprite.pos);
    if (!points.length) return;
    const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
    const x = Math.min(...xs) - 40, y = Math.min(...ys) - 60;
    this.focusRect({ x, y, w: Math.max(...xs) + 40 - x, h: Math.max(...ys) + 20 - y });
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
    this.remember();
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
    const target = p;
    requestAnimationFrame(() => {
      if (this.destroyed) return;
      const area = this.visibleArea();
      // A jump lands at 1× (the art at two screen pixels a pixel), not closer: near enough to read
      // the crew, far enough to keep their neighbours and the station in view.
      const z = clampZoom(Math.max(this.zoom, 1));
      this.moveCamera(area.x + area.w / 2 - target.x * z, area.y + area.h / 2 + 20 - target.y * z, z);
    });
  }

  /** The map as it looks now, rendered at `resolution` times its screen size (for photo mode). */
  async snapshot(resolution = 2): Promise<HTMLCanvasElement | undefined> {
    if (!this.initialized) return undefined;
    this.app.render();
    // Just what's on screen (the stage also holds the oversized horizon and off-screen fleet).
    const { width, height } = this.app.screen;
    return this.app.renderer.extract.canvas({ target: this.app.stage, frame: new Rectangle(0, 0, width, height), resolution }) as HTMLCanvasElement;
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

    if (styleChanged && this.initialized && this.backdrop) {
      this.crossfade();
      this.app.renderer.background.color = currentStyle().space;
      this.backdrop.build(state.artStyle, this.app.screen.width, this.app.screen.height);
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
        this.watchMerges(station, state);
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
        [...this.layout.environmentNodes.values()].map((n) => [n.color, n.links, state.envs[n.envId]?.connection]),
        this.layout.controlCenter?.links.map((l) => state.envs[l.envId]?.connection === "live"),
        [...this.staffed()].sort());
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
          this.crewLabels.addChild(sprite.labelLayer);
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
      this.crew.delete(key);
      this.labelRows.delete(key);
      // Archived or removed: beam out where they stand, then go.
      if (sprite.beamOut()) this.departing.add(sprite);
      else sprite.destroy({ children: true });
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
      // Operations hub: a stepped-corner plate in the theme's HUD materials.
      const m = platingMaterials(useGame.getState().artStyle);
      steppedPlate(g, hub.x - 2, hub.y - 2, hub.w + 4, hub.h + 4, 12, 4, m.edgeStrong);
      steppedPlate(g, hub.x, hub.y, hub.w, hub.h, 10, 4, m.surface);
      const ink = mapInk(useGame.getState().artStyle);
      const title=label(12,ink.text);title.text='OPERATIONS';title.position.set(hub.x+18,hub.y+22);this.operations.addChild(title);
      const count=label(8,ink.muted);count.text=`${this.layout.stations.size} PROJECT MODULES`;count.position.set(hub.x+18,hub.y+48);this.operations.addChild(count);
      this.opsLabels = { title, count };
      // The head of the ship without Hermes: a stem down from the plate and a beam along the
      // top deck row, a drop to each deck's roof. (Projects connect through the decks below.)
      const decks = [...this.layout.environmentNodes.values()].filter((n) => n.hull.y === 0);
      if (decks.length) {
        const beamY = -12, cx = hub.x + hub.w / 2;
        pixelPath(g, [{ x: cx, y: hub.y + hub.h }, { x: cx, y: beamY }], 2, ink.line, 0.6);
        pixelPath(g, [{ x: Math.min(cx, ...decks.map((n) => n.hatchX)), y: beamY }, { x: Math.max(cx, ...decks.map((n) => n.hatchX)), y: beamY }], 2, ink.line, 0.6);
        for (const n of decks) pixelPath(g, [{ x: n.hatchX, y: beamY }, { x: n.hatchX, y: 0 }], 2, ink.line, 0.6);
      }
    }
    const b = this.layout.bounds;
    const step = 400;
    const pad = 2400;
    const x0 = Math.floor((b.x - pad) / step) * step;
    const y0 = Math.floor((b.y - pad) / step) * step;
    for (let x = x0; x < b.x + b.w + pad; x += step) {
      for (let y = y0; y < b.y + b.h + pad; y += step) {
        g.rect(x - 3, y, 7, 1).fill({ color: HUD.muted, alpha: 0.14 });
        g.rect(x, y - 3, 1, 7).fill({ color: HUD.muted, alpha: 0.14 });
      }
    }
  }

  /** "envId|stationKey" for each machine with awake crew at a station: what a solid supply line means. */
  private staffed(): Set<string> {
    const on = new Set<string>();
    for (const crew of this.layout.crew.values()) if (!crew.sleeping) on.add(`${crew.envId}|${crew.stationKey}`);
    return on;
  }

  private drawLinks(state: GameState): void {
    const g = this.links.clear();
    const c = currentStyle().colors;
    // Never thinner than about two screen pixels, so the network survives zooming out.
    const width = linkWidth(this.zoomGoal ?? this.zoom);
    this.drawnLinkWidth = width;
    const staffed = this.staffed();
    // The keel's spine: a stem down from the Hermes hall and a beam along the top deck row.
    const spine = this.layout.controlCenter?.manifold;
    if (spine) {
      const online = this.layout.controlCenter!.links.some((l) => state.envs[l.envId]?.connection === "live");
      pixelBox(g, spine.stemX - 20, spine.top, 40, spine.y - spine.top + 8, c.D, c.k);
      pixelBox(g, spine.x0 - 20, spine.y - 8, spine.x1 - spine.x0 + 40, 16, c.D, c.k);
      for (const x of [spine.stemX - 12, spine.stemX + 12]) pixelPath(g, [{ x, y: spine.top }, { x, y: spine.y - 4 }], 2, HERMES_COLOR, online ? 0.55 : 0.15);
      for (const y of [spine.y - 4, spine.y + 4]) pixelPath(g, [{ x: spine.x0 - 12, y }, { x: spine.x1 + 12, y }], 2, HERMES_COLOR, online ? 0.55 : 0.15);
    }
    for (const link of this.layout.controlCenter?.links ?? []) {
      const online = state.envs[link.envId]?.connection === 'live';
      const lane = link.laneX;
      // Physical docking collars fit the engineering nodes' existing top hatches.
      pixelBox(g, lane - 20, link.from.y, 40, link.to.y - link.from.y, c.D, c.k);
      for (const x of [lane - 12, lane + 12]) pixelPath(g, [{ x, y: link.from.y }, { x, y: link.to.y }], 2, HERMES_COLOR, online ? 0.55 : 0.15);
    }
    for (const node of this.layout.environmentNodes.values()) {
      const live = state.envs[node.envId]?.connection === "live";
      for (const link of node.links) {
        // A run of art-pixel cells along the route; an unreachable machine's line is severed (dashed).
        const path = linkPath(link.from, link.to, link.via);
        const reaching = live || state.envs[node.envId]?.connection === "connecting" || state.envs[node.envId]?.connection === "reconnecting";
        // A solid line means crew from this machine are awake at that station; a project the
        // machine merely has checked out, with nobody on it, is a dim dotted hairline.
        const crewed = staffed.has(`${node.envId}|${link.stationKey}`);
        if (live && !crewed) pixelPath(g, path, Math.max(2, width / 2), node.color, 0.3, 4);
        else pixelPath(g, path, width, node.color, live ? 0.6 : reaching ? 0.2 : 0.25, reaching ? 0 : 8);
        // Where a line that isn't carrying anything meets the station: a pulled plug, or a parted
        // link while the machine reconnects, just outside the port.
        if (!live && state.envs[node.envId]?.connection !== "needs-update") {
          const prev = path[path.length - 2] ?? link.from;
          const side = Math.sign(link.to.x - prev.x) || 1;
          const x = link.to.x - side * 14 - 7, y = link.to.y - 7;
          pixelStamp(g, reaching ? BROKEN_LINK : UNPLUGGED, x, y, SIGNAL_GREY, c.k);
        }
      }
    }
  }

  /** Snapshot the map as it looks now, to fade out over the restyled one (no hard cut). */
  private crossfade(): void {
    if (reducedMotion()) return;
    this.fade?.destroy({ texture: true });
    const { width, height } = this.app.screen;
    const texture = this.app.renderer.generateTexture({ target: this.app.stage, frame: new Rectangle(0, 0, width, height) });
    this.fade = new Sprite(texture);
    this.fade.eventMode = "none";
    this.app.stage.addChild(this.fade);
  }

  /**
   * A merged PR's pod launches: open last time, gone now, and merged on one of the station's
   * threads. The first look at a station only sets the baseline, so nothing launches on load.
   */
  private watchMerges(s: StationLayout, state: GameState): void {
    const open = dockedPrs(state, s).map((p) => p.number);
    const prev = this.podsSeen.get(s.key);
    this.podsSeen.set(s.key, open);
    if (!prev || reducedMotion()) return;
    // Merged just now: one Command learned of later (a correction from GitHub) that merged long
    // ago joins the tally quietly, without a launch.
    const merged = new Set<number>();
    const now = Date.now();
    for (const { envId, projectId } of s.members) {
      for (const t of Object.values(state.envs[envId]?.threads ?? {})) {
        if (t.projectId !== projectId) continue;
        for (const pr of t.pullRequests ?? []) {
          const at = pr.snapshot?.mergedAt ? Date.parse(pr.snapshot.mergedAt) : NaN;
          if (pr.snapshot?.state === "merged" && !(now - at > 10 * 60_000)) merged.add(pr.number);
        }
      }
    }
    const hullBottom = s.hull[11];
    const count = stationMemory(state, s).merged;
    prev.forEach((n, k) => {
      if (open.includes(n) || !merged.has(n)) return;
      const spot = podSpot(s.interior, hullBottom, k);
      this.launches.push({ x: spot.x, y: spot.y, at: performance.now(), tally: tallyMark(s.interior, hullBottom, count) });
      sfx.done();
    });
  }

  /**
   * Launches in flight: the pod drops off its strut and away into space on a dithered exhaust in
   * the world's lamp colour, accelerating, while the new tally mark on the hull flashes.
   */
  private drawLaunches(o: Graphics): void {
    if (!this.launches.length) return;
    const style = currentStyle(), c = style.colors, lamp = style.light ?? c.w;
    const now = performance.now();
    this.launches = this.launches.filter((l) => now - l.at < LAUNCH_MS * 1.5);
    for (const l of this.launches) {
      const k = (now - l.at) / LAUNCH_MS;
      if (k < 1) {
        // Away from the hull into open space: down and a little outward, accelerating.
        const fall = Math.round((k * k * 240) / 2) * 2, drift = Math.round((k * k * 40) / 2) * 2;
        const x = l.x + drift, y = l.y + fall;
        steppedPlate(o, x - 2, y - 2, 28, 18, 6, 2, c.k);
        steppedPlate(o, x, y, 24, 14, 4, 2, c.W);
        o.rect(x + 4, y + 4, 16, 2).fill(c.w);
        o.rect(x + 16, y + 6, 2, 2).fill(STATUS.done);
        // Exhaust trailing behind (above) the pod, sparser further back.
        for (let row = 0; row < 8; row++) {
          for (let cx = 6; cx < 18; cx += 2) {
            if ((cx / 2 + row + Math.floor(k * 20)) % (row < 3 ? 2 : 3) !== 0) continue;
            o.rect(x + cx, y - 4 - row * 2, 2, 2).fill(row < 2 ? 0xffffff : lamp);
          }
        }
      }
      // The new tally mark blinks in after the pod clears.
      if (l.tally && k > 0.5 && Math.floor(k * 8) % 2 === 0) {
        pixelFrame(o, l.tally.x - 4, l.tally.y - 4, 10, 16, STATUS.done, 1, 2);
      }
    }
  }

  /**
   * Viewports lit from inside: each window on the hull's top band shows the lamp of the room under
   * it, so from outside you can tell which rooms are in use. Lamp colour, never a status colour.
   */
  private litWindows(g: Graphics, s: StationLayout, lampAt: (x: number) => "on" | "flicker" | "off"): void {
    const style = currentStyle(), lamp = style.light ?? 0xe8f0f8;
    for (const w of hullWindows(s, style.hull ?? "industrial")) {
      const mode = lampAt(w.x + w.w / 2);
      if (mode === "off") continue;
      const alpha = mode === "flicker" ? 0.5 : 1;
      if (w.round) pixelDisc(g, w.x + 4, w.y + 4, 4, lamp, alpha);
      else g.rect(w.x, w.y, w.w, w.h).fill({ color: lamp, alpha });
      if (mode !== "on" || !this.glowing) continue;
      // A faint dithered halo on the plating just outside the frame: every other art pixel.
      for (let x = w.x - 4; x < w.x + w.w + 4; x += 4) {
        g.rect(x, w.y - 4 - (w.round ? 2 : 0), 2, 2).fill({ color: lamp, alpha: 0.22 });
        g.rect(x + 2, w.y + w.h + 2 + (w.round ? 2 : 0), 2, 2).fill({ color: lamp, alpha: 0.22 });
      }
    }
  }

  /** Kestrel's nacelle exhaust: a dithered glow trailing from each nozzle in the lamp colour, flickering a little. */
  private exhaust(g: Graphics, s: StationLayout, strength: number, frame: number): void {
    const lamp = currentStyle().light ?? 0xffffff;
    for (const n of nacelles(s)) {
      for (let k = 0; k < 4; k++) {
        for (let r = 0; r < n.nh - 8; r += 2) {
          if ((k + r / 2 + (frame & 1)) % 2 !== 0 && k > 0) continue;
          g.rect(n.right ? n.ex + 4 + k * 2 : n.ex - 2 - k * 2, n.ny + 4 + r, 2, 2).fill({ color: lamp, alpha: (0.9 - k * 0.22) * strength });
        }
      }
    }
  }

  /**
   * A room's ceiling strip, in the world's lamp colour: lit with a dithered bloom falling from it,
   * dark when the room is, or catching for a frame in a brownout.
   */
  /**
   * A room's lamps as seen: the real state (`lit`), shown through the world's switch-on: Night
   * Shift's tubes stutter (on, off, on, off, hold at 60 ms), Kestrel's sodium lamps warm up through
   * three colours over 0.6 s. A room going dark can wait `outDelay` s first (the fleet's lights-out).
   * Nothing plays on first sight of a room or with reduced motion.
   */
  private lampView(key: string, lit: boolean, outDelay: number): { on: boolean; mode: "on" | "off"; color?: number } {
    const settled = { on: lit, mode: lit ? "on" as const : "off" as const };
    const seen = this.lampSeen.get(key);
    if (!seen) { this.lampSeen.set(key, { lit, at: -Infinity, delay: 0 }); return settled; }
    if (seen.lit !== lit) Object.assign(seen, { lit, at: reducedMotion() ? -Infinity : this.time, delay: lit ? 0 : outDelay });
    if (seen.at === -Infinity) return settled;
    const since = this.time - seen.at - seen.delay;
    if (since < 0) { this.lampsMoving = true; return { on: !lit, mode: lit ? "off" : "on" }; }
    if (!lit) return settled;
    const style = currentStyle();
    if ((style.id === "nightshift" || style.id === "flightdeck-nightshift") && since < 0.24) {
      this.lampsMoving = true;
      return { on: true, mode: Math.floor(since / 0.06) % 2 ? "off" : "on" };
    }
    if (style.id === "flightdeck" && since < 0.6) {
      this.lampsMoving = true;
      return { on: true, mode: "on", color: [0x7a4a20, 0xc28e52, style.light ?? 0xffd49a][Math.floor(since / 0.2)] };
    }
    return settled;
  }

  private ceilingLight(g: Graphics, r: { x: number; y: number; w: number; h: number }, mode: "on" | "off" | "flicker", color?: number): number[] {
    const tubes: number[] = [];
    const style = currentStyle();
    const lamp = color ?? style.light ?? 0xe8f0f8;
    const y0 = r.y + 2;
    // Tubes of 20 px with gaps, centred along the ceiling.
    const count = Math.max(1, Math.floor((r.w - 12) / 28));
    const x0 = r.x + Math.round((r.w - (count * 28 - 8)) / 4) * 2;
    for (let k = 0; k < count; k++) {
      const x = x0 + k * 28;
      tubes.push(x + 10);
      if (mode === "off") { g.rect(x, y0, 20, 2).fill(style.colors.k); continue; }
      g.rect(x, y0, 20, 2).fill(mode === "flicker" ? { color: lamp, alpha: 0.5 } : lamp);
      if (mode === "flicker") continue;
      // Bloom: two sparse rows of 2-px cells under each tube, narrowing, so the dark gap between
      // tubes stays a gap (a fanning bloom ran together into one fringe).
      for (let row = 0; row < 2; row++) {
        for (let cx = x + 2 + row * 4; cx < x + 18 - row * 4; cx += 2) {
          if ((cx / 2 + row) % (row + 2) !== 0) continue;
          g.rect(cx, y0 + 2 + row * 2, 2, 2).fill({ color: lamp, alpha: 0.24 - row * 0.08 });
        }
      }
    }
    return tubes;
  }

  /** Whether additive light draws: not in High Contrast, and not in the flat fleet view. */
  private get glowing(): boolean {
    return currentStyle().id !== "highcontrast" && this.zoom >= FLEET_VIEW_ZOOM;
  }

  // ---- Frame ----

  private tick(dt: number): DrawResult {
    this.time += dt;
    const state = useGame.getState();
    // Reduced motion freezes the animation clock: no blinking, pulsing, drifting or flowing
    // packets. State still shows through color, shape and position.
    const still = reducedMotion();
    const t = still ? 0 : this.time;
    const frame = still ? 0 : Math.floor(t * 5); // sprite animation rate
    const sel = state.selection;
    const squad = new Set(state.squad.map((m) => unitKey(m.envId, m.threadId)));
    // Crew on a mission still playing out: the newest such mission each is on.
    const missions = new Map<string, string>();
    for (const d of state.dispatches) if (d.mission && !d.finishedAt) for (const m of d.members) if (!missions.has(unitKey(m.envId, m.threadId))) missions.set(unitKey(m.envId, m.threadId), d.mission.name);
    const panning = this.stepCamera(dt);
    if (this.fade) {
      this.fade.alpha -= dt / FADE_SECONDS;
      if (this.fade.alpha <= 0) { this.fade.destroy({ texture: true }); this.fade = undefined; }
    }

    this.backdrop?.update(this.app.screen.width, this.app.screen.height, this.camera.x, this.camera.y, t);

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
      sprite.inSquad = squad.has(key);
      sprite.mission = missions.get(key);
      sprite.offline = state.envs[sprite.envId]?.connection !== "live";
      sprite.tick(lay, s, t, dt, frame, selected, this.zoom, this.tween?.to.zoom ?? this.zoom);
    }
    for (const sprite of this.departing) {
      if (sprite.departTick(t, dt)) continue;
      this.departing.delete(sprite);
      sprite.destroy({ children: true });
    }
    this.separateLabels();
    // Zooming out thickens the supply lines (they'd vanish otherwise): redraw when the width steps.
    if (linkWidth(this.zoomGoal ?? this.zoom) !== this.drawnLinkWidth) this.drawLinks(state);
    this.glow.begin();
    this.drawLights(state, sel, t, frame);
    this.glow.end();
    this.drawFleetView(state, sel);
    // Labels are sized for the zoom the camera is settling on, not each in-between frame of a
    // move; otherwise they jump between whole-pixel sizes and re-truncate as the camera eases.
    const labelZoom = this.tween?.to.zoom ?? this.zoom;
    if (this.layout.controlCenter) this.controlCenter?.update(this.layout.controlCenter, sel, labelZoom, frame);
    for (const station of this.stations.values()) station.setZoom(labelZoom);
    for (const node of this.environmentNodes.values()) node.setZoom(labelZoom);
    if (this.opsLabels && !this.opsLabels.title.destroyed) {
      this.opsLabels.title.scale.set(crispScale(this.opsLabels.title.unit, this.zoom));
      this.opsLabels.count.visible = this.opsLabels.count.unit * this.zoom >= 0.8;
    }
    this.drawEdgeIndicators(t);
    for (const text of PixelText.live) { if (this.tween) text.unsnap(); else text.snapToPixels(); }
    if (this.selectBox) {
      const b = this.selectBox;
      this.edge.rect(b.x, b.y, b.w, b.h).fill({ color: SELECTION, alpha: 0.08 });
      pixelFrame(this.edge, Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h), SELECTION, 0.9, 1);
    }
    if (still) return panning || !!this.fade || this.doorsOpen || this.departing.size > 0 || [...this.crew.values()].some((crew) => crew.animated);
    const moving = panning || !!this.fade || this.doorsOpen || this.lampsMoving || this.departing.size > 0 || this.launches.length > 0 || !!this.controlCenter?.animated || [...this.crew.values()].some((crew) => crew.animated)
      || Object.values(state.envs).some((env) => env.connection === "connecting" || env.connection === "reconnecting");
    // Nothing moving: the fleet still breathes at a low rate (deck lights and fins, sleepers' z's,
    // glances at consoles, twinkling stars) instead of freezing until the next input.
    return moving || "ambient";
  }

  /** Visible crew name labels never print over each other: later ones step down into free space. */
  private separateLabels(): void {
    const placed: Rect[] = [];
    // A stable order (by crew, not by where they happen to be this frame) and a preference for
    // the row each label already has, so labels don't hop between rows as crew walk.
    const labeled = [...this.crew.values()].map((sprite) => ({ sprite, box: sprite.labelBox() }))
      .filter((l): l is { sprite: CrewSprite; box: Rect } => !!l.box)
      .sort((a, b) => a.sprite.key.localeCompare(b.sprite.key));
    const hits = (r: Rect) => placed.some((p) => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y);
    for (const { sprite, box } of labeled) {
      const step = box.h + 1;
      let dy = this.labelRows.get(sprite.key) ?? 0;
      if (hits({ ...box, y: box.y + dy })) {
        dy = 0;
        while (dy < step * 4 && hits({ ...box, y: box.y + dy })) dy += step;
      } else if (dy > 0 && !hits({ ...box, y: box.y })) dy = 0; // Room opened up: go home.
      this.labelRows.set(sprite.key, dy);
      sprite.setLabelOffset(dy);
      placed.push({ ...box, y: box.y + dy });
    }
  }

  /** Everything that changes frame to frame: screens, system icons, engines, plates, alerts. */
  private drawLights(state: GameState, sel: Selection, t: number, frame: number): void {
    const g = this.lights.clear();
    const o = this.overlay.clear();
    this.drawLaunches(o);

    // Per-station and per-node tallies from the crew.
    const stationUse = new Map<string, Record<SystemRoom, boolean> & { attention: boolean; approval: boolean; monitoringOnly: boolean }>();
    const environmentStates = new Map<string, UnitState[]>();
    const workingAt = new Set<string>(); // envId|stationKey with crew working
    let doorsOpen = false;
    const onDuty = new Set<string>(); // stations with awake crew on a live connection
    const walkers = new Map<string, CrewSprite[]>(); // stationKey → crew walking right now
    const asking: Array<{ x: number; y: number; color: number }> = []; // consoles of crew waiting on you
    for (const sprite of this.crew.values()) {
      const lay = this.layout.crew.get(sprite.key);
      if (!lay) continue;
      // Last-known state from a machine that isn't connected lights nothing: its console goes dark.
      if (sprite.offline) {
        const con = lay.console && this.stations.get(lay.stationKey)?.consoles.get(`${lay.console.x},${lay.console.y}`);
        if (con) con.texture = tex(A.CONSOLE, { screen: SCREEN_OFF });
        continue;
      }
      if (!lay.sleeping && state.envs[sprite.envId]?.connection === "live") onDuty.add(lay.stationKey);
      if (sprite.moving) walkers.set(lay.stationKey, [...(walkers.get(lay.stationKey) ?? []), sprite]);
      const u = stationUse.get(lay.stationKey) ?? { terminal: false, files: false, comms: false, attention: false, approval: false, monitoringOnly: true };
      if (sprite.atStation) {
        if (sprite.state === "monitoring") u.comms = true;
        else if (sprite.info?.workstation && sprite.info.workstation !== "console") {
          u[sprite.info.workstation] = true;
          if (sprite.info.workstation === "comms") u.monitoringOnly = false;
        }
      }
      if (sprite.state === "alert" || sprite.state === "question") {
        u.attention = true;
        if (sprite.state === "alert") u.approval = true;
        if (lay.console && !lay.sleeping && sprite.atConsole) asking.push({ ...lay.console, color: STATUS[sprite.state] });
        // A spotlight from the ceiling onto whoever is waiting on you: stage light, not another red.
        // It starts below the console screen (cy-18…cy-10; a seated crew member sits at cy+27), so
        // the ▲ or ◆ on the screen stays clean.
        if (!lay.sleeping && !sprite.offline && this.glowing) this.glow.add("spot", currentStyle().light ?? 0xe8f0f8, sprite.pos.x, sprite.pos.y - 34);
      }
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
          // A quiet turn's screen holds its last frame: scrolling text would claim work in progress.
          const shown = sprite.isQuiet ? 0 : frame;
          const grid = live ? consoleScreen(sprite.state, shown, sprite.atConsole) : A.CONSOLE;
          const next = tex(grid, { screen: live ? screenColor(sprite.state, shown, sprite.atConsole) : SCREEN_OFF });
          if (con.texture !== next) con.texture = next;
          // A team-colored tab on each console shows whose desk it is.
          g.rect(lay.console.x - 26, lay.console.y - 26, 4, 12).fill(sprite.team);
          // Someone working here: their screen throws a pool of light onto the floor, lamp-coloured
          // and only a quarter toward the screen's hue, so status colour never becomes decoration.
          if (live && sprite.atConsole && sprite.state === "working" && this.glowing) {
            this.glow.add("pool", mixColor(currentStyle().light ?? 0xe8f0f8, STATUS.working, 0.25), lay.console.x, lay.console.y + 12);
          }
        }
      }
    }

    // Unlit rooms are multiplied by the theme's own dim tone, not veiled in black.
    const shade = this.shade.clear();
    const dim = shadeColor(currentStyle().colors.F ?? 0x404040);
    // The whole fleet standing down (the last crew on duty settles): lights go out station by
    // station, bow to stern, and the sky deepens while it sleeps.
    const awake = onDuty.size > 0;
    if (this.wasAwake && !awake && !reducedMotion()) this.lightsOutAt = this.time;
    this.wasAwake = awake;
    this.backdrop?.setAsleep(!awake);
    const sternward = [...this.layout.stations.values()].sort((a, b) => a.interior.x - b.interior.x).map((s) => s.key);
    this.lampsMoving = false;
    const offline = new Set([...this.layout.stations.values()]
      .filter((s) => s.members.length && s.members.every((m) => state.envs[m.envId]?.connection !== "live")).map((s) => s.key));
    for (const s of this.layout.stations.values()) {
      const u = stationUse.get(s.key);
      // Kestrel's engines burn only while the station has crew on duty, and catch in a brownout.
      if (currentStyle().hull === "ftl") {
        const burn = onDuty.has(s.key) ? 1 : offline.has(s.key) && !reducedMotion() && hash(`${s.key}:x${frame}`) > 0.9 ? 0.5 : 0;
        if (burn) this.exhaust(g, s, burn, frame);
      }
      const bridge = s.rooms.bridge?.rect;
      const lamps: Partial<Record<RoomKind, "on" | "flicker" | "off">> = {};
      // Lighting follows observed use: the bridge while crew are on duty, a system room while
      // someone works there. Everything else (idle rooms, quarters, archive) sits in shadow.
      for (const [kind, room] of Object.entries(s.rooms) as Array<[RoomKind, StationLayout["rooms"][RoomKind]]>) {
        if (!room) continue;
        const lit = kind === "bridge" ? onDuty.has(s.key) : kind === "terminal" || kind === "files" || kind === "comms" ? !!u?.[kind] : false;
        const r = room.rect;
        // A brownout on a station whose machines have all dropped off: its lamps catch now and then.
        const flicker = !lit && kind === "bridge" && offline.has(s.key) && !reducedMotion() && hash(`${s.key}:${frame}`) > 0.86;
        // What the room's lamps look like now: its real state, through the world's switch-on and
        // the fleet's lights-out (a bridge going dark in it waits its turn, 150 ms a station).
        const outDelay = kind === "bridge" && this.lightsOutAt === this.time ? sternward.indexOf(s.key) * 0.15 : 0;
        const view = this.lampView(`${s.key}:${kind}`, lit, outDelay);
        lamps[kind] = view.on ? view.mode : flicker ? "flicker" : "off";
        // Lit rooms: the tubes and their short bloom. (Cones falling from them dithered over the
        // console screens below, whose few pixels are the state cue: the light stays up top.)
        this.ceilingLight(g, r, lamps[kind], view.color);
        if (!view.on) { shade.rect(r.x, r.y, r.w, r.h).fill(dim); continue; }
        if (kind === "bridge") continue;
        // Screen light spilling from the system's fixture into its room, dithered.
        const glow = kind === "comms" && u?.monitoringOnly ? STATUS.monitoring : STATUS.working;
        lightSpill(g, systemFixtureX(r), r.y + r.h - 30, glow);
      }
      this.litWindows(g, s, (x) => { const kind = roomUnder(s, x); return (kind && lamps[kind]) || "off"; });
      // Pastel's dome glows lamp-pink from inside while the bridge under it is lit.
      if (currentStyle().hull === "soft" && lamps.bridge === "on") {
        for (const glass of domeGlass(s)) g.rect(glass.x, glass.y, glass.w, glass.h).fill({ color: currentStyle().light ?? 0xffdcec, alpha: 0.45 });
      }
      // System screens show use, like the bridge consoles: lit and flickering while crew work
      // there, violet on comms when only background tasks are being watched, dark otherwise.
      for (const [kind, fixture] of this.stations.get(s.key)?.systems ?? []) {
        const on = !!u?.[kind];
        const screen = !on ? SCREEN_OFF : kind === "comms" && u?.monitoringOnly ? STATUS.monitoring : frame % 2 ? STATUS.working : 0x9ff0ff;
        const next = tex(on && kind === "terminal" ? terminalScreen(frame) : fixture.grid, { screen });
        if (fixture.sprite.texture !== next) fixture.sprite.texture = next;
      }
      if (bridge && u?.attention) {
        // Beacons on the roof corners, sweeping a short beam left and right: approval red when
        // anyone needs an approval, question yellow when only questions are waiting.
        const beam = u.approval ? STATUS.alert : STATUS.question;
        const dim = mixColor(beam, 0x000000, 0.55);
        const i = s.interior;
        for (const bx of [i.x + 12, i.x + i.w - 20]) {
          const by = i.y - 18;
          g.rect(bx, by, 8, 6).fill(0x101418);
          g.rect(bx + 2, by - 4, 4, 4).fill(frame % 2 ? beam : dim);
          if (!reducedMotion()) {
            const dir = frame % 4 < 2 ? -1 : 1;
            for (let k = 1; k <= 4; k++) g.rect(bx + 2 + dir * k * 6, by - 4 + (k % 2) * 2, 4, 2).fill({ color: beam, alpha: 0.5 - k * 0.1 });
          }
        }
      }
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
        // In use: the same light as the room's screen (working, or monitoring on comms), not
        // report-ready green.
        const color = on ? (kind === "comms" && u?.monitoringOnly ? STATUS.monitoring : STATUS.working) : 0x59626c;
        const x = room.rect.x + room.rect.w - 16;
        const y = room.rect.y + 8;
        pixelBox(g, x - 6, y - 2, 12, 12, 0x15191d, color);
        g.rect(x - 2, y + 2, 4, 4).fill({ color, alpha: on && frame % 2 ? 1 : 0.6 });
      }
    }


    this.doorsOpen = doorsOpen;

    // Each crew member waiting on you lights their own console: a dithered wash in their state's
    // colour over the desk below the screen, and a ring that grows in art-pixel steps around the
    // screen (cy-18…cy-10, 32 wide), never across it: the ▲ or ◆ on it is the shape cue. The roof
    // beacons say which station.
    for (const c of asking) {
      lightSpill(g, c.x, c.y - 2, c.color);
      const k = reducedMotion() ? 0.5 : (frame % 4) / 4;
      pixelOval(g, c.x, c.y - 14, 26 + k * 12, 14 + k * 6, c.color, 0.9 - k * 0.6);
    }

    // Supply lines: one per (node, station it crews); packets flow while that crew is working.
    const l = this.packets.clear();
    for (const node of this.layout.environmentNodes.values()) {
      const live = state.envs[node.envId]?.connection === "live";
      for (const link of node.links) {
        if (live && workingAt.has(`${node.envId}|${link.stationKey}`)) {
          for (let k = 0; k < 4; k++) {
            const p = linkPoint(link.from, link.to, (t * 0.3 + k / 4) % 1, link.via);
            l.rect(Math.round((p.x - 3) / 2) * 2, Math.round((p.y - 3) / 2) * 2, 6, 6).fill(node.color);
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
        // Unreachable: dimmed with an opaque grey tint, not made see-through.
        deck.setOffline(!live);
        deck.setActivity(states, live, frame, [...bayStates, ...overflow]);
      }
      const p = node.plate;
      // Reconnecting is a neutral grey, not question yellow (yellow means an agent asking you).
      const lightColor = live ? STATUS.done : env?.connection === "reconnecting" || env?.connection === "connecting" ? SIGNAL_GREY : 0x59626c;
      g.rect(p.x + p.w - 13, p.y + p.h / 2 - 4, 8, 8).fill({ color: lightColor, alpha: live || frame % 2 ? 1 : 0.4 });
      // One glyph per crew member: shape and color both carry the state. In the fleet view the
      // cells grow to three screen pixels like the stations' glyphs, on dark tiles over the deck.
      const far = this.zoom < FLEET_VIEW_ZOOM;
      const gc = far ? Math.round(3 / this.zoom) : 2, pitch = 6 * gc;
      const fit = Math.max(1, Math.min(8, Math.floor((p.w - 32) / pitch)));
      states.slice(0, fit).forEach((st, k) => {
        const x = p.x + p.w - 24 - (Math.min(fit, states.length) - k) * pitch, y = far ? p.y + p.h - 6 * gc : p.y + 5;
        if (far) g.rect(x - gc, y - gc, 7 * gc, 7 * gc).fill({ color: 0x0b0d10, alpha: 0.8 });
        for (const [cx, cy] of cells(STATUS_GLYPHS[st])) g.rect(x + cx * gc, y + cy * gc, gc, gc).fill(STATUS[st]);
      });
    }

    // Selected project: outline its station.
    if (sel && sel.kind === "building") {
      const s = this.stationFor(sel.envId, sel.projectId);
      // The hull is a chamfered box: [x+c, y, …, x, y+c]. Outline it in pixel steps.
      if (s) { const h = s.hull; chamferOutline(o, h[12], h[1], h[4] - h[12], h[9] - h[1], h[0] - h[12], SELECTION); }
    }
  }

  /**
   * Zoomed far out, stations become flat blocks of their rooms and each awake crew member a
   * status glyph laid out inside, most urgent first: the sprites would pile up and the station
   * art break apart at that scale. Glyph cells are three screen pixels at every far zoom (a
   * 15 px glyph), since this is the overview "fit" usually lands on.
   */
  private drawFleetView(state: GameState, sel: Selection): void {
    const g = this.fleetView.clear();
    const far = this.zoom < FLEET_VIEW_ZOOM;
    this.crewLayer.visible = !far;
    this.crewLabels.visible = !far;
    this.fleetLabels.visible = far;
    this.controlCenter?.setFleetView(far);
    if (!far) return;
    const c = currentStyle().colors;
    const plating = platingMaterials(state.artStyle);
    const cell = Math.round(3 / this.zoom);
    const tone: Record<RoomKind, number> = { bridge: c.f, terminal: c.p, files: c.p, comms: c.p, quarters: c.q, archive: c.F };
    const lamp = currentStyle().light ?? 0xe8f0f8;
    const highContrast = state.artStyle === "highcontrast";
    const stampInk = mapInk(state.artStyle).muted;
    const urgency: UnitState[] = ["alert", "question", "error", "done", "working", "monitoring", "idle", "sleeping"];
    // Glyphs are 5 cells on a 6-cell dark tile, packed edge to edge so a room holds as many as it can.
    const pitch = 6 * cell;
    const now = Date.now();
    const glyph = (x: number, y: number, state: UnitState, color: number, selected: boolean, waitedMs = 0, inSquad = false, onMission = false) => {
      // A dark tile under each glyph, so it reads on light floors too; white-framed when selected.
      g.rect(x - cell, y - cell, 6 * cell, 6 * cell).fill({ color: 0x0b0d10, alpha: 0.8 });
      // Someone waiting on you gets a frame in their colour that thickens with the wait: from
      // 2 minutes, thicker from 15. The rollup line under the station gives the minutes.
      // `cell` is three screen pixels: one or two of them, never a sub-pixel line that shimmers.
      if (waitedMs >= 120_000) pixelFrame(g, x - cell, y - cell, 6 * cell, 6 * cell, color, 1, Math.max(1, Math.round(cell * (waitedMs >= 900_000 ? 2 : 1) / 3)));
      if (selected) pixelFrame(g, x - cell, y - cell, 6 * cell, 6 * cell, SELECTION, 1, cell);
      // In the squad: a dashed white frame (every other cell), so a box-select shows what it caught.
      else if (inSquad) {
        for (let k = 0; k < 6; k += 2) {
          g.rect(x - cell + k * cell, y - cell, cell, cell).fill(SELECTION).rect(x - cell + (k + 1) * cell, y + 4 * cell, cell, cell).fill(SELECTION);
          g.rect(x - cell, y + (k + 1) * cell - cell, cell, cell).fill(SELECTION).rect(x + 4 * cell, y + k * cell - cell, cell, cell).fill(SELECTION);
        }
      }
      for (const [cx, cy] of cells(STATUS_GLYPHS[state])) g.rect(x + cx * cell, y + cy * cell, cell, cell).fill(color);
      // On a mission: a light pip in the tile's top-right corner.
      if (onMission) g.rect(x + 4 * cell, y - cell, cell, cell).fill(0xe8edf2);
    };
    /** Lay glyphs out in rows inside a rect; false (and nothing drawn) if they don't all fit. */
    const fill = (r: Rect, crew: CrewSprite[], force = false): boolean => {
      const cols = Math.max(1, Math.floor((r.w - cell) / pitch));
      const rows = Math.max(1, Math.floor((r.h - cell) / pitch));
      if (!force && crew.length > cols * rows) return false;
      crew.slice(0, cols * rows).forEach((sprite, k) => {
        const selected = sel?.kind === "unit" && sel.envId === sprite.envId && sel.threadId === sprite.threadId;
        const waiting = sprite.state === "alert" || sprite.state === "question";
        const waited = waiting ? now - waitingSince(sprite.thread, state.details[sprite.key]?.thread) : 0;
        glyph(r.x + 2 * cell + (k % cols) * pitch, r.y + 2 * cell + Math.floor(k / cols) * pitch, sprite.state,
          sprite.offline ? 0x59626c : STATUS[sprite.state], selected, waited, sprite.inSquad, !!sprite.mission);
      });
      return true;
    };
    const order = (a: CrewSprite, b: CrewSprite) => urgency.indexOf(a.state) - urgency.indexOf(b.state) || a.key.localeCompare(b.key);
    const byStation = new Map<string, CrewSprite[]>();
    for (const sprite of this.crew.values()) {
      const lay = this.layout.crew.get(sprite.key);
      if (!lay || lay.sleeping) continue;
      byStation.set(lay.stationKey, [...(byStation.get(lay.stationKey) ?? []), sprite]);
    }
    for (const s of this.layout.stations.values()) {
      const i = s.interior;
      const crew = (byStation.get(s.key) ?? []).sort(order);
      const byRoom = new Map<RoomKind, CrewSprite[]>();
      for (const sprite of crew) {
        const room = s.rooms[sprite.room] ? sprite.room : "bridge";
        byRoom.set(room, [...(byRoom.get(room) ?? []), sprite]);
      }
      g.rect(i.x, i.y, i.w, i.h).fill(plating.slot);
      // Night lights from orbit: rooms nobody is in go dark; a room with someone in it glows in the
      // world's lamp colour under a strip of ceiling light. A quiet fleet reads as rest, not a diagram.
      const rooms = Object.entries(s.rooms) as Array<[RoomKind, StationLayout["rooms"][RoomKind]]>;
      for (const [kind, room] of rooms) {
        if (!room) continue;
        // Last-known crew on an unreachable machine light nothing, as in the close view.
        const lit = (byRoom.get(kind) ?? []).some((c) => !c.offline);
        const r = { x: room.rect.x + cell, y: room.rect.y + cell, w: room.rect.w - 2 * cell, h: room.rect.h - 2 * cell };
        g.rect(r.x, r.y, r.w, r.h).fill({ color: tone[kind], alpha: lit ? 1 : 0.22 });
        // What the room is, as a faint stamp in its far corner: glyphs fill from the near corner,
        // so they only meet in a full room, and cover it then.
        if (r.w >= 14 * cell && r.h >= 12 * cell) {
          const sx = r.x + r.w - 9 * cell, sy = r.y + r.h - 9 * cell;
          ROOM_STAMPS[kind].forEach((row, cy) => [...row].forEach((ch, cx) => {
            if (ch === "#") g.rect(sx + cx * cell, sy + cy * cell, cell, cell).fill({ color: stampInk, alpha: lit ? 0.55 : 0.35 });
          }));
        }
        if (!lit || highContrast) continue;
        g.rect(r.x + cell, r.y, r.w - 2 * cell, cell).fill(lamp);
        for (let y = r.y + cell; y < r.y + Math.min(r.h, 6 * cell); y += cell) {
          const row = (y - r.y) / cell;
          for (let x = r.x + cell; x < r.x + r.w - cell; x += cell) {
            if (((x - r.x) / cell + row) % (row + 1) !== 0) continue;
            g.rect(x, y, cell, cell).fill({ color: lamp, alpha: 0.32 - row * 0.05 });
          }
        }
      }
      // Lit windows from orbit: every viewport on the hull's top band, a lamp-coloured light while the
      // room under it is lit and dark otherwise, at least two screen-cells wide so a row of them
      // reads as the station's signature from far away.
      if (!highContrast) {
        for (const w of hullWindows(s, currentStyle().hull ?? "industrial")) {
          const kind = roomUnder(s, w.x + w.w / 2);
          const lit = !!kind && (byRoom.get(kind) ?? []).some((c) => !c.offline);
          const ww = Math.max(w.w, 2 * cell);
          g.rect(Math.round(w.x + w.w / 2 - ww / 2), Math.round(w.y + w.h / 2 - cell / 2), ww, cell).fill(lit ? lamp : c.k);
        }
      }
      // Each glyph sits in the room its crew member is in; a station whose rooms are too small
      // for its crew at this zoom lists them all across its interior instead.
      const inRooms = [...byRoom].every(([kind, members]) => fill(s.rooms[kind]!.rect, members, false));
      if (!inRooms) {
        g.rect(i.x, i.y, i.w, i.h).fill({ color: plating.slot, alpha: 0.7 });
        fill(i, crew, true);
      }
      this.drawRollup(s, crew, now);
    }
    for (const [key, texts] of this.fleetRollups) {
      if (this.layout.stations.has(key)) continue;
      for (const text of texts) text.destroy();
      this.fleetRollups.delete(key);
    }
    // Hermes operators become glyphs in their bays, like crew (their figures hide at this scale).
    for (const { bot, workstation: r } of this.layout.controlCenter?.operators ?? []) {
      const state: UnitState = bot.observed ? bot.state : "idle";
      const selected = sel?.kind === "hermes" && sel.profile === bot.name;
      glyph(Math.round(r.x + r.w / 2 - 2.5 * cell), r.y + 8, state, bot.observed ? STATUS[state] : 0x59626c, selected);
    }
  }

  /**
   * The fleet view's one line under a station: what its crew are doing and how long the oldest has
   * waited on you, plus open PRs (with failing checks called out). Counts of what the glyphs show.
   */
  private drawRollup(s: StationLayout, crew: CrewSprite[], now: number): void {
    const { details, artStyle } = useGame.getState();
    const working = crew.filter((c) => c.state === "working").length;
    const waiting = crew.filter((c) => c.state === "alert" || c.state === "question");
    const oldest = waiting.length ? Math.max(...waiting.map((c) => now - waitingSince(c.thread, details[c.key]?.thread))) : 0;
    // The same open PRs the station's cargo pods show: every thread's, each once.
    const prs = dockedPrs(useGame.getState(), s);
    const failing = prs.filter((pr) => pr.checks === "failing").length;
    const span = (ms: number) => ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}H` : `${Math.max(1, Math.floor(ms / 60_000))}M`;
    // Each part in its own job's colour: only the waiting count is red, failing checks are the
    // failure colour, and the rest is plain ink. A station whose crew are all on unreachable
    // machines says so, and everything about it is greyed: its counts are last known.
    const ink = mapInk(artStyle);
    const offline = crew.length > 0 && crew.every((c) => c.offline);
    const parts: Array<[string, number]> = [];
    if (offline) parts.push(["NO SIGNAL · LAST KNOWN", ink.muted]);
    if (waiting.length) parts.push([`${waiting.length} WAITING ${span(oldest)}`, offline ? ink.muted : STATUS.alert]);
    if (working) parts.push([`${working} WORKING`, offline ? ink.muted : STATUS.working]);
    if (prs.length) parts.push([`${prs.length} PR${prs.length === 1 ? "" : "S"}`, ink.muted]);
    if (failing) parts.push([`${failing} FAILING`, offline ? ink.muted : STATUS.error]);
    if (parts.length === (offline ? 1 : 0)) parts.push(["QUIET", ink.muted]);
    // Two short lines rather than one long one: what the crew are doing, then the station's PRs.
    // Each fits the station's width and the room above the next station down (its nameplate):
    // parts that don't fit are dropped from the end, and lines that don't fit aren't drawn, so a
    // rollup never runs into a neighbour at any zoom.
    const crewParts = parts.length - (prs.length ? 1 : 0) - (failing ? 1 : 0);
    const texts = this.fleetRollups.get(s.key) ?? [];
    const lines = [parts.slice(0, crewParts), parts.slice(crewParts)].filter((l) => l.length);
    const top = s.interior.y + s.interior.h + 24;
    const below = [...this.layout.stations.values()]
      .filter((o) => o !== s && o.nameplate.y > s.bounds.y + s.bounds.h - 1 && o.bounds.x < s.bounds.x + s.bounds.w && o.bounds.x + o.bounds.w > s.bounds.x)
      .reduce((m, o) => Math.min(m, o.nameplate.y), Infinity);
    const right = s.interior.x + s.bounds.w;
    let k = 0, y = top;
    const gap = Math.round(3 / this.zoom);
    for (const line of lines) {
      let x = s.interior.x, lineH = 0, placed: PixelText | undefined;
      for (let j = 0; j < line.length; j++, k++) {
        const [value, color] = line[j];
        let text = texts[k];
        if (!text) { text = new PixelText(10, color); texts[k] = text; this.fleetLabels.addChild(text); }
        text.fill = color;
        text.text = j === line.length - 1 ? value : `${value} · `;
        text.scale.set(crispScale(text.unit, this.zoom));
        lineH = Math.max(lineH, text.height);
        // No room for this line above the next station: it, and anything after, isn't drawn.
        if (y + text.height > below - gap) { text.visible = false; continue; }
        if (x + text.width > right) {
          if (!placed) { fitLabel(text, value, right - x, this.zoom); }
          else {
            // Drop this part and the rest of the line; the last one placed loses its separator.
            text.visible = false;
            placed.text = placed.text.replace(/ · $/, "");
            for (j++, k++; j < line.length; j++, k++) if (texts[k]) texts[k].visible = false;
            break;
          }
        }
        text.visible = true;
        text.position.set(Math.round(x), Math.round(y));
        x += text.width;
        placed = text;
      }
      y += lineH + gap;
    }
    for (let k = parts.length; k < texts.length; k++) texts[k].visible = false;
    this.fleetRollups.set(s.key, texts);
    // A placard hanging from the station's own hull, under its lines: zoomed out, a rollup reads
    // as part of its station, not as a caption over the next station's name below it.
    const shown = texts.filter((t) => t.visible);
    if (shown.length) {
      const g = this.fleetView;
      const pad = Math.round(3 / this.zoom);
      const x0 = Math.min(...shown.map((t) => t.x)) - pad, x1 = Math.max(...shown.map((t) => t.x + t.width)) + pad;
      const y0 = s.hull[11], y1 = Math.max(...shown.map((t) => t.y + t.height)) + pad;
      g.rect(x0, y0, x1 - x0, y1 - y0).fill({ color: 0x05080c, alpha: 0.78 });
      g.rect(x0, y0, x1 - x0, Math.round(1 / this.zoom)).fill(mapInk(artStyle).line);
    }
  }

  /** Arrows on the screen edge pointing at off-screen crew who need you. */
  private drawEdgeIndicators(t: number): void {
    const g = this.edge.clear();
    const seen = new Set<string>();
    const { width, height } = this.app.screen;
    const margin = 26;
    // The visible map: inside the roster, any open panel and the top bar, so arrows never hide under
    // the HUD. Measured only when some crew member needing you is off screen.
    let view: { left: number; right: number; top: number; bottom: number } | undefined;
    for (const sprite of this.crew.values()) {
      if (sprite.state !== "alert" && sprite.state !== "question") continue;
      const sx = this.camera.x + sprite.pos.x * this.zoom;
      const sy = this.camera.y + sprite.pos.y * this.zoom;
      if (!view) {
        const inset = hudInsets();
        view = { left: inset.left + margin, right: width - inset.right - margin, top: inset.top + margin, bottom: height - inset.bottom - margin };
      }
      if (sx > view.left && sx < view.right && sy > view.top && sy < view.bottom) continue;
      const cx = (view.left + view.right) / 2;
      const cy = (view.top + view.bottom) / 2;
      const dx = sx - cx;
      const dy = sy - cy;
      const scale = Math.min((view.right - view.left) / 2 / Math.abs(dx || 1e-6), (view.bottom - view.top) / 2 / Math.abs(dy || 1e-6));
      const ex = cx + dx * scale;
      const ey = cy + dy * scale;
      const a = Math.atan2(dy, dx);
      const color = STATUS[sprite.state];
      // A pixel arrow in one of eight directions, outlined, nudging outward a cell as it pulses.
      const dir = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
      const nudge = reducedMotion() || Math.sin(t * 6) < 0 ? 0 : 3;
      pixelArrow(g, Math.round(ex + Math.cos(a) * (4 + nudge)), Math.round(ey + Math.sin(a) * (4 + nudge)), dir, color);
      g.rect(Math.round(ex - Math.cos(a) * 6) - 3, Math.round(ey - Math.sin(a) * 6) - 3, 6, 6).fill(sprite.team);
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
/** Supply-line width in world px: two art pixels, more when zoomed out so it stays about two screen pixels. */
export function linkWidth(zoom: number): number {
  return Math.max(2, Math.round(1 / zoom) * 2);
}

export { worldRef };
