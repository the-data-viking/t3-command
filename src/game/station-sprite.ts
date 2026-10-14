// One project station in cross-section: rooms, consoles, doors and its nameplate.

import { Container, Graphics, Rectangle, Sprite, TilingSprite, type FederatedPointerEvent } from "pixi.js";
import { PixelText } from "./pixel-text";
import * as A from "../art/sprites";
import { setSelection, useGame, type GameState } from "../store";
import { QUARTERS_SHOWN, stationDrawKey, systemFixtureX, TILE, type StationLayout, type SystemRoom } from "./layout";
import { sfx } from "./sfx";
import { gesturing } from "./gesture";
import { currentStyle, PX, tex } from "./textures";
import { mapInk, STATUS } from "./theme";
import { fitLabel, FLEET_VIEW_ZOOM, hash, pixelFrame, sprite, steppedPlate, SCREEN_OFF } from "./map-common";
import { worldRef } from "./world-ref";
import { dockedPrs, JOBS_PER_SHELF, MAX_PATCHES, MAX_PODS, podSpot, stationMemory, tallyBand, type DockedPr, type StationMemory } from "./memory";

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
  /** PR numbers under the cargo pods, shown only close up. */
  private podLabels: PixelText[] = [];
  /** The cargo pods, hidden in the fleet view (its caption counts them instead). */
  private pods?: Container;
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
    // Each world's silhouette: deep angular corners for the FTL ship, a rounded hull for soft
    // worlds, the layout's own chamfer otherwise. The interior always clears the corners.
    const silhouette = style.hull ?? "industrial";
    const cut = silhouette === "industrial" ? Math.max(8, s.hull[0] - hx) : 40;
    // A one-art-pixel outline, as every sprite has.
    if (silhouette === "soft") {
      roundedPlate(g, hx - PX, hy - PX, hw + 2 * PX, hh + 2 * PX, cut + PX, c.k);
      roundedPlate(g, hx, hy, hw, hh, cut, c.H);
    } else {
      steppedPlate(g, hx - PX, hy - PX, hw + 2 * PX, hh + 2 * PX, cut + PX, 4, c.k);
      steppedPlate(g, hx, hy, hw, hh, cut, 4, c.H);
    }
    const i = s.interior;
    const hullTop = s.hull[1];
    const hullBottom = s.hull[11];
    g.rect(hx + cut, hullTop + 2, hw - 2 * cut, 4).fill(c.h);
    g.rect(hx + cut, hullBottom - 6, hw - 2 * cut, 4).fill(c.D);
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
    const memory = stationMemory(state, s);
    this.drawMemory(g, s, memory, hullTop, hullBottom, i);

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
    // Archive shelves, filling with finished work: one shelf unit per few clean turns.
    const ar = s.rooms.archive?.rect;
    if (ar) {
      // Book spines in the theme's own materials (team colours mean machines, not decor).
      const teams = [c.b, c.m, c.q, c.M];
      const filled = Math.ceil(memory.completed / JOBS_PER_SHELF);
      let k = 0;
      for (let y = ar.y + 8; y + 18 <= ar.y + ar.h - 4; y += 26) {
        for (let x = ar.x + 4; x + 28 <= ar.x + ar.w - 2; x += 30) {
          fixtures.addChild(sprite(k < filled ? tex(A.SHELF, { team: teams[k % teams.length] }) : tex(A.SHELF_EMPTY), x, y));
          k++;
        }
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

    this.drawPods(dockedPrs(state, s), hullBottom, i);

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
    for (const l of this.podLabels) l.visible = zoom >= 1;
    if (this.pods) this.pods.visible = zoom >= FLEET_VIEW_ZOOM;
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
    const style = currentStyle();
    if (style.hull === "ftl") return this.drawFtlExterior(g, s, h, hullTop, i);
    if (style.hull === "soft") return this.drawSoftExterior(g, s, h, hullTop, i);
    const c = style.colors;
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

  /**
   * Kestrel's FTL ship: long slot ports along the top band, a stepped dorsal spine on the roof
   * (clear of the nameplate on the left and the antenna on the right), and twin engine nacelles
   * on the side away from the network port. Their exhaust is drawn by the world, lit only while crew are on duty.
   */
  private drawFtlExterior(g: Graphics, s: StationLayout, h: { x: number; y: number; w: number; h: number }, hullTop: number, i: { x: number; y: number; w: number; h: number }): void {
    const style = currentStyle(), c = style.colors;
    const band = i.y - hullTop;
    if (band >= 14) {
      const wy = hullTop + Math.round((band - 6) / 2 / 2) * 2;
      for (let x = i.x + 64; x + 28 < i.x + i.w - 64; x += 40) {
        g.rect(x, wy, 28, 6).fill(c.k);
        g.rect(x + 2, wy + 2, 24, 2).fill(c.b);
        g.rect(x + 2, wy + 2, 6, 2).fill(c.h);
      }
    }
    // Dorsal spine: a stepped plate with ribs along it.
    const sx = i.x + Math.round((i.w * 0.46) / 4) * 4, sw = Math.round((i.w * 0.36) / 4) * 4;
    steppedPlate(g, sx - 2, hullTop - 12, sw + 4, 14, 6, 2, c.k);
    steppedPlate(g, sx, hullTop - 10, sw, 12, 4, 2, c.H);
    g.rect(sx + 4, hullTop - 10, sw - 8, 2).fill(c.h);
    for (let x = sx + 12; x < sx + sw - 8; x += 16) g.rect(x, hullTop - 6, 2, 6).fill(c.D);
    // Twin nacelles on struts, away from the port.
    for (const { nx, ny, nw, nh, right } of nacelles(s)) {
      // A pylon in hull plating, outlined, from the hull to the nacelle.
      g.rect(right ? h.x + h.w - 2 : nx + nw - 2, ny + 4, 12, 10).fill(c.k);
      g.rect(right ? h.x + h.w - 2 : nx + nw, ny + 6, 12, 6).fill(c.H);
      steppedPlate(g, nx - 2, ny - 2, nw + 4, nh + 4, 6, 2, c.k);
      steppedPlate(g, nx, ny, nw, nh, 4, 2, c.W);
      g.rect(nx + 4, ny + 2, nw - 8, 2).fill(c.w);
      g.rect(nx + 4, ny + nh - 4, nw - 8, 2).fill(c.D);
      g.rect(nx + 14, ny + 6, 16, 6).fill(c.q);
      // The nozzle; its glow is drawn by the world only while the station is on duty.
      g.rect(right ? nx + nw : nx - 4, ny + 4, 4, nh - 8).fill(c.k);
    }
  }

  /**
   * Pastel's soft hull: round portholes along the top band, a glass dome on the roof, a
   * pastel stripe along the belly, and a rounded engine pod away from the port.
   */
  private drawSoftExterior(g: Graphics, s: StationLayout, h: { x: number; y: number; w: number; h: number }, hullTop: number, i: { x: number; y: number; w: number; h: number }): void {
    const c = currentStyle().colors;
    const seed = hash(s.key);
    const band = i.y - hullTop;
    if (band >= 14) {
      const cy = hullTop + Math.round(band / 2 / 2) * 2;
      for (let x = i.x + 72 + Math.round(seed * 4) * 2; x < i.x + i.w - 72; x += 36) {
        pixelDisc(g, x, cy, 6, c.k);
        pixelDisc(g, x, cy, 4, c.b);
        g.rect(x - 2, cy - 2, 2, 2).fill(c.w);
      }
    }
    // Belly stripe in the deck's warm tone, between the corners.
    g.rect(h.x + 44, s.hull[11] - 12, h.w - 88, 4).fill(c.q);
    // Glass dome on the roof, mid-right, clear of the nameplate and antenna.
    const dx = i.x + Math.round((i.w * 0.62) / 2) * 2;
    const R = 18;
    const half = (row: number) => Math.round(Math.sqrt(R * R - (R - row - 1) ** 2) / 2) * 2;
    // Outline first (one row up and one cell out), then the glass inside it.
    for (let row = 0; row < R; row += 2) g.rect(dx - half(row) - 2, hullTop - R + row - 2, half(row) * 2 + 4, 4).fill(c.k);
    for (let row = 2; row < R; row += 2) g.rect(dx - half(row) + 2, hullTop - R + row, half(row) * 2 - 4, 2).fill(row < 8 ? c.W : c.b);
    // A glint on the glass.
    g.rect(dx - 8, hullTop - R + 6, 4, 2).fill(c.w);
    // A rounded engine pod away from the network port.
    const right = s.port.x < h.x + h.w / 2;
    const pw = 22, ph = 40 + Math.round(seed * 4) * 4;
    const px = right ? h.x + h.w + 2 : h.x - 2 - pw, py = h.y + h.h / 2 - ph / 2;
    roundedPlate(g, px - 2, py - 2, pw + 4, ph + 4, 10, c.k);
    roundedPlate(g, px, py, pw, ph, 8, c.W);
    for (let k = 0; k < 3; k++) pixelDisc(g, px + pw / 2, py + 10 + k * Math.floor((ph - 20) / 2), 3, c.q);
  }

  /**
   * Memory on the hull: a painted tally for every merged PR (groups of five, from the left of the
   * bottom band) and a riveted patch plate for every failed turn (up to eight, on the right of the
   * bottom band and the free ends of the top band, placed by the station's seed).
   */
  private drawMemory(g: Graphics, s: StationLayout, m: StationMemory, hullTop: number, hullBottom: number, i: { x: number; y: number; w: number; h: number }): void {
    const c = currentStyle().colors;
    const ink = currentStyle().memoryInk ?? c.w;
    const band = tallyBand(i, hullBottom);
    const bandTop = i.y + i.h + 4, bandH = hullBottom - 6 - bandTop;
    if (band) {
      const y = band.y;
      const groups = Math.min(Math.ceil(m.merged / 5), Math.floor((i.w * 0.5) / 24));
      for (let gi = 0; gi < groups; gi++) {
        const x0 = i.x + 10 + gi * 24;
        const marks = Math.min(5, m.merged - gi * 5);
        for (let k = 0; k < Math.min(4, marks); k++) g.rect(x0 + k * 4, y, 2, 8).fill(ink);
        // The fifth strikes through the four, as a stepped diagonal.
        if (marks === 5) for (let k = 0; k < 9; k++) g.rect(x0 - 2 + k * 2, y + 6 - Math.floor(k / 2) * 2, 2, 2).fill(ink);
      }
    }
    const patches = Math.min(m.failed, MAX_PATCHES);
    if (!patches) return;
    const slots: Array<{ x: number; y: number; h: number }> = [];
    const topBand = i.y - hullTop;
    if (bandH >= 10) for (let x = i.x + i.w - 22; x > i.x + i.w * 0.55; x -= 22) slots.push({ x, y: bandTop + 1, h: bandH - 2 });
    if (topBand >= 14) for (const x of [i.x + 8, i.x + 30, i.x + i.w - 56]) slots.push({ x, y: hullTop + 6, h: topBand - 12 });
    slots.sort((a, b) => hash(`${s.key}${a.x},${a.y}`) - hash(`${s.key}${b.x},${b.y}`));
    // Mismatched plates bolted over the hull: lighter than it, dark rivets, a lit top edge, and a
    // seam where the plate overlaps — slightly different sizes so they read as repairs, not trim.
    for (const slot of slots.slice(0, patches)) {
      const n = hash(`${s.key}${slot.x}p`);
      const w = n > 0.5 ? 18 : 16, h = Math.max(8, Math.floor(slot.h / 2) * 2 + 2);
      const x = slot.x, y = slot.y - 1 - (h > slot.h ? 1 : 0);
      // Soot from the failure, dithered out to one side of the plate.
      const side = n > 0.3 ? 1 : -1;
      for (let k = 0; k < 4; k++) {
        for (let r = 0; r < h; r += 2) if ((k + r / 2) % 2 === 0 && hash(`${s.key}${x}${k}${r}`) > k * 0.22) g.rect(side > 0 ? x + w + k * 2 : x - 2 - k * 2, y + r, 2, 2).fill(c.k);
      }
      g.rect(x, y, w, h).fill(c.k);
      g.rect(x + 2, y + 2, w - 4, h - 4).fill(n > 0.5 ? c.s : c.g);
      g.rect(x + 2, y + 2, w - 4, 2).fill(c.W);
      for (const [rx, ry] of [[2, 4], [w - 4, 4], [2, h - 6], [w - 4, h - 6]]) if (ry >= 4) g.rect(x + rx, y + ry, 2, 2).fill(c.k);
    }
  }

  /**
   * Open PRs as cargo pods hanging under the hull's right end, newest outermost: a capsule on a
   * strut with a light for its checks (green passing, red failing, white pending, dim for a draft).
   * Tapping a pod opens the PR.
   */
  private drawPods(prs: DockedPr[], hullBottom: number, i: { x: number; y: number; w: number; h: number }): void {
    this.podLabels = [];
    this.pods = undefined;
    if (!prs.length) return;
    const pods = new Container();
    this.pods = pods;
    this.root.addChild(pods);
    const c = currentStyle().colors;
    const ink = mapInk(useGame.getState().artStyle);
    const top = hullBottom + 4;
    prs.slice(0, MAX_PODS).forEach((pr, k) => {
      const { x, y } = podSpot(i, hullBottom, k);
      const pod = new Graphics();
      pod.rect(x + 10, top, 4, 6).fill(c.k);
      pod.rect(x + 11, top, 2, 6).fill(c.D);
      steppedPlate(pod, x, y, 24, 14, 4, 2, c.k);
      steppedPlate(pod, x + 2, y + 2, 20, 10, 2, 2, c.W);
      pod.rect(x + 4, y + 4, 16, 2).fill(c.w);
      pod.rect(x + 4, y + 8, 16, 2).fill(c.g);
      const light = pr.checks === "passing" ? STATUS.done : pr.checks === "failing" ? STATUS.error : pr.checks === "draft" ? c.g : c.w;
      pod.rect(x + 8, y + 2, 2, 10).fill(c.g); // Hatch seam.
      pod.rect(x + 14, y + 4, 6, 6).fill(c.k);
      pod.rect(x + 16, y + 6, 2, 2).fill(light);
      pod.rect(x + 14, y + 4, 2, 2).fill(light); // A catch of the lamp on its bezel.
      pod.eventMode = "static";
      pod.cursor = "pointer";
      pod.hitArea = new Rectangle(x - 2, top - 2, 28, 24);
      pod.on("pointertap", (e: FederatedPointerEvent) => {
        e.stopPropagation();
        if (gesturing()) return;
        sfx.select();
        window.open(pr.url, "_blank", "noopener");
      });
      pods.addChild(pod);
      const label = new PixelText(7, ink.muted);
      label.text = `#${pr.number}`;
      label.anchor.set(0.5, 0);
      label.position.set(x + 12, y + 16);
      pods.addChild(label);
      this.podLabels.push(label);
    });
    if (prs.length > MAX_PODS) {
      const more = new PixelText(7, ink.muted);
      more.text = `+${prs.length - MAX_PODS}`;
      more.anchor.set(1, 0);
      more.position.set(i.x + i.w - 30 - MAX_PODS * 28 + 20, top + 10);
      pods.addChild(more);
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}

/** A plate with quarter-circle corners of radius `r`, drawn in 2-px rows (no smooth curves). */
function roundedPlate(g: Graphics, x: number, y: number, w: number, h: number, r: number, color: number): void {
  g.rect(x, y + r, w, h - 2 * r).fill(color);
  for (let row = 0; row < r; row += 2) {
    const inset = Math.round((r - Math.sqrt(r * r - (r - row - 1) ** 2)) / 2) * 2;
    g.rect(x + inset, y + row, w - 2 * inset, 2).fill(color);
    g.rect(x + inset, y + h - row - 2, w - 2 * inset, 2).fill(color);
  }
}

/** A filled pixel disc of radius `r`, in 2-px rows. */
function pixelDisc(g: Graphics, cx: number, cy: number, r: number, color: number): void {
  for (let y = -r; y < r; y += 2) {
    const half = Math.round(Math.sqrt(Math.max(0, r * r - (y + 1) ** 2)) / 2) * 2;
    if (half > 0) g.rect(cx - half, cy + y, half * 2, 2).fill(color);
  }
}

/** Kestrel's twin nacelles beside a station's hull, away from its network port (world px). */
export function nacelles(s: StationLayout): Array<{ nx: number; ny: number; nw: number; nh: number; right: boolean; ex: number }> {
  const xs = s.hull.filter((_, k) => k % 2 === 0), ys = s.hull.filter((_, k) => k % 2 === 1);
  const h = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  const right = s.port.x < h.x + h.w / 2;
  const nw = 44, nh = 18;
  return [h.y + 18, h.y + h.h - 18 - nh].map((ny) => {
    const nx = right ? h.x + h.w + 8 : h.x - 8 - nw;
    return { nx, ny, nw, nh, right, ex: right ? nx + nw : nx - 4 };
  });
}
