import { Container, Graphics, Rectangle, Sprite, type FederatedPointerEvent } from 'pixi.js';
import { PixelText } from './pixel-text';
import { gesturing } from './gesture';
import * as A from '../art/sprites';
import { setSelection, useGame, type Selection } from '../store';
import { botColor, BOT_STATE_LABELS, HERMES_COLOR, type BotOperator } from '../t3/bots';
import type { UnitState } from '../t3/derive';
import type { ControlCenterLayout, Rect } from './layout';
import { HUD, hudMaterials, modelTier, providerSilhouette, STATUS } from './theme';
import { crewTex, currentStyle, PX, tex } from './textures';
import { crispScale, figureBoost, fitLabel, pixelDiamond, steppedPlate } from './map-common';

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
    const c = currentStyle().colors;
    // Dark plating in every theme (the HUD's own materials); Hermes tan is trim only, so the
    // hall never becomes the brightest thing on a light-themed map.
    const m = hudMaterials(useGame.getState().artStyle);
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
    // Command emblem: a pixel diamond with the H.
    const ex = h.x + 76, ey = h.y + 68;
    pixelDiamond(g, ex, ey, 28, c.k);
    pixelDiamond(g, ex, ey, 24, HERMES_COLOR);
    pixelDiamond(g, ex, ey, 20, m.control);
    g.rect(ex - 12, ey - 12, 4, 24).fill(HERMES_COLOR);
    g.rect(ex + 8, ey - 12, 4, 24).fill(HERMES_COLOR);
    g.rect(ex - 12, ey - 2, 24, 4).fill(HERMES_COLOR);
    this.title = this.text('HERMES', h.x + 122, h.y + 28, 28, HERMES_COLOR);
    this.text('DOCKED BRIDGE', h.x + 124, h.y + 63, 12, HUD.text);
    this.text('PERSISTENT OPERATORS / SHARED ENGINEERING', h.x + 124, h.y + 88, 9, HUD.muted);
    this.text(live ? 'CONNECTED' : 'OFFLINE', h.x + h.w - 155, h.y + 35, 10, live ? 0x9bc9c2 : HUD.muted);
    this.text(`${center.operators.length} OPERATORS`, h.x + h.w - 155, h.y + 55, 9, HUD.muted);
    this.text(`${endpointCount} BAYS ONLINE`, h.x + h.w - 155, h.y + 74, 9, HUD.muted);
    g.rect(h.x + 30, h.y + 112, h.w - 60, 2).fill({ color: HERMES_COLOR, alpha: 0.35 });
    if (!center.operators.length) this.text('OPEN CONTROL CENTER TO VIEW OPERATORS', h.x + 150, h.y + 180, 12, HUD.muted);
    for (const { bot, workstation: r } of center.operators) {
      const color = botColor(bot.name);
      const x = r.x + r.w / 2;
      // Each operator's bay: a dark well with an edge, a deck plate and the bot's colour stripe.
      g.rect(r.x + 8, r.y + 2, r.w - 16, 100).fill(m.edge);
      g.rect(r.x + 10, r.y + 4, r.w - 20, 96).fill(m.surface);
      g.rect(r.x + 10, r.y + 84, r.w - 20, 16).fill(c.P);
      g.rect(r.x + 12, r.y + 96, 12, 4).fill(color);
      const console = this.fixture(A.CONSOLE, x, r.y + 14, 0.5, 0);
      this.fixture(A.CHAIR, x, r.y + 75, 0.5, 0.5);
      const figure = new Sprite();
      figure.anchor.set(0.5, 1);
      figure.position.set(x, r.y + 94);
      const badge = new Sprite();
      badge.anchor.set(0, 1);
      badge.scale.set(PX);
      badge.position.set(x + 14, r.y + 54);
      this.root.addChild(figure, badge);
      this.operators.push({ bot, workstation: r, figure, console, badge });
      const name = this.text(bot.title.length > 18 ? bot.title.slice(0, 17) + '…' : bot.title, x, r.y + 103, 12, HUD.text);
      name.anchor.set(0.5, 0);
      this.names.push({ label: name, full: bot.title, width: r.w - 12 });
      const status = this.text(bot.observed ? BOT_STATE_LABELS[bot.state].toUpperCase() : 'ON CALL · UNOBSERVED',
        x, r.y + 121, 8, bot.observed ? STATUS[bot.state] : HUD.muted);
      status.anchor.set(0.5, 0);
      const hit = new Container();
      hit.eventMode = 'static'; hit.cursor = 'pointer';
      hit.hitArea = new Rectangle(r.x, r.y, r.w, r.h);
      hit.on('pointertap', (e: FederatedPointerEvent) => {
        e.stopPropagation(); if (gesturing()) return; setSelection({ kind: 'hermes', envId: bot.envId, profile: bot.name });
      });
      this.root.addChild(hit);
    }
    // Reuse familiar archive and communications furniture for the shared bridge services.
    const serviceY = h.y + h.h - 52;
    g.rect(h.x + 30, serviceY - 12, h.w - 60, 2).fill({ color: HERMES_COLOR, alpha: 0.35 });
    // Holo-table at the centre of the dock: a pedestal with a dithered projection above it.
    const hx = h.x + h.w / 2;
    g.rect(hx - 24, serviceY - 6, 48, 10).fill(c.k);
    g.rect(hx - 22, serviceY - 4, 44, 6).fill(m.control);
    g.rect(hx - 16, serviceY - 6, 32, 2).fill(HUD.cyan);
    for (let row = 0; row < 4; row++) {
      for (let x = -14 + row * 2; x < 14 - row * 2; x += 4) {
        if (((x + 14) / 4 + row) % 2) continue;
        g.rect(hx + x, serviceY - 10 - row * 4, 4, 4).fill({ color: HUD.cyan, alpha: 0.5 - row * 0.1 });
      }
    }
    this.fixture(A.FILES, h.x + 50, serviceY + 4, 0.5, 0.5);
    this.text('MEMORY ARCHIVE', h.x + 82, serviceY - 7, 10, HERMES_COLOR);
    this.text('ENGINEERING DOCK', h.x + h.w / 2 - 63, serviceY + 19, 10, HERMES_COLOR);
    this.fixture(A.COMMS, h.x + h.w - 50, serviceY + 4, 0.5, 0.5);
    this.text('ROUTINES', h.x + h.w - 168, serviceY - 7, 10, HERMES_COLOR);
    this.selection = new Graphics(); this.root.addChild(this.selection);
    this.root.eventMode = 'static'; this.root.cursor = 'pointer';
    this.root.hitArea = new Rectangle(h.x, h.y - 18, h.w, h.h + 18);
    this.root.removeAllListeners('pointertap');
    this.root.on('pointertap', (e: FederatedPointerEvent) => {
      e.stopPropagation(); if (gesturing()) return; setSelection({ kind: 'hermes', envId: center.envId });
    });
    this.root.alpha = live ? 1 : 0.55;
  }

  private fixture(grid: A.Grid, x: number, y: number, ax: number, ay: number): Sprite {
    const s = new Sprite(tex(grid));
    s.anchor.set(ax, ay); s.scale.set(PX); s.position.set(x, y);
    this.root.addChild(s); return s;
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
      const active = bot.observed && bot.state === 'working';
      const color = botColor(bot.name);
      figure.texture = crewTex(providerSilhouette(bot.provider ?? 'hermes'), modelTier(bot.model ?? ''),
        'idle', active ? (frame % 2 ? 'typeA' : 'typeB') : 'idle', color, HERMES_COLOR);
      figure.scale.set(PX * figureBoost(zoom, PX));
      const screen = bot.observed && bot.state !== 'idle' ? STATUS[bot.state] : 0x1c2228;
      console.texture = tex(A.CONSOLE, { screen });
      const grid = bot.observed ? badges[bot.state] : undefined;
      badge.visible = !!grid;
      if (grid) {
        badge.texture = tex(grid);
        const bob = bot.state === 'alert' || bot.state === 'question' ? (frame % 2) * PX : 0;
        badge.y = workstation.y + 54 - bob;
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
