import { Container, Graphics, Rectangle, Sprite, type FederatedPointerEvent } from 'pixi.js';
import { PixelText } from './pixel-text';
import { gesturing } from './gesture';
import * as A from '../art/sprites';
import { setSelection, useGame, type Selection } from '../store';
import { botColor, BOT_STATE_LABELS, HERMES_COLOR, type BotOperator } from '../t3/bots';
import type { UnitState } from '../t3/derive';
import { HALL_HEAD, type ControlCenterLayout, type Rect } from './layout';
import { GAUGE, mapInk, platingMaterials, modelTier, providerSilhouette, STATUS } from './theme';
import { crewTex, currentStyle, PX, tex } from './textures';
import { crispScale, figureBoost, fitLabel, hash, pixelDiamond, seatedPose, steppedPlate } from './map-common';

const badges: Partial<Record<UnitState, A.Grid>> = {
  alert: A.BADGE_ALERT, question: A.BADGE_QUESTION, done: A.BADGE_DONE,
  error: A.BADGE_ERROR, monitoring: A.BADGE_MONITOR,
};
interface OperatorSprite {
  bot: BotOperator;
  workstation: Rect;
  figure: Sprite;
  console: Sprite;
  badge: Sprite;
}

/** Persistent Hermes crew at their own desks, above the existing engineering chassis. */
export class ControlCenterSprite {
  readonly root = new Container();
  private labels: PixelText[] = [];
  private title?: PixelText;
  /** Operator names stay readable at fleet zoom, like the station titles. */
  private names: Array<{ label: PixelText; full: string; width: number }> = [];
  private selection = new Graphics();
  private operators: OperatorSprite[] = [];
  private holo = new Graphics();
  private hull?: Rect;

  /**
   * In the fleet view operators are drawn as glyphs by the world; their figures and badges hide.
   * The title (held at a readable size) centres over the hall, with the holo-table out of its way.
   */
  setFleetView(far: boolean): void {
    for (const { figure, badge } of this.operators) {
      figure.visible = !far;
      if (far) badge.visible = false;
    }
    this.holo.visible = !far;
    if (this.title && this.hull) {
      this.title.anchor.set(far ? 0.5 : 0, 0);
      this.title.position.set(far ? this.hull.x + this.hull.w / 2 : this.hull.x + 100, this.hull.y + 24);
    }
  }

  /** Observed bot activity wakes the demand-driven map loop; on-call bots stay still. */
  get animated(): boolean {
    return this.operators.some(({ bot }) => bot.observed
      && (bot.state === 'working' || bot.state === 'alert' || bot.state === 'question'));
  }

