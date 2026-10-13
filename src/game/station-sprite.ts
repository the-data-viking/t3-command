// One project station in cross-section: rooms, consoles, doors and its nameplate.

import { Container, Graphics, Rectangle, Sprite, TilingSprite, type FederatedPointerEvent } from "pixi.js";
import { PixelText } from "./pixel-text";
import * as A from "../art/sprites";
import { setSelection, type GameState } from "../store";
import { QUARTERS_SHOWN, stationDrawKey, systemFixtureX, TILE, type StationLayout, type SystemRoom } from "./layout";
import { sfx } from "./sfx";
import { gesturing } from "./gesture";
import { currentStyle, PX, tex } from "./textures";
import { mapInk } from "./theme";
import { fitLabel, hash, pixelFrame, sprite, steppedPlate, SCREEN_OFF } from "./map-common";
import { worldRef } from "./world-ref";

// ---- Stations --------------------------------------------------------------------------

/** One project station. Static geometry is rebuilt on layout or art-style changes. */
export class StationSprite {
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
  /** Each system room's fixture, whose screen the world lights while crew use it. */
  readonly systems = new Map<SystemRoom, { sprite: Sprite; grid: A.Grid }>();
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

    // Hull plating with stepped (pixel) chamfers: outline, fill, a highlight along the top,
    // shadow along the bottom.
    const xs = s.hull.filter((_, k) => k % 2 === 0), ys = s.hull.filter((_, k) => k % 2 === 1);
    const hx = Math.min(...xs), hy = Math.min(...ys), hw = Math.max(...xs) - hx, hh = Math.max(...ys) - hy;
    const cut = Math.max(8, s.hull[0] - hx);
    steppedPlate(g, hx - 4, hy - 4, hw + 8, hh + 8, cut + 4, 4, c.k);
    steppedPlate(g, hx, hy, hw, hh, cut, 4, c.H);
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
    // Decoration uses the theme's materials, never a status colour: a white beacon, not amber.
    g.rect(i.x + i.w - 44, hullTop - 32, 8, 6).fill(c.w);
    g.rect(Math.round(s.port.x / 2) * 2 - 6, s.port.y - 20, 12, 40).fill(c.k);
    g.rect(Math.round(s.port.x / 2) * 2 - 4, s.port.y - 18, 8, 36).fill(c.D);
    this.drawExterior(g, s, { x: hx, y: hy, w: hw, h: hh }, hullTop, i);

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
      if (!r) continue;
      const fixture = sprite(tex(grid, { screen: SCREEN_OFF }), systemFixtureX(r), r.y + r.h - 6, 0.5, 1);
      fixtures.addChild(fixture);
      this.systems.set(kind, { sprite: fixture, grid });
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
      // Book spines in the theme's own materials (team colours mean machines, not decor).
      const teams = [c.b, c.m, c.q, c.M];
      let k = 0;
      for (let y = ar.y + 8; y + 18 <= ar.y + ar.h - 4; y += 26) {
        for (let x = ar.x + 4; x + 28 <= ar.x + ar.w - 2; x += 30) fixtures.addChild(sprite(tex(A.SHELF, { team: teams[k++ % teams.length] }), x, y));
      }
    }

    // Walls, then doors on top of them.
    const walls = new Graphics();
    for (const room of Object.values(s.rooms)) {
      // 4 px walls centred on each room edge, as cells (no centred strokes).
      if (room) pixelFrame(walls, room.rect.x - 2, room.rect.y - 2, room.rect.w + 4, room.rect.h + 4, style.wall, 1, 4);
    }
    pixelFrame(walls, i.x - 4, i.y - 4, i.w + 8, i.h + 8, style.wall, 1, 4);
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
    const ink = mapInk(state.artStyle);
    const title = new PixelText(18, ink.text);
    // Repository slugs read as words on the nameplate ("THE LIVING STONE").
    title.text = s.name.replace(/[-_]+/g, " ").trim().toUpperCase();
    title.anchor.set(0, 1);
    title.position.set(s.nameplate.x, s.nameplate.y + 16);
    const sub = new PixelText(10, ink.muted);
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

  /**
   * Exterior detail, varied per station (seeded by its key) so no two hulls are identical:
   * viewports along the top band, an engine block on the far side from the port, and a dish
   * or a second mast on the roof.
   */
  private drawExterior(g: Graphics, s: StationLayout, h: { x: number; y: number; w: number; h: number }, hullTop: number, i: { x: number; y: number; w: number; h: number }): void {
    const c = currentStyle().colors;
    const seed = hash(s.key);
    const band = i.y - hullTop;
    // Viewports: small dark windows with a lit pixel, in the hull band above the interior.
    if (band >= 14) {
      const spacing = seed > 0.5 ? 40 : 56;
      const wy = hullTop + Math.round((band - 6) / 2 / 2) * 2;
      for (let x = i.x + 72 + Math.round(seed * 8) * 2; x < i.x + i.w - 72; x += spacing) {
        g.rect(x, wy, 10, 6).fill(c.k);
        g.rect(x + 2, wy + 2, 6, 2).fill(c.b);
        if (hash(`${s.key}${x}`) > 0.45) g.rect(x + 2, wy + 2, 2, 2).fill(c.h);
      }
    }
    // Engine block on the side away from the network port, with three exhaust vents.
    const right = s.port.x < h.x + h.w / 2;
    const ex = right ? h.x + h.w + 2 : h.x - 18;
    const eh = 28 + Math.round(seed * 4) * 4;
    const ey = h.y + h.h / 2 - eh / 2;
    g.rect(ex - 2, ey - 2, 20, eh + 4).fill(c.k);
    g.rect(ex, ey, 16, eh).fill(c.D);
    g.rect(right ? ex : ex + 12, ey, 4, eh).fill(c.H);
    for (let k = 0; k < 3; k++) g.rect(right ? ex + 10 : ex + 2, ey + 6 + k * Math.floor((eh - 12) / 3), 4, 4).fill(c.W);
    // Roof: a dish on half the stations, a second mast on the rest. In the middle of the roof, clear
    // of the title over its left end and the antenna mast at its right.
    const rx = i.x + Math.round(i.w * 0.5 / 4) * 4 + Math.round(seed * 10) * 4;
    if (seed > 0.5) {
      g.rect(rx + 6, hullTop - 10, 4, 10).fill(c.k);
      for (let row = 0; row < 4; row++) g.rect(rx + row * 2, hullTop - 14 - row * 2, 16 - row * 4, 2).fill(row === 0 ? c.k : c.m);
      g.rect(rx + 7, hullTop - 22, 2, 4).fill(c.m);
    } else {
      g.rect(rx, hullTop - 18, 4, 18).fill(c.k);
      g.rect(rx - 4, hullTop - 14, 12, 2).fill(c.k);
      g.rect(rx, hullTop - 22, 4, 4).fill(c.w);
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
