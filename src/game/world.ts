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
import { computeFleetLayout, fingerprint, type CrewLayout, type FleetLayout, type Point, type Rect, type RoomKind, type StationLayout, type SystemRoom } from "./layout";
import { sfx } from "./sfx";
import { PixelText } from "./pixel-text";
import { endGesture, gesturing, holdTaps } from "./gesture";
import { isPhone } from "../ui/phone";
import { hudInsets } from "../ui/hud-insets";
import { doorState } from "./crew-motion";
import { RenderLoop } from "./render-loop";
import { Backdrop } from "./backdrop";
import { ControlCenterSprite } from "./control-center";
import { HERMES_COLOR } from "../t3/bots";
import { currentStyle, tex } from "./textures";
import { HUD, STATUS, platingMaterials } from "./theme";
import { crispScale, floorZoom, snapZoom, label, linkPoint, CAMERA_SECONDS, FADE_SECONDS, RECRUIT_WINDOW_MS, clampZoom, DOOR_ART, reducedMotion, SCREEN_OFF, screenColor, lightSpill, shadeColor, steppedPlate } from "./map-common";
import { worldRef } from "./world-ref";
import { CrewSprite } from "./crew-sprite";
import { StationSprite } from "./station-sprite";
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

export class World {
  private app = new Application();
  private backdrop?: Backdrop;
  private camera = new Container();
  private grid = new Graphics();
  private operations = new Container();
  private links = new Graphics();
  private packets = new Graphics();
  private stationLayer = new Container();
  private environmentLayer = new Container();
  private lights = new Graphics();
  /** Unlit rooms, multiplied by a theme-tinted dim tone. */
  private shade = Object.assign(new Graphics(), { blendMode: "multiply" as const });
  private crewLayer = new Container();
  private overlay = new Graphics();
  private edge = new Graphics();
  private edgeHits = new Container();
  private stations = new Map<string, StationSprite>();
  private environmentNodes = new Map<string, EnvironmentNodeSprite>();
  private controlCenter?: ControlCenterSprite;
  private lastCatalog?: GameState["hermesCatalog"];
  private crew = new Map<string, CrewSprite>();
  /** Continuous zoom the wheel/pinch is aiming for; the drawn zoom is its nearest crisp step. */
  private zoomGoal?: number;
  /** Screen-space rectangle of an in-progress shift-drag selection. */
  private selectBox?: Rect;
  /** The operations hub's labels: the title held crisp when zoomed out, the count hidden. */
  private opsLabels?: { title: PixelText; count: PixelText };
  /** Crew beaming out after their thread was archived or removed. */
  private departing = new Set<CrewSprite>();
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
    this.camera.addChild(this.grid, this.operations, this.links, this.packets, this.stationLayer, this.environmentLayer, this.shade, this.lights, this.crewLayer, this.overlay);
    this.app.stage.addChild(this.backdrop.root, this.camera, this.edge, this.edgeHits);
    this.setupCamera();