  build(center: ControlCenterLayout, live: boolean, endpointCount: number): void {
    for (const child of this.root.removeChildren()) child.destroy({ children: true });
    this.labels = [];
    this.names = [];
    this.operators = [];
    const { hull: h } = center;
    this.hull = h;
    const c = currentStyle().colors;
    // Dark plating in every theme (the HUD's own materials); Hermes tan is trim only, so the
    // hall never becomes the brightest thing on a light-themed map.
    const m = platingMaterials(useGame.getState().artStyle);
    const ink = mapInk(useGame.getState().artStyle);
    const g = new Graphics();
    this.root.addChild(g);
    steppedPlate(g, h.x - 4, h.y - 4, h.w + 8, h.h + 8, 44, 8, c.k);
    steppedPlate(g, h.x - 2, h.y - 2, h.w + 4, h.h + 4, 42, 8, HERMES_COLOR);
    steppedPlate(g, h.x, h.y, h.w, h.h, 40, 8, m.surface);
    steppedPlate(g, h.x + 16, h.y + 16, h.w - 32, h.h - 32, 24, 8, m.edge);
    steppedPlate(g, h.x + 18, h.y + 18, h.w - 36, h.h - 36, 22, 8, m.slot);
    // Rivets along the trim.
    for (let x = h.x + 60; x < h.x + h.w - 60; x += 48) {
      g.rect(x, h.y + 6, 4, 4).fill(m.edgeStrong);
      g.rect(x, h.y + h.h - 10, 4, 4).fill(m.edgeStrong);
    }
    // Sensor wings on the roof.
    for (const x of [h.x + 56, h.x + h.w - 56]) {
      g.rect(x - 22, h.y - 20, 44, 20).fill(c.k);
      g.rect(x - 20, h.y - 18, 40, 16).fill(m.control);
      for (let i = 0; i < 3; i++) g.rect(x - 12 + i * 10, h.y - 12, 4, 6).fill(HERMES_COLOR);
    }
    // Header band: the emblem and title, a holo-table, and the link state; the bays sit below it.
    const ex = h.x + 60, ey = h.y + 48;
    pixelDiamond(g, ex, ey, 28, c.k);
    pixelDiamond(g, ex, ey, 24, HERMES_COLOR);
    pixelDiamond(g, ex, ey, 20, m.control);
    g.rect(ex - 12, ey - 12, 4, 24).fill(HERMES_COLOR);
    g.rect(ex + 8, ey - 12, 4, 24).fill(HERMES_COLOR);
    g.rect(ex - 12, ey - 2, 24, 4).fill(HERMES_COLOR);
    this.title = this.text('HERMES', h.x + 100, h.y + 24, 28, HERMES_COLOR);
    this.text('DOCKED BRIDGE · PERSISTENT OPERATORS', h.x + 102, h.y + 58, 9, ink.muted);
    this.text(live ? 'CONNECTED' : 'OFFLINE', h.x + h.w - 150, h.y + 26, 10, live ? GAUGE.ok : ink.muted);
    this.text(`${center.operators.length} OPERATORS`, h.x + h.w - 150, h.y + 44, 9, ink.muted);
    this.text(`${endpointCount} BAYS ONLINE`, h.x + h.w - 150, h.y + 60, 9, ink.muted);
    // Holo-table between the title and the link state: a pedestal with a dithered projection, in
    // the Hermes accent (cyan would read as "working").
    const hx = h.x + Math.round((h.w + 180) / 4) * 2, hy = h.y + 66;
    const holo = this.holo = new Graphics();
    this.root.addChild(holo);
    holo.rect(hx - 24, hy - 6, 48, 10).fill(c.k);
    holo.rect(hx - 22, hy - 4, 44, 6).fill(m.control);
    holo.rect(hx - 16, hy - 6, 32, 2).fill(HERMES_COLOR);
    for (let row = 0; row < 4; row++) {
      for (let x = -14 + row * 2; x < 14 - row * 2; x += 4) {
        if (((x + 14) / 4 + row) % 2) continue;
        holo.rect(hx + x, hy - 10 - row * 4, 4, 4).fill({ color: HERMES_COLOR, alpha: 0.5 - row * 0.1 });
      }
    }
    g.rect(h.x + 30, h.y + HALL_HEAD - 8, h.w - 60, 2).fill({ color: HERMES_COLOR, alpha: 0.35 });
    // Shared services beside the bays: the memory archive and the routines console.
    const bayY = h.y + HALL_HEAD;
    this.fixture(A.FILES, h.x + 70, bayY + 34, 0.5, 0.5);
    this.centred('MEMORY', h.x + 70, bayY + 62, 9, HERMES_COLOR);
    this.centred('ARCHIVE', h.x + 70, bayY + 74, 9, HERMES_COLOR);
    this.fixture(A.COMMS, h.x + h.w - 70, bayY + 34, 0.5, 0.5);
    this.centred('ROUTINES', h.x + h.w - 70, bayY + 62, 9, HERMES_COLOR);
    if (!center.operators.length) this.centred('OPEN CONTROL CENTER TO VIEW OPERATORS', h.x + h.w / 2, bayY + 40, 12, ink.muted);
    for (const { bot, workstation: r } of center.operators) {
      const color = botColor(bot.name);
      const x = r.x + r.w / 2;
      // Each operator's bay: a well with an edge, a deck plate and the bot's colour stripe, and the
      // operator seated at their console the way bridge crew are.
      // Seated below the console the way bridge crew are, so its screen stays in view above them.
      g.rect(r.x + 8, r.y + 2, r.w - 16, 86).fill(m.edge);
      g.rect(r.x + 10, r.y + 4, r.w - 20, 82).fill(m.surface);
      g.rect(r.x + 10, r.y + 72, r.w - 20, 14).fill(c.P);
      g.rect(r.x + 12, r.y + 82, 12, 4).fill(color);
      const console = this.fixture(A.CONSOLE, x, r.y + 6, 0.5, 0);
      this.fixture(A.CHAIR, x, r.y + 84, 0.5, 1);
      const figure = new Sprite();
      figure.anchor.set(0.5, 1);
      figure.position.set(x, r.y + 76);
      const badge = new Sprite();
      badge.anchor.set(0, 1);
      badge.scale.set(PX);
      badge.position.set(x + 14, r.y + 52);
      this.root.addChild(figure, badge);
      this.operators.push({ bot, workstation: r, figure, console, badge });
      const name = this.text(bot.title.length > 18 ? bot.title.slice(0, 17) + '…' : bot.title, x, r.y + 90, 12, ink.text);
      name.anchor.set(0.5, 0);
      this.names.push({ label: name, full: bot.title, width: r.w - 12 });
      const status = this.text(bot.observed ? BOT_STATE_LABELS[bot.state].toUpperCase() : 'ON CALL · UNOBSERVED',
        x, r.y + 106, 8, bot.observed ? STATUS[bot.state] : ink.muted);
      status.anchor.set(0.5, 0);
      const hit = new Container();
      hit.eventMode = 'static'; hit.cursor = 'pointer';
      hit.hitArea = new Rectangle(r.x, r.y, r.w, r.h);
      hit.on('pointertap', (e: FederatedPointerEvent) => {
        e.stopPropagation(); if (gesturing()) return; setSelection({ kind: 'hermes', envId: bot.envId, profile: bot.name });
      });
      this.root.addChild(hit);
    }
    this.selection = new Graphics(); this.root.addChild(this.selection);
    this.root.eventMode = 'static'; this.root.cursor = 'pointer';
    this.root.hitArea = new Rectangle(h.x, h.y - 18, h.w, h.h + 18);
    this.root.removeAllListeners('pointertap');
    this.root.on('pointertap', (e: FederatedPointerEvent) => {
      e.stopPropagation(); if (gesturing()) return; setSelection({ kind: 'hermes', envId: center.envId });
    });
    // Offline: an opaque grey tint, not a see-through hall.
    this.root.tint = live ? 0xffffff : 0x6a6f76;
  }

