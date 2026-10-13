import { Container, Graphics, Rectangle, Sprite, type FederatedPointerEvent } from 'pixi.js';
import { PixelText } from './pixel-text';
import { gesturing } from './gesture';
import * as A from '../art/sprites';
import { setSelection, type Selection } from '../store';
import { botColor, BOT_STATE_LABELS, HERMES_COLOR, type BotOperator } from '../t3/bots';
import type { UnitState } from '../t3/derive';
import type { ControlCenterLayout, Rect } from './layout';
import { HUD, modelTier, providerSilhouette, STATUS } from './theme';
import { crewTex, currentStyle, PX, tex } from './textures';
import { crispScale, figureBoost } from './map-common';

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
  private names: PixelText[] = [];
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
    const g = new Graphics();
    this.root.addChild(g);
    const cut = 44;
    const shape = [h.x + cut, h.y, h.x + h.w - cut, h.y, h.x + h.w, h.y + cut,
      h.x + h.w, h.y + h.h - cut, h.x + h.w - cut, h.y + h.h, h.x + cut, h.y + h.h,
      h.x, h.y + h.h - cut, h.x, h.y + cut];
    g.poly(shape).fill(c.H).stroke({ color: HERMES_COLOR, width: 3 });
    g.roundRect(h.x + 16, h.y + 16, h.w - 32, h.h - 32, 24).fill(c.p)
      .stroke({ color: HERMES_COLOR, width: 1, alpha: 0.2 });
    // Keep the command emblem and sensor wings from the original Hermes node.
    for (const x of [h.x + 56, h.x + h.w - 56]) {
      g.rect(x - 20, h.y - 18, 40, 18).fill(c.D).stroke({ color: HERMES_COLOR, width: 2 });
      for (let i = 0; i < 3; i++) g.rect(x - 12 + i * 9, h.y - 12, 5, 6).fill(HERMES_COLOR);
    }
    const ex = h.x + 76, ey = h.y + 68;
    g.poly([ex, ey - 26, ex + 26, ey, ex, ey + 26, ex - 26, ey]).fill(c.G)
      .stroke({ color: HERMES_COLOR, width: 2 });
    g.moveTo(ex - 10, ey - 12).lineTo(ex - 10, ey + 12).moveTo(ex + 10, ey - 12).lineTo(ex + 10, ey + 12)
      .moveTo(ex - 10, ey).lineTo(ex + 10, ey).stroke({ color: HERMES_COLOR, width: 4 });
    this.title = this.text('HERMES', h.x + 122, h.y + 28, 28, HERMES_COLOR);
    this.text('DOCKED BRIDGE', h.x + 124, h.y + 63, 12, HUD.text);
    this.text('PERSISTENT OPERATORS / SHARED ENGINEERING', h.x + 124, h.y + 88, 9, HUD.muted);
    this.text(live ? 'CONNECTED' : 'OFFLINE', h.x + h.w - 155, h.y + 35, 10, live ? 0x9bc9c2 : HUD.muted);
    this.text(`${center.operators.length} OPERATORS`, h.x + h.w - 155, h.y + 55, 9, HUD.muted);
    this.text(`${endpointCount} BAYS ONLINE`, h.x + h.w - 155, h.y + 74, 9, HUD.muted);
    g.moveTo(h.x + 30, h.y + 112).lineTo(h.x + h.w - 30, h.y + 112)
      .stroke({ color: HERMES_COLOR, width: 1, alpha: 0.25 });
    if (!center.operators.length) this.text('OPEN CONTROL CENTER TO VIEW OPERATORS', h.x + 150, h.y + 180, 12, HUD.muted);
    for (const { bot, workstation: r } of center.operators) {
      const color = botColor(bot.name);
      const x = r.x + r.w / 2;
      g.rect(r.x + 9, r.y + 4, r.w - 18, 96).fill(c.p).stroke({ color: c.P, width: 1 });
      g.rect(r.x + 12, r.y + 96, 12, 3).fill(color);
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
      this.names.push(name);
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
    g.moveTo(h.x + 30, serviceY - 12).lineTo(h.x + h.w - 30, serviceY - 12)
      .stroke({ color: HERMES_COLOR, width: 1, alpha: 0.25 });
    this.fixture(A.FILES, h.x + 50, serviceY + 4, 0.5, 0.5);
    this.text('MEMORY ARCHIVE', h.x + 82, serviceY - 7, 10, HERMES_COLOR);
    this.text('ENGINEERING DOCK', h.x + h.w / 2 - 63, serviceY + 17, 10, HERMES_COLOR);
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
    for (const label of this.labels) label.visible = label === this.title || this.names.includes(label) || label.unit * zoom >= 0.8;
    if (this.title) this.title.scale.set(crispScale(this.title.unit, zoom));
    for (const name of this.names) name.scale.set(crispScale(name.unit, zoom));
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
    if (r) g.roundRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6, 8).stroke({ color: HERMES_COLOR, width: 2 });
  }

  destroy(): void { this.root.destroy({ children: true }); }
}
