// One project station in cross-section: rooms, consoles, doors and its nameplate.

import { Container, Graphics, Rectangle, Sprite, TilingSprite, type FederatedPointerEvent } from "pixi.js";
import { PixelText } from "./pixel-text";
import * as A from "../art/sprites";
import { setSelection, type GameState } from "../store";
import { QUARTERS_SHOWN, stationDrawKey, TILE, type StationLayout, type SystemRoom } from "./layout";
import { sfx } from "./sfx";
import { gesturing } from "./gesture";
import { currentStyle, PX, tex } from "./textures";
import { fitLabel, sprite, SCREEN_OFF } from "./map-common";
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

    // Hull plating: outline, fill, a highlight along the top, shadow along the bottom.
    g.poly(s.hull).fill(c.H).stroke({ color: c.k, width: 4 });
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
    g.rect(i.x + i.w - 44, hullTop - 32, 8, 6).fill(c.a);
    g.rect(s.port.x - 5, s.port.y - 18, 10, 36).fill(c.D).stroke({ color: c.k, width: 2 });

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
      if (r) fixtures.addChild(sprite(tex(grid), r.x + r.w * 0.3, r.y + r.h - 6, 0.5, 1));
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
      const teams = [0x3f6a8f, 0xf0a33a, 0x3ec7b3, 0x9b7bff];
      let k = 0;
      for (let y = ar.y + 8; y + 18 <= ar.y + ar.h - 4; y += 26) {
        for (let x = ar.x + 4; x + 28 <= ar.x + ar.w - 2; x += 30) fixtures.addChild(sprite(tex(A.SHELF, { team: teams[k++ % teams.length] }), x, y));
      }
    }

    // Walls, then doors on top of them.
    const walls = new Graphics();
    for (const room of Object.values(s.rooms)) {
      if (room) walls.rect(room.rect.x, room.rect.y, room.rect.w, room.rect.h).stroke({ color: style.wall, width: 4, alignment: 0.5 });
    }
    walls.rect(i.x - 2, i.y - 2, i.w + 4, i.h + 4).stroke({ color: style.wall, width: 4 });
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
    const title = new PixelText(18, 0xf2f4f6);
    title.text = s.name.toUpperCase();
    title.anchor.set(0, 1);
    title.position.set(s.nameplate.x, s.nameplate.y + 16);
    const sub = new PixelText(10, 0x9aa7bd);
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

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