  private fixture(grid: A.Grid, x: number, y: number, ax: number, ay: number): Sprite {
    const s = new Sprite(tex(grid));
    s.anchor.set(ax, ay); s.scale.set(PX); s.position.set(x, y);
    this.root.addChild(s); return s;
  }

  private centred(value: string, x: number, y: number, size: number, color: number): PixelText {
    const t = this.text(value, x, y, size, color);
    t.anchor.set(0.5, 0); return t;
  }

  private text(value: string, x: number, y: number, size: number, color: number): PixelText {
    const t = new PixelText(size, color);
    t.text = value; t.position.set(x, y); this.root.addChild(t); this.labels.push(t); return t;
  }

  update(center: ControlCenterLayout, selection: Selection, zoom: number, frame: number): void {
    // Small bridge text hides once it would turn sub-pixel; the title holds a crisp minimum size.
    for (const label of this.labels) label.visible = label === this.title || this.names.some((n) => n.label === label) || label.unit * zoom >= 0.8;
    if (this.title) this.title.scale.set(crispScale(this.title.unit, zoom));
    // Names fit their own bay at any zoom, so neighbours never run together ("DEFAULMONEY GUY").
    for (const name of this.names) fitLabel(name.label, name.full, name.width, zoom);
    for (const { bot, figure, console, badge, workstation } of this.operators) {
      const color = botColor(bot.name);
      // Operators sit like bridge crew: typing, a hand up when they need you, leaning back with a report.
      const pose = seatedPose(bot.observed ? bot.state : 'idle', frame, frame / 5, hash(bot.name));
      figure.texture = crewTex(providerSilhouette(bot.provider ?? 'hermes'), modelTier(bot.model ?? ''),
        'behind', pose.arms, color, HERMES_COLOR, pose.head);
      figure.scale.set(PX * figureBoost(zoom, PX));
      const screen = bot.observed && bot.state !== 'idle' ? STATUS[bot.state] : 0x1c2228;
      console.texture = tex(A.CONSOLE, { screen });
      const grid = bot.observed ? badges[bot.state] : undefined;
      badge.visible = !!grid && figure.visible; // Hidden with the figure in the fleet view.
      if (grid) {
        // Status-filled, like crew badges on the map and pills in the HUD.
        badge.texture = tex(grid, { visor: STATUS[bot.state] });
        const bob = bot.state === 'alert' || bot.state === 'question' ? (frame % 2) * PX : 0;
        badge.y = workstation.y + 52 - bob;
      }
    }
    const g = this.selection.clear();
    let r: Rect | undefined;
    if (selection?.kind === 'hermes' && center.envIds.includes(selection.envId)) {
      r = center.operators.find(o => o.bot.name === selection.profile)?.workstation ?? center.hull;
    } else if (selection?.kind === 'unit') {
      r = center.operators.find(o => o.bot.sessions.some(s => s.envId === selection.envId && s.thread.id === selection.threadId))?.workstation;
    }
    if (r) {
      // Selection: corner brackets on the art grid.
      const x0 = r.x - 4, y0 = r.y - 4, x1 = r.x + r.w + 4, y1 = r.y + r.h + 4, L = 16;
      for (const [x, y, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]] as const) {
        g.rect(dx > 0 ? x : x - L, dy > 0 ? y : y - 4, L, 4).fill(HERMES_COLOR);
        g.rect(dx > 0 ? x : x - 4, dy > 0 ? y : y - L, 4, L).fill(HERMES_COLOR);
      }
    }
  }

  destroy(): void { this.root.destroy({ children: true }); }
}
