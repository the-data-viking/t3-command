// A crew member on the map: one thread, drawn as a suited figure walking between rooms.

import { Container, Graphics, Rectangle, Sprite, type FederatedPointerEvent } from "pixi.js";
import * as A from "../art/sprites";
import type { Arms, Legs } from "../art/render";
import { setSelection, toggleSquad, useGame } from "../store";
import { unitState, type UnitState } from "../t3/derive";
import type { Telemetry } from "../t3/telemetry";
import type { OrchestrationThread, ThreadShell } from "../t3/types";
import type { CrewLayout, Point, Rect, RoomKind, StationLayout, SystemRoom } from "./layout";
import { sfx } from "./sfx";
import { gesturing } from "./gesture";
import { CrewMotion } from "./crew-motion";
import { quietness } from "../t3/progress";
import { crewTex, PX, tex } from "./textures";
import { contextLevel, DEFAULT_VISOR, GAUGE, HUD, hudMaterials, mapInk, modelTier, PROVIDER_VISOR, providerSilhouette, SELECTION, STATUS, type Silhouette, type Tier } from "./theme";
import { label, hash, truncate, WALK_SPEED, CREW_SPACING, BEAM_SECONDS, SPARK_MS, reducedMotion, BADGES, figureBoost, crispScale, pixelFrame, pixelOval, REPORT_MS } from "./map-common";

/** Round a local coordinate to the art grid (PX world px), so effects sit on the sprite's pixels. */
const snap = (v: number) => Math.round(v / PX) * PX;

/** Four-frame walk: stride, passing, the other stride, passing. */
const WALK: Legs[] = ["walkA", "walkB", "walkC", "walkB"];

/** 4×4 ordered dither: the order art pixels appear in as a crew member beams in. */
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

// ---- Crew ------------------------------------------------------------------------------

export class CrewSprite extends Container {
  readonly key: string;
  readonly envId: string;
  readonly threadId: string;
  private seed: number;
  private ring = new Graphics();
  private figure = new Sprite();
  private badge = new Sprite();
  private fx = new Graphics();
  /** Mask that reveals the figure pixel by pixel while beaming in or out. */
  private reveal = new Graphics();
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
  /** Picked for batch actions; set by the World each frame. */
  inSquad = false;
  /**
   * How far the head sits below its standing height (seated crew drop 14 px). Every overlay over
   * the head (badge, spinner, pips) moves with it, so none lands on the console behind them.
   */
  private lift = 0;
  /** Their machine isn't connected, so what they show is last known; set by the World each frame. */
  offline = false;
  /**
   * Holds the name label. The World keeps it in a layer above all crew, so a neighbour standing
   * in front never covers it; it follows this sprite's position and scale every tick.
   */
  readonly labelLayer = new Container();
  /** At their own console (vs. walking, at a system room, or in quarters). */
  atConsole = true;
  /** At the system room their current work needs. */
  atStation = false;
  /** Seconds left of a recruitment beam-in. */
  private arriving = 0;
  /** Seconds left of a beam-out (thread archived or removed); the World removes the sprite after. */
  private leaving = 0;
  /** When the last turn failed, for the burst of sparks right after. */
  private failedAt = 0;
  /** When this crew member finished a job (working → done), for the report-ready sparkle. */
  private reportAt = 0;

  /** Sleepers' decorative drift doesn't keep an otherwise idle fleet rendering. */
  get animated(): boolean {
    if (reducedMotion()) return this.motion.moving;
    return this.motion.moving || this.arriving > 0 || this.state === "working" || this.state === "monitoring"
      || this.state === "alert" || this.state === "question" || !!this.info?.tasks || this.sparking() || this.celebrating();
  }

  /** Sparks fly for a minute after a failure, then it settles into a scorch mark and smoke. */
  private sparking(now = Date.now()): boolean {
    return this.state === "error" && now - this.failedAt < SPARK_MS;
  }

  private celebrating(now = performance.now()): boolean {
    return now - this.reportAt < REPORT_MS;
  }

