// A machine's engineering deck: host load lights, crew activity cells, disk readout.

import { Container, Graphics, Rectangle, type FederatedPointerEvent } from "pixi.js";
import { PixelText } from "./pixel-text";
import { ENGINEERING_SPOTS, FLIGHT_KIT } from "../art/flightdeck";
import { openHost, type GameState } from "../store";
import type { UnitState } from "../t3/derive";
import { nodeDrawKey, type Rect, type EnvironmentNodeLayout } from "./layout";
import { sfx } from "./sfx";
import { gesturing } from "./gesture";
import { hostView, type HostState } from "../t3/host";
import { freeLabel, storageSummary } from "../t3/storage";
import type { StorageView } from "../../shared/storage";
import { currentStyle, PX, tex } from "./textures";
import { GAUGE, HUD, STATUS } from "./theme";
import { label, truncate, sprite, hash, ROOM_SHADOW } from "./map-common";
import { worldRef } from "./world-ref";

// ---- Environment service nodes -----------------------------------------------------------------------------

/** Separate compute/engine node directly attached to a project module. */
export class EnvironmentNodeSprite {
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
  /** Damage drawn from real state: static on an unreachable machine, hazard stripes on a full disk. */
  private damage?: Graphics;
  private offline = false;
  private diskCritical = false;
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
    this.damage = new Graphics();
    // A fresh damage layer: let the updates below redraw whatever applies.
    this.offline = this.diskCritical = false;
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
    this.root.addChild(this.meters, this.cells, this.damage, this.name, this.cpuText, this.memoryText, this.caption, this.diskText, this.overflowText);
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
    // Unreachable (not just reconnecting): the deck loses signal rather than showing old numbers.
    const offline = !["live", "connecting", "reconnecting"].includes(connection);
    // Only speak up when the readings can't be trusted.
    this.caption!.text = offline ? "NO SIGNAL" : view.stale ? "STALE SAMPLE" : view.snapshot ? "" : "NO HOST METRICS";
    this.caption!.fill = offline ? GAUGE.critical : 0xa7bdcb;
    if (offline !== this.offline) { this.offline = offline; this.drawDamage(); }
    const alpha = view.stale ? 0.35 : 1;
    const g = this.meters!.clear();
    if (offline) return;
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
    const critical = disk.level === "critical" && !disk.stale;
    if (critical !== this.diskCritical) { this.diskCritical = critical; this.drawDamage(); }
  }

  /** Static, drawn once per change, so damage never keeps the render loop running. */
  private drawDamage(): void {
    const g = this.damage?.clear();
    const h = this.hull;
    if (!g || !h) return;
    const px = (x: number, y: number, color: number, alpha = 1) => g.rect(h.x + x * PX, h.y + y * PX, PX, PX).fill({ color, alpha });
    if (this.offline) {
      // Snow on the core window and the bay terminal: a fixed pattern per machine.
      for (const r of [ENGINEERING_SPOTS.coreScreen, ENGINEERING_SPOTS.bayScreen]) {
        for (let y = r.y; y < r.y + r.h; y++) {
          for (let x = r.x; x < r.x + r.w; x++) {
            const n = hash(`${this.envId}:${x},${y}`);
            if (n < 0.45) px(x, y, n < 0.15 ? 0xc9d1d9 : 0x5c6670, 0.85);
          }
        }
      }
    }
    if (this.diskCritical) {
      // Amber-and-black hazard stripes, stepped one pixel per row so they read as diagonal.
      const r = ENGINEERING_SPOTS.hazard;
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) px(r.x + x, r.y + y, (x + y) % 6 < 3 ? GAUGE.high : 0x14110d);
      }
    }
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
