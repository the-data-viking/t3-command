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
import { contextLevel, GAUGE, HUD, hudMaterials, modelTier, PROVIDER_VISOR, providerSilhouette, STATUS, type Silhouette, type Tier } from "./theme";
import { label, hash, truncate, WALK_SPEED, CREW_SPACING, BEAM_SECONDS, SPARK_MS, reducedMotion, BADGES, figureBoost, crispScale, pixelOval } from "./map-common";

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

  /** Sleepers' decorative drift doesn't keep an otherwise idle fleet rendering. */
  get animated(): boolean {
    if (reducedMotion()) return this.motion.moving;
    return this.motion.moving || this.arriving > 0 || this.state === "working" || this.state === "monitoring"
      || this.state === "alert" || this.state === "question" || !!this.info?.tasks || this.sparking();
  }

  /** Sparks fly for a minute after a failure, then it settles into a scorch mark and smoke. */
  private sparking(now = Date.now()): boolean {
    return this.state === "error" && now - this.failedAt < SPARK_MS;
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
    this.figure.alpha = this.leaving / BEAM_SECONDS;
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
      // Shift-click builds a squad for batch actions instead of opening one crew member.
      if (e.shiftKey) toggleSquad({ envId: this.envId, threadId: this.threadId });
      else setSelection({ kind: "unit", envId: this.envId, threadId: this.threadId });
    });
  }

  update(thread: ThreadShell, info: Telemetry | undefined, team: number, detail?: OrchestrationThread): void {
    this.thread = thread;
    if (detail !== this.detail) { this.detail = detail; this.quietCheckedAt = 0; }
    this.state = unitState(thread);
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

    const boost = figureBoost(zoom, PX);
    this.scale.set(boost);
    // The name stays on whole screen pixels per font pixel too.
    this.nameText.scale.set(crispScale(this.nameText.unit, zoom * boost));

    const visor = PROVIDER_VISOR[this.thread.modelSelection.instanceId] ?? 0x9fb3d1;
    if (resting) {
      this.figure.texture = tex(A.BUNK_SLEEPER, { team: this.team, visor });
      this.figure.anchor.set(0.5, 0.5);
      this.figure.scale.set(PX);
      this.badge.visible = false;
    } else {
      const working = this.state === "working" && (this.atConsole || this.atStation);
      // At a console the crew member sits in the chair, below the screen, instead of standing in front of it.
      const seated = this.atConsole && !moving;
      const legs: Legs = moving ? (frame % 2 ? "walkA" : "walkB") : seated ? "sit" : "idle";
      this.figure.y = seated ? 14 : 0;
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
    // Teleporter column, fading as they solidify.
    if (this.arriving) this.drawBeam(f, this.arriving / BEAM_SECONDS, t);
    if (sleeping) {
      const drift = (t * 0.5 + this.seed) % 1;
      f.rect(Math.round(10 + drift * 8), Math.round(-12 - drift * 14), 4, 2).fill({ color: 0xffffff, alpha: 1 - drift });
      return;
    }
    if (this.state === "error") this.drawDamage(f, t);
    this.drawTurnAge(f);
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

  /**
   * How long the current turn has run, as pips beside the head: one each past 2, 6, 12 and 24
   * hours, amber then rose. A runaway turn stands out from one that started a minute ago.
   */
  private drawTurnAge(f: Graphics): void {
    const turn = this.thread?.latestTurn;
    if (turn?.state !== "running") return;
    const hours = (Date.now() - Date.parse(turn.startedAt ?? turn.requestedAt)) / 3_600_000;
    const pips = [2, 6, 12, 24].filter((h) => hours >= h).length;
    for (let i = 0; i < pips; i++) f.rect(-20, -44 + i * 6, 3, 4).fill(hours >= 12 ? GAUGE.critical : GAUGE.high);
  }

  /** A teleporter column in the crew member's team color at strength `fade` (0–1). */
  private drawBeam(f: Graphics, fade: number, t: number): void {
    f.rect(-12, -56, 24, 58).fill({ color: this.team, alpha: 0.18 * fade });
    for (const x of [-10, -4, 2, 8]) {
      const y = -56 + ((t * 90 + x * 7 + this.seed * 50) % 52);
      f.rect(x, Math.round(y), 2, 4).fill({ color: 0xffffff, alpha: 0.8 * fade });
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
      const x = Math.round(-8 + Math.sin(drift * 6 + i) * 3);
      f.rect(x, Math.round(-48 - drift * 18), 4, 4).fill({ color: 0x8a939c, alpha: (1 - drift) * 0.55 });
    }
    if (still) return;
    const cycle = (t * 0.9 + this.seed) % 1;
    if (cycle > 0.4) return;
    const k = cycle / 0.4;
    f.rect(6, -34, 8, 8).fill({ color: 0xffd166, alpha: (1 - k) * 0.5 }); // the flash
    for (let j = 0; j < 8; j++) {
      const a = (j / 8) * Math.PI * 2 + this.seed * 6;
      const r = 4 + k * 16;
      f.rect(Math.round(10 + Math.cos(a) * r), Math.round(-30 + Math.sin(a) * r * 0.7 + k * k * 10), 3, 3)
        .fill({ color: j % 2 ? 0xffd166 : 0xffffff, alpha: 1 - k * 0.6 });
    }
  }

  private drawRing(selected: boolean, t: number, sleeping: boolean): void {
    const r = this.ring.clear();
    if (sleeping) {
      if (selected) r.rect(-26, -10, 52, 20).stroke({ color: STATUS.done, width: 2 });
      if (this.inSquad) r.rect(-29, -13, 58, 26).stroke({ color: STATUS.working, width: 2 });
      return;
    }
    // Rings are plotted in art-pixel cells. Squad members wear a second, wider cyan ring.
    if (this.inSquad) pixelOval(r, 0, 0, 20, 8, STATUS.working);
    if (selected) {
      pixelOval(r, 0, 0, 16, 6, STATUS.done);
    } else if (this.state === "alert" || this.state === "question") {
      // The pulse grows in whole art-pixel steps rather than smoothly.
      const g = Math.floor(((t * 1.1 + this.seed) % 1) * 6) / 6;
      pixelOval(r, 0, 0, 10 + g * 22, 4 + g * 8, STATUS[this.state], 1 - g);
    } else if (this.hovered) {
      pixelOval(r, 0, 0, 14, 5, 0x101418, 0.7);
    }
  }
}