  /** Dematerialize; returns false if there's nothing to animate (reduced motion). */
  beamOut(): boolean {
    if (reducedMotion()) return false;
    this.leaving = BEAM_SECONDS;
    this.eventMode = "none";
    return true;
  }

  /** One frame of a beam-out; false once it's finished. */
  departTick(t: number, dt: number): boolean {
    this.leaving = Math.max(0, this.leaving - dt);
    this.figure.alpha = 1;
    this.drawReveal(this.leaving / BEAM_SECONDS);
    this.badge.visible = false;
    this.nameText.visible = false;
    this.ring.clear();
    this.drawBeam(this.fx.clear(), 1 - this.leaving / BEAM_SECONDS, t);
    return this.leaving > 0;
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
    this.addChild(this.ring, this.figure, this.reveal, this.badge, this.fx);
    this.labelLayer.addChild(this.nameText);
    this.eventMode = "static";
    this.cursor = "pointer";
    this.hitArea = new Rectangle(-16, -44, 32, 48);
    this.on("pointerover", () => (this.hovered = true));
    this.on("pointerout", () => (this.hovered = false));
    this.on("pointertap", (e: FederatedPointerEvent) => {
      e.stopPropagation();
      if (gesturing()) return;
      sfx.select();
      // Shift-click builds a squad for batch actions instead of opening one crew member.
      if (e.shiftKey) toggleSquad({ envId: this.envId, threadId: this.threadId });
      else setSelection({ kind: "unit", envId: this.envId, threadId: this.threadId });
    });
  }