    this.renderLoop = new RenderLoop((dt) => {
      this.sync(useGame.getState());
      const animated = this.tick(dt);
      this.app.render();
      return animated;
    });
    this.unsubscribe = useGame.subscribe((s, prev) => {
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
      const margin = isPhone() ? 40 : 80;
      const z = floorZoom(clampZoom(Math.min(maxZoom, Math.min(area.w / (rect.w + margin), area.h / (rect.h + margin)))));
      this.moveCamera(area.x + area.w / 2 - (rect.x + rect.w / 2) * z, area.y + area.h / 2 - (rect.y + rect.h / 2) * z, z, this.framed);
      this.framed = true;
    });
  }

  fitAll(): void {
    if (!this.initialized) return;
    this.frame(this.layout.bounds, 1.2);
  }

  focusRect(rect: Rect): void {
    if (!this.initialized) return;
    this.userMoved = true;
    this.frame(rect, 2);
  }

  private focusControlCenter(): void {
    const center = this.layout.controlCenter;
    if (!center || !this.initialized) return;
    this.userMoved = true;
    this.frame(center.bounds, 1.4);
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
      const z = clampZoom(Math.max(this.zoom, 2));
      this.moveCamera(area.x + area.w / 2 - target.x * z, area.y + area.h / 2 + 20 - target.y * z, z);
    });
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
      this.crew.delete(key);
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
      const title=label(12,0xc9e1e8);title.text='OPERATIONS';title.position.set(hub.x+18,hub.y+22);this.operations.addChild(title);
      const count=label(8,0x7eaaa8);count.text=`${this.layout.stations.size} PROJECT MODULES`;count.position.set(hub.x+18,hub.y+48);this.operations.addChild(count);
      this.opsLabels = { title, count };
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
        if (live || state.envs[node.envId]?.connection === "connecting" || state.envs[node.envId]?.connection === "reconnecting") {
          g.poly(points, false).stroke({ color: node.color, width: 5, alpha: live ? 0.1 : 0.04 });
          g.poly(points, false).stroke({ color: node.color, width: 2, alpha: live ? 0.6 : 0.15 });
          continue;
        }
        // Unreachable machine: the supply line is severed, drawn as broken dashes.
        for (let k = 0; k + 2 < points.length / 2; k += 3) g.moveTo(points[k * 2], points[k * 2 + 1]).lineTo(points[k * 2 + 2], points[k * 2 + 3]);
        g.stroke({ color: node.color, width: 2, alpha: 0.25 });
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
    const squad = new Set(state.squad.map((m) => unitKey(m.envId, m.threadId)));
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
      sprite.tick(lay, s, t, dt, frame, selected, this.zoom);
    }
    for (const sprite of this.departing) {
      if (sprite.departTick(t, dt)) continue;
      this.departing.delete(sprite);
      sprite.destroy({ children: true });
    }
    this.separateLabels();
    this.drawLights(state, sel, t, frame);
    if (this.layout.controlCenter) this.controlCenter?.update(this.layout.controlCenter, sel, this.zoom, frame);
    for (const station of this.stations.values()) station.setZoom(this.zoom);
    for (const node of this.environmentNodes.values()) node.setZoom(this.zoom);
    if (this.opsLabels && !this.opsLabels.title.destroyed) {
      this.opsLabels.title.scale.set(crispScale(this.opsLabels.title.unit, this.zoom));
      this.opsLabels.count.visible = this.opsLabels.count.unit * this.zoom >= 0.8;
    }
    this.drawEdgeIndicators(t);
    for (const text of PixelText.live) text.snapToPixels();
    if (this.selectBox) {
      const b = this.selectBox;
      this.edge.rect(b.x, b.y, b.w, b.h).fill({ color: STATUS.working, alpha: 0.08 }).stroke({ color: STATUS.working, width: 1, alpha: 0.9 });
    }
    if (still) return panning || !!this.fade || this.doorsOpen || this.departing.size > 0 || [...this.crew.values()].some((crew) => crew.animated);
    return panning || !!this.fade || this.doorsOpen || this.departing.size > 0 || !!this.controlCenter?.animated || [...this.crew.values()].some((crew) => crew.animated)
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

    // Unlit rooms are multiplied by the theme's own dim tone, not veiled in black.
    const shade = this.shade.clear();
    const dim = shadeColor(currentStyle().colors.F ?? 0x404040);
    for (const s of this.layout.stations.values()) {
      const u = stationUse.get(s.key);
      const bridge = s.rooms.bridge?.rect;
      // Lighting follows observed use: the bridge while crew are on duty, a system room while
      // someone works there. Everything else (idle rooms, quarters, archive) sits in shadow.
      for (const [kind, room] of Object.entries(s.rooms) as Array<[RoomKind, StationLayout["rooms"][RoomKind]]>) {
        if (!room) continue;
        const lit = kind === "bridge" ? onDuty.has(s.key) : kind === "terminal" || kind === "files" || kind === "comms" ? !!u?.[kind] : false;
        const r = room.rect;
        if (!lit) { shade.rect(r.x, r.y, r.w, r.h).fill(dim); continue; }
        if (kind === "bridge") continue;
        // Screen light spilling from the system's fixture into its room, dithered.
        const glow = kind === "comms" && u?.monitoringOnly ? STATUS.monitoring : STATUS.working;
        lightSpill(g, r.x + r.w * 0.3, r.y + r.h - 30, glow);
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
export { worldRef };
