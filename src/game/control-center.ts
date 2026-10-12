import { Container, Graphics, Rectangle, Text, type FederatedPointerEvent } from 'pixi.js';
import { setSelection, type Selection } from '../store';
import { botColor, BOT_STATE_LABELS, HERMES_COLOR } from '../t3/bots';
import type { ControlCenterLayout } from './layout';
import { STATUS } from './theme';
import { currentStyle } from './textures';

const font = "'Chakra Petch', ui-monospace, monospace";
/** An operator home, with no project rooms, crew routes, or host-resource gauges. */
export class ControlCenterSprite {
  readonly root = new Container();
  private labels: Text[] = [];
  private title?: Text;
  private selection = new Graphics();
  build(center: ControlCenterLayout, live: boolean, endpointCount: number): void {
    for (const child of this.root.removeChildren()) child.destroy({ children: true });
    this.labels = [];
    const { hull: h } = center;
    const c = currentStyle().colors;
    const g = new Graphics();
    this.root.addChild(g);
    const cut = 44;
    const shape = [h.x + cut, h.y, h.x + h.w - cut, h.y, h.x + h.w, h.y + cut,
      h.x + h.w, h.y + h.h - cut, h.x + h.w - cut, h.y + h.h, h.x + cut, h.y + h.h,
      h.x, h.y + h.h - cut, h.x, h.y + cut];
    g.poly(shape).fill(c.H).stroke({ color: HERMES_COLOR, width: 3 });
    g.roundRect(h.x + 16, h.y + 16, h.w - 32, h.h - 32, 24).fill(0x13212c).stroke({ color: HERMES_COLOR, width: 1, alpha: 0.2 });
    // Symmetric sensor wings and a command emblem distinguish it at fleet scale.
    for (const x of [h.x + 56, h.x + h.w - 56]) {
      g.rect(x - 20, h.y - 18, 40, 18).fill(c.D).stroke({ color: HERMES_COLOR, width: 2 });
      for (let i = 0; i < 3; i++) g.rect(x - 12 + i * 9, h.y - 12, 5, 6).fill(HERMES_COLOR);
    }
    const ex = h.x + 76, ey = h.y + 68;
    g.poly([ex, ey - 26, ex + 26, ey, ex, ey + 26, ex - 26, ey]).fill(0x27333a).stroke({ color: HERMES_COLOR, width: 2 });
    g.moveTo(ex - 10, ey - 12).lineTo(ex - 10, ey + 12).moveTo(ex + 10, ey - 12).lineTo(ex + 10, ey + 12)
      .moveTo(ex - 10, ey).lineTo(ex + 10, ey).stroke({ color: HERMES_COLOR, width: 4 });
    this.title = this.text('HERMES', h.x + 122, h.y + 28, 28, HERMES_COLOR);
    this.text('CONTROL CENTER', h.x + 124, h.y + 63, 12, 0xe6edf3);
    this.text('MEMORY  /  RESPONSIBILITIES  /  ROUTINES', h.x + 124, h.y + 88, 9, 0x9caeb9);
    this.text(live ? 'CONNECTED' : 'OFFLINE', h.x + h.w - 155, h.y + 35, 10, live ? 0x9bc9c2 : 0x8a96a8);
    this.text(`${center.operators.length} OPERATORS`, h.x + h.w - 155, h.y + 55, 9, 0x9caeb9);
    this.text(`${endpointCount} ENDPOINTS ONLINE`, h.x + h.w - 155, h.y + 74, 9, 0x9caeb9);
    g.moveTo(h.x + 30, h.y + 112).lineTo(h.x + h.w - 30, h.y + 112).stroke({ color: HERMES_COLOR, width: 1, alpha: 0.25 });
    if (!center.operators.length) this.text('OPEN CONTROL CENTER TO VIEW OPERATORS', h.x + 150, h.y + 170, 12, 0x9caeb9);
    for (const { bot, card: r } of center.operators) {
      const color = botColor(bot.name);
      g.roundRect(r.x, r.y, r.w, r.h, 8).fill(0x1b2d38).stroke({ color, width: 1, alpha: 0.6 });
      const ax = r.x + 25, ay = r.y + 28;
      g.poly([ax, ay - 16, ax + 16, ay, ax, ay + 16, ax - 16, ay]).fill({ color, alpha: 0.13 }).stroke({ color, width: 2 });
      this.text(bot.name.slice(0, 2).toUpperCase(), r.x + 15, r.y + 22, 10, color);
      this.text(bot.title.length > 13 ? bot.title.slice(0, 12) + '…' : bot.title, r.x + 48, r.y + 18, 11, 0xe6edf3);
      this.text(bot.observed ? BOT_STATE_LABELS[bot.state].toUpperCase() : 'UNOBSERVED', r.x + 48, r.y + 36, 8, bot.observed ? STATUS[bot.state] : 0x8a96a8);
      this.text(`${bot.sessions.length} CONVERSATION${bot.sessions.length === 1 ? '' : 'S'}`, r.x + 12, r.y + 62, 8, 0x9caeb9);
      const hit = new Container(); hit.eventMode = 'static'; hit.cursor = 'pointer';
      hit.hitArea = new Rectangle(r.x, r.y, r.w, r.h);
      hit.on('pointertap', (e: FederatedPointerEvent) => {
        e.stopPropagation(); setSelection({ kind: 'hermes', envId: center.envId, profile: bot.name });
      });
      this.root.addChild(hit);
    }
    this.text('ENVIRONMENT UPLINKS', h.x + 30, h.y + h.h - 40, 10, HERMES_COLOR);
    for (const x of [h.x + 24, h.x + h.w - 24]) g.rect(x - 6, h.y + h.h - 28, 12, 22).fill(0x27333a).stroke({ color: HERMES_COLOR, width: 2 });
    this.selection = new Graphics(); this.root.addChild(this.selection);
    this.root.eventMode = 'static'; this.root.cursor = 'pointer';
    this.root.hitArea = new Rectangle(h.x, h.y - 18, h.w, h.h + 18);
    this.root.removeAllListeners('pointertap');
    this.root.on('pointertap', (e: FederatedPointerEvent) => { e.stopPropagation(); setSelection({ kind: 'hermes', envId: center.envId }); });
    this.root.alpha = live ? 1 : 0.55;
  }
  private text(value: string, x: number, y: number, size: number, color: number): Text {
    const t = new Text({ text: value, style: { fontFamily: font, fontSize: size, fill: color, fontWeight: '600', letterSpacing: 0.6 } });
    t.resolution = 3; t.position.set(x, y); this.root.addChild(t); this.labels.push(t); return t;
  }
  update(center: ControlCenterLayout, selection: Selection, zoom: number): void {
    for (const label of this.labels) label.visible = label === this.title || zoom > 0.42;
    if (this.title) this.title.scale.set(Math.min(1.6, Math.max(1, 0.45 / zoom)));
    const g = this.selection.clear();
    if (selection?.kind === 'hermes') {
      const r = center.operators.find(o => o.bot.name === selection.profile)?.card ?? center.hull;
      g.roundRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6, 12).stroke({ color: HERMES_COLOR, width: 2 });
    } else if (selection?.kind === 'unit') {
      const r = center.operators.find(o => o.bot.sessions.some(s => s.envId === selection.envId && s.thread.id === selection.threadId))?.card;
      if (r) g.roundRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6, 12).stroke({ color: HERMES_COLOR, width: 2 });
    }
  }
  destroy(): void { this.root.destroy({ children: true }); }
}