  update(thread: ThreadShell, info: Telemetry | undefined, team: number, detail?: OrchestrationThread): void {
    this.thread = thread;
    if (detail !== this.detail) { this.detail = detail; this.quietCheckedAt = 0; }
    const before = this.state;
    this.state = unitState(thread);
    if (this.state === "done" && (before === "working" || before === "monitoring") && this.thread) this.reportAt = performance.now();
    if (this.state === "error") {
      const at = Date.parse(thread.latestTurn?.completedAt ?? thread.session?.updatedAt ?? "");
      this.failedAt = Number.isFinite(at) ? at : 0;
    }
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
      // Crew sharing a room line up side by side from the fixture, instead of on one spot.
      const spacing = Math.min(CREW_SPACING, (r.x + r.w - 12 - spot.x) / Math.max(1, this.slot.count - 1 || 1));
      const x = spot.x + this.slot.index * spacing;
      return { room: system, point: { x: Math.round(Math.max(r.x + 12, Math.min(r.x + r.w - 12, x))), y: spot.y } };
    }
    return { room: "bridge", point: layout.home };
  }

  /** World-space box of the name label, when shown. */
  labelBox(): Rect | undefined {
    if (!this.nameText.visible) return undefined;
    // The label's real size: crew scale × its own crisp scale.
    const k = this.scale.x * this.nameText.scale.x;
    const w = this.nameText.naturalWidth * k;
    return { x: this.position.x - w / 2, y: this.position.y + 6 * this.scale.x, w, h: 9 * this.nameText.unit * k };
  }

  /** Push the name label down by `dy` world px to clear a neighbor's. */
  setLabelOffset(dy: number): void {
    this.nameText.y = 6 + dy / this.scale.x;
  }

  tick(layout: CrewLayout, s: StationLayout, t: number, dt: number, frame: number, selected: boolean, zoom: number, labelZoom = zoom): void {
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

    const boost = figureBoost(zoom, PX);
    this.scale.set(boost);
    // The name stays on whole screen pixels per font pixel too.
    this.nameText.fill = mapInk(useGame.getState().artStyle).text;
    this.nameText.scale.set(crispScale(this.nameText.unit, labelZoom * figureBoost(labelZoom, PX)) * (figureBoost(labelZoom, PX) / boost));

    const visor = PROVIDER_VISOR[this.thread.modelSelection.instanceId] ?? DEFAULT_VISOR;
    if (resting) {
      this.figure.texture = tex(A.BUNK_SLEEPER, { team: this.team, visor });
      this.figure.anchor.set(0.5, 0.5);
      this.figure.scale.set(PX);
      this.badge.visible = false;
    } else {
      const working = this.state === "working" && !this.offline && (this.atConsole || this.atStation);
      // At a console the crew member sits in the chair, below the screen, instead of standing in front of it.
      const seated = this.atConsole && !moving;
      const legs: Legs = moving ? WALK[Math.floor(t * 8) % 4] : seated ? "sit" : "idle";
      // Seated below the screen; walking, the body rises an art pixel as the legs pass.
      this.figure.y = seated ? 14 : moving && legs === "walkB" ? -PX : 0;
      this.lift = seated ? 14 : 0;
      const arms: Arms = working ? (frame % 2 ? "typeA" : "typeB") : "idle";
      this.figure.texture = crewTex(this.silhouette, this.tier, legs, arms, this.team, visor);
      this.figure.anchor.set(0.5, 1);
      // At a system they face its fixture, which stands to their left.
      this.figure.scale.set(PX * (this.atStation && !moving ? -1 : this.motion.facing), PX);
      // Offline: greyed out, as last seen.
      this.figure.tint = this.offline ? 0x8a919a : 0xffffff;
      const badge = BADGES[this.state];
      this.badge.visible = !!badge;
      if (badge) {
        // Badges are drawn in their status colour (the V cells), the same one the HUD uses.
        this.badge.texture = tex(badge, { visor: STATUS[this.state] });
        const bob = this.state === "alert" || this.state === "question" ? (frame % 2) * PX : 0;
        // Beside the head: seated, it moves right and down with it, off the console screen.
        this.badge.position.set(this.lift ? 14 : 8, -40 + this.lift - bob);
        this.badge.alpha = this.offline ? 0.5 : 1;
      }
    }

    this.arriving = Math.max(0, this.arriving - dt);
    this.figure.alpha = this.offline ? 0.7 : 1;
    this.drawReveal(this.arriving ? 1 - this.arriving / BEAM_SECONDS : 1);
    this.drawFx(t, selected, zoom, resting);
    this.drawRing(selected, t, resting);
    this.nameText.visible = !resting && (selected || this.hovered || zoom > 1.7);
    this.syncLabel();
  }

  /** Keep the label layer on this sprite: same position and scale, shown while the sprite is. */
  syncLabel(): void {
    this.labelLayer.position.copyFrom(this.position);
    this.labelLayer.scale.copyFrom(this.scale);
    this.labelLayer.visible = this.visible;
  }

  override destroy(options?: Parameters<Container["destroy"]>[0]): void {
    this.labelLayer.destroy({ children: true });
    super.destroy(options);
  }

  private drawFx(t: number, selected: boolean, zoom: number, sleeping: boolean): void {
    const f = this.fx.clear();
    // Teleporter column, fading as they solidify.
    if (this.arriving) this.drawBeam(f, this.arriving / BEAM_SECONDS, t);
    if (sleeping) {
      const drift = (t * 0.5 + this.seed) % 1;
      f.rect(snap(10 + drift * 8), snap(-12 - drift * 14), 4, 2).fill({ color: 0xffffff, alpha: 1 - drift });
      return;
    }
    if (this.offline) {
      // No signal: a flickering block of static where the status effects would be. Nothing they
      // show is live, so no spinner, drones or plan pips.
      for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
        if ((x + y + (reducedMotion() ? 0 : Math.floor(t * 6))) % 2) f.rect(10 + x * 2, -44 + this.lift + y * 2, 2, 2).fill(0x8a919a);
      }
      return;
    }
    if (this.state === "error") this.drawDamage(f, t);
    if (this.celebrating() && !reducedMotion()) this.drawReport(f);
    this.drawTurnAge(f);
    if (this.state === "working") {
      // Re-checked every few seconds rather than per frame: it scans the turn's activity.
      const now = Date.now();
      if (this.detail && now - this.quietCheckedAt > 5000) {
        this.quietCheckedAt = now;
        this.quiet = quietness(this.thread, this.detail, now)?.kind === "quiet";
      }
      if (this.quiet) {
        // Quiet turn: three steady grey dots where the busy pip spins (not a status or gauge colour).
        for (const x of [8, 12, 16]) f.rect(x, -40 + this.lift, 2, 2).fill(mapInk(useGame.getState().artStyle).muted);
      } else {
        // Spinning pip: busy, no attention needed.
        const a = Math.floor(t * 8) % 4;
        const pts = [[0, -2], [2, 0], [0, 2], [-2, 0]];
        // Ringed in outline so it reads on a lit screen of the same colour.
        f.rect(8, -44 + this.lift, 10, 10).fill(0x101418);
        pts.forEach(([x, y], i) => f.rect(12 + x, -40 + this.lift + y, 2, 2).fill({ color: i === a ? STATUS.working : 0x1d4a57 }));
      }
      // Plan pips over the head: done, current (blinking), still to do.
      const plan = this.thread.planProgress;
      if (plan && plan.totalSteps > 0) {
        const n = Math.min(plan.totalSteps, 10);
        const done = Math.round((plan.completedSteps / plan.totalSteps) * n);
        const x0 = -n * 2;
        for (let i = 0; i < n; i++) {
          const color = i < done ? STATUS.done : i === done ? (Math.floor(t * 2) % 2 ? STATUS.working : 0x1d4a57) : hudMaterials(useGame.getState().artStyle).meter;
          f.rect(x0 + i * 4, -50 + this.lift, 2, 2).fill(color);
        }
      }
    }
    // Background-task drones, in the monitoring violet the help legend shows.
    const tasks = Math.min(4, this.info?.tasks ?? 0);
    for (let i = 0; i < tasks; i++) {
      const a = t * 2.2 + (i / tasks) * Math.PI * 2;
      const x = snap(Math.cos(a) * 18 - 2), y = snap(-22 + Math.sin(a) * 7 - 2);
      f.rect(x, y + 2, 4, 2).fill(0x101418);
      f.rect(x, y, 4, 2).fill(STATUS.monitoring);
    }
    const ctx = this.info?.context;
    if (ctx !== undefined && (selected || this.hovered || zoom > 1.3)) {
      const left = 1 - ctx;
      const color = GAUGE[contextLevel(ctx)];
      for (let i = 0; i < 8; i++) f.rect(-16 + i * 4, 4, 2, 4).fill(i / 8 < left ? color : hudMaterials(useGame.getState().artStyle).meter);
    }
  }

  /**
   * How long the current turn has run, as pips beside the head: one each past 2, 6, 12 and 24
   * hours, amber then magenta. A runaway turn stands out from one that started a minute ago.
   */
  private drawTurnAge(f: Graphics): void {
    const turn = this.thread?.latestTurn;
    if (turn?.state !== "running") return;
    const hours = (Date.now() - Date.parse(turn.startedAt ?? turn.requestedAt)) / 3_600_000;
    const pips = [2, 6, 12, 24].filter((h) => hours >= h).length;
    for (let i = 0; i < pips; i++) f.rect(-20, -44 + this.lift + i * 6, 2, 4).fill(hours >= 12 ? GAUGE.critical : GAUGE.high);
  }

  /**
   * Job's done: a short burst of pixel confetti rising from the crew member in the "done" green,
   * white and their team colour, over 1.6 seconds.
   */
  private drawReport(f: Graphics): void {
    const k = (performance.now() - this.reportAt) / REPORT_MS;
    const colors = [STATUS.done, 0xffffff, this.team];
    for (let j = 0; j < 10; j++) {
      const lane = hash(`${this.key}${j}`);
      const x = Math.round((-18 + lane * 36) / 2) * 2;
      const rise = (k * (40 + lane * 24)) | 0;
      const y = Math.round((-30 - rise + Math.sin(k * 8 + j) * 3) / 2) * 2;
      if ((j + Math.floor(k * 12)) % 3 === 0) continue; // Twinkle.
      f.rect(x, y, 2, 2).fill({ color: colors[j % 3], alpha: 1 - k });
    }
  }

  /**
   * Show `progress` (0–1) of the figure's art pixels, in ordered-dither order, so a beam-in
   * resolves pixel by pixel instead of fading in translucent. At 1 the mask comes off.
   */
  private drawReveal(progress: number): void {
    const r = this.reveal.clear();
    if (progress >= 1) {
      if (this.figure.mask) this.figure.mask = null;
      return;
    }
    for (let y = -50; y < 22; y += PX) {
      for (let x = -18; x < 18; x += PX) {
        if ((BAYER[(y / PX) & 3][(x / PX) & 3] + 0.5) / 16 < progress) r.rect(x, y, PX, PX).fill(0xffffff);
      }
    }
    this.figure.mask = r;
  }

  /** A teleporter column in the crew member's team color at strength `fade` (0–1). */
  private drawBeam(f: Graphics, fade: number, t: number): void {
    f.rect(-12, -56, 24, 58).fill({ color: this.team, alpha: 0.18 * fade });
    for (const x of [-10, -4, 2, 8]) {
      const y = -56 + ((t * 90 + x * 7 + this.seed * 50) % 52);
      f.rect(x, snap(y), 2, 4).fill({ color: 0xffffff, alpha: 0.8 * fade });
    }
    f.rect(-14, -2, 28, 4).fill({ color: this.team, alpha: 0.6 * fade });
  }

  /**
   * A failed turn: sparks burst from the crew member's kit for a minute, then a scorch mark and a
   * wisp of smoke stay until the thread moves on. Under reduced motion only the scorch and smoke.
   */
  private drawDamage(f: Graphics, t: number): void {
    f.rect(-12, -2, 24, 3).fill({ color: 0x0b0d0f, alpha: 0.5 });
    const still = reducedMotion() || !this.sparking();
    for (let i = 0; i < 3; i++) {
      const drift = still ? i / 3 : (t * 0.35 + i / 3 + this.seed) % 1;
      const x = snap(-8 + Math.sin(drift * 6 + i) * 3);
      f.rect(x, snap(-48 - drift * 18), 4, 4).fill({ color: 0x8a939c, alpha: (1 - drift) * 0.55 });
    }
    if (still) return;
    const cycle = (t * 0.9 + this.seed) % 1;
    if (cycle > 0.4) return;
    const k = cycle / 0.4;
    f.rect(6, -34, 8, 8).fill({ color: 0xffd166, alpha: (1 - k) * 0.5 }); // the flash
    for (let j = 0; j < 8; j++) {
      const a = (j / 8) * Math.PI * 2 + this.seed * 6;
      const r = 4 + k * 16;
      f.rect(snap(10 + Math.cos(a) * r), snap(-30 + Math.sin(a) * r * 0.7 + k * k * 10), 2, 2)
        .fill({ color: j % 2 ? 0xffd166 : 0xffffff, alpha: 1 - k * 0.6 });
    }
  }

  private drawRing(selected: boolean, t: number, sleeping: boolean): void {
    const r = this.ring.clear();
    if (sleeping) {
      if (selected) pixelFrame(r, -26, -10, 52, 20, SELECTION);
      if (this.inSquad) pixelFrame(r, -30, -14, 60, 28, SELECTION, 0.5);
      return;
    }
    // Rings are plotted in art-pixel cells, in white so they never read as a status. Squad
    // members wear a second, wider and dimmer ring.
    if (this.inSquad) pixelOval(r, 0, 0, 20, 8, SELECTION, 0.5);
    if (selected) {
      pixelOval(r, 0, 0, 16, 6, SELECTION);
    } else if (!this.offline && !this.atConsole && (this.state === "alert" || this.state === "question")) {
      // Away from their console (seated, the console pulses instead: one ask ring, not two).
      // The pulse grows in whole art-pixel steps rather than smoothly.
      const g = Math.floor(((t * 1.1 + this.seed) % 1) * 6) / 6;
      pixelOval(r, 0, 0, 10 + g * 22, 4 + g * 8, STATUS[this.state], 1 - g);
    } else if (this.hovered) {
      pixelOval(r, 0, 0, 14, 5, 0x101418, 0.7);
    }
  }
}
