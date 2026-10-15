// Agent widgets on screen: listed in the crew's panel, dragged out onto the map to pin them, and
// shown pinned either anchored to a spot on the map or fixed on screen (see src/t3/widgets.ts).

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { PIN_SIZE, type PinMode, type WidgetPin } from "../../shared/widgets";
import { STYLES } from "../art/palettes";
import { rasterize } from "../art/render";
import * as A from "../art/sprites";
import { stationColor } from "../game/layout";
import { hudTokens } from "../game/theme";
import { worldRef } from "../game/world";
import { PixelLabel } from "./PixelArt";
import { hudWidgetTheme, moduleMaterials, themeCss } from "./widget-theme";
import { hudInsets } from "./hud-insets";
import { setSelection, useGame } from "../store";
import { isStale, pinSize, putPin, refreshWorkspaceWidgets, removePin, threadCwd, useWidgetFeed, widgetDocument, workspaceKey, type WidgetFeed } from "../t3/widgets";
import { useClock } from "./useClock";
import { timeAgo } from "./util";

const NO_IDS: string[] = [];
/** Pointer travel before a press on a title bar becomes a drag. */
const DRAG_PX = 4;
/** How much of a pinned window must stay in view to count as on screen. */
const VISIBLE_PX = 40;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function mapRect(): DOMRect | undefined {
  return document.querySelector(".map")?.getBoundingClientRect();
}

/** A point on screen (relative to the map) as a point in the world. */
function screenToWorld(sx: number, sy: number): { x: number; y: number } | undefined {
  const cam = worldRef.current?.cameraTransform();
  return cam && { x: (sx - cam.x) / cam.zoom, y: (sy - cam.y) / cam.zoom };
}

function worldToScreen(x: number, y: number): { x: number; y: number } | undefined {
  const cam = worldRef.current?.cameraTransform();
  return cam && { x: cam.x + x * cam.zoom, y: cam.y + y * cam.zoom };
}

/** Bring a map pin into the middle of the part of the map the HUD leaves visible. */
function showPin(pin: WidgetPin): void {
  const cam = worldRef.current?.cameraTransform();
  const map = mapRect();
  if (pin.mode !== "map" || !cam || !map) return;
  const inset = hudInsets();
  const dx = (inset.left - inset.right) / 2, dy = (inset.top - inset.bottom) / 2;
  worldRef.current?.centerOn(pin.x + (pin.w / 2 - dx) / cam.zoom, pin.y + (pin.h / 2 - dy) / cam.zoom);
}

/** Pin a widget with its top-left corner at a screen point (relative to the map). */
function pinAt(base: Omit<WidgetPin, "mode" | "x" | "y">, mode: PinMode, sx: number, sy: number): void {
  const at = mode === "map" ? screenToWorld(sx, sy) : { x: sx, y: sy };
  if (at) void putPin({ ...base, mode, x: at.x, y: at.y });
}

/** Iframes swallow pointer events: while anything is being dragged, they let them through. */
function dragging(on: boolean): void {
  document.body.classList.toggle("widget-dragging", on);
}

const updatedAt = (f: WidgetFeed) => f.dataAt === undefined ? undefined : new Date(f.dataAt).toISOString();

/** A widget in the panel is a station module: the world's hull, walls and deck, and the station's team colour. */
function useModule(envId: string) {
  const artStyle = useGame((s) => s.artStyle);
  const team = useGame((s) => stationColor(s, envId));
  return useMemo(() => {
    const m = moduleMaterials(artStyle, team);
    const floor = rasterize(A.FLOOR, STYLES[artStyle]).toDataURL();
    return { silhouette: m.silhouette, style: { ...m.vars, "--module-floor": `url(${floor})` } as CSSProperties, theme: themeCss(m.theme) };
  }, [artStyle, team]);
}

/** Pinned, a widget is HUD chrome, and its page takes the HUD's colours. */
function useHudTheme(): string {
  const artStyle = useGame((s) => s.artStyle);
  return useMemo(() => {
    const tokens = hudTokens(artStyle);
    return themeCss(hudWidgetTheme((name) => tokens[name] ?? ""));
  }, [artStyle]);
}

/** The page in a sandboxed frame: no same-origin access, its data and theme posted in as they change. */
function WidgetFrame({ feed, title, theme }: { feed: WidgetFeed; title: string; theme: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef(feed);
  latest.current = feed;
  const latestTheme = useRef(theme);
  latestTheme.current = theme;
  // Rebuilt only when the page changes; data and theme changes are posted in without a reload.
  const doc = useMemo(() => feed.page === undefined ? undefined : widgetDocument(feed.page, latest.current.data, updatedAt(latest.current), latestTheme.current), [feed.page]);
  const post = useCallback(() => {
    frame.current?.contentWindow?.postMessage({ type: "t3-widget-data", data: latest.current.data, updatedAt: updatedAt(latest.current), theme: latestTheme.current }, "*");
  }, []);
  useEffect(post, [feed.data, feed.dataAt, post]);
  useEffect(() => { frame.current?.contentWindow?.postMessage({ type: "t3-widget-data", theme }, "*"); }, [theme]);
  if (doc === undefined) return <div className="widget-note muted">{feed.pageError ?? (feed.offline ? "Machine unreachable" : "Loading…")}</div>;
  return <iframe ref={frame} className="widget-frame" title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={doc} onLoad={post} />;
}

/** How fresh the data is; amber once it's older than the page allows. */
function WidgetAge({ feed }: { feed: WidgetFeed }) {
  const now = useClock(true, 10000);
  if (feed.offline) return <span className="widget-age stale" title="The machine is unreachable: this is the last read">offline</span>;
  if (feed.dataError) return <span className="widget-age stale" title={feed.dataError}>⚠ data</span>;
  if (feed.dataAt === undefined) return null;
  const ago = timeAgo(new Date(feed.dataAt).toISOString());
  return isStale(feed, now || Date.now())
    ? <span className="widget-age stale" title="Its feeder hasn't updated the data for longer than the widget expects">stale · {ago}</span>
    : <span className="widget-age" title={new Date(feed.dataAt).toLocaleString()}>{ago}</span>;
}

/** The widgets in a crew member's workspace, for its panel. */
export function ThreadWidgets({ envId, threadId }: { envId: string; threadId: string }) {
  const env = useGame((s) => s.envs[envId]);
  const thread = env?.threads[threadId];
  const cwd = env && thread ? threadCwd(env, thread) : undefined;
  const ids = useGame((s) => cwd ? s.widgets[workspaceKey(envId, cwd)] ?? NO_IDS : NO_IDS);
  const live = env?.connection === "live";
  useEffect(() => { if (cwd && live) void refreshWorkspaceWidgets(envId, cwd); }, [envId, cwd, live]);
  if (!cwd || !ids.length) return null;
  return (
    <details className="widgets" open>
      <summary className="hud-label">Widgets · {ids.length}</summary>
      <div className="widget-list">
        {ids.map((id) => <WidgetCard key={id} envId={envId} threadId={threadId} cwd={cwd} id={id} />)}
      </div>
    </details>
  );
}

function WidgetCard({ envId, threadId, cwd, id }: { envId: string; threadId: string; cwd: string; id: string }) {
  const feed = useWidgetFeed(envId, cwd, id);
  const pin = useGame((s) => s.widgetPins.find((p) => p.envId === envId && p.cwd === cwd && p.widget === id));
  const materials = useModule(envId);
  const title = feed.meta.title ?? id;
  const size = pinSize(feed.meta);
  const base = { id: pin?.id ?? crypto.randomUUID(), envId, threadId: pin?.threadId ?? threadId, cwd, widget: id, w: pin?.w ?? size.w, h: pin?.h ?? size.h };
  const [ghost, setGhost] = useState<{ x: number; y: number; over: boolean }>();
  const drag = useRef<{ x: number; y: number; dx: number; dy: number; moved: boolean } | undefined>(undefined);

  /** Pin from a button: in the middle of the map left of this panel. */
  const pinHere = (mode: PinMode) => {
    const map = mapRect();
    if (!map) return;
    const right = document.querySelector(".unit-panel")?.getBoundingClientRect().left ?? map.right;
    pinAt(base, mode, Math.max(16, (right - map.left) / 2 - base.w / 2), Math.max(80, map.height / 2 - base.h / 2));
  };

  const overMap = (x: number, y: number) => {
    const target = document.elementFromPoint(x, y);
    return !!target && (target.closest(".map") !== null || target.closest(".widget-layer") !== null);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const head = e.currentTarget.getBoundingClientRect();
    drag.current = { x: e.clientX, y: e.clientY, dx: Math.min(e.clientX - head.left, base.w - 24), dy: e.clientY - head.top, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_PX) return;
    if (!d.moved) dragging(true);
    d.moved = true;
    setGhost({ x: e.clientX - d.dx, y: e.clientY - d.dy, over: overMap(e.clientX, e.clientY) });
  };
  const endDrag = (e: ReactPointerEvent<HTMLElement>, drop: boolean) => {
    const d = drag.current;
    drag.current = undefined;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d?.moved) return;
    dragging(false);
    setGhost(undefined);
    const map = mapRect();
    if (drop && map && overMap(e.clientX, e.clientY)) pinAt(base, pin?.mode ?? "map", e.clientX - d.dx - map.left, e.clientY - d.dy - map.top);
  };

  return (
    <div className={`widget-card ${materials.silhouette} ${pin ? "pinned" : ""}`} style={materials.style}>
      <div className="module-hull">
        <header className="widget-bar" title="Drag onto the map to pin it there"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove}
          onPointerUp={(e) => endDrag(e, true)} onPointerCancel={(e) => endDrag(e, false)}>
          <span className="module-port" aria-hidden />
          <span className="widget-title" title={`${title} · .t3/widgets/${id}.html`}><PixelLabel text={title} /></span>
          <WidgetAge feed={feed} />
          <span className="spacer" />
          {pin ? <>
            {pin.mode === "map" && <button className="btn small" onClick={() => showPin(pin)} title="Go to it on the map">Show</button>}
            <button className="btn small" onClick={() => void removePin(pin.id)} title={`Pinned ${pin.mode === "map" ? "to the map" : "on screen"}: take it off`}>Unpin</button>
          </> : <>
            <button className="btn small" onClick={() => pinHere("map")} title="Pin it to the map, where it moves with the map (or drag it there)">Pin to map</button>
            <button className="btn small" onClick={() => pinHere("screen")} title="Pin it on screen, where it stays while the map moves">Pin to screen</button>
          </>}
        </header>
        {pin
          ? <div className="widget-note">Pinned {pin.mode === "map" ? "to the map" : "on screen"}. Drag the title bar onto the map to move it.</div>
          : <div className="widget-room" style={{ height: Math.min(size.h, 300) }}><WidgetFrame feed={feed} title={title} theme={materials.theme} /></div>}
      </div>
      {ghost && createPortal(
        <div className={`widget-ghost ${ghost.over ? "" : "cannot"}`} style={{ left: ghost.x, top: ghost.y, width: base.w, height: base.h }}>
          <span>{ghost.over ? `Pin ${title} here` : "Drop it on the map"}</span>
        </div>, document.body)}
    </div>
  );
}

/** Every pinned widget, over the map and under the HUD. */
export function WidgetLayer() {
  const pins = useGame((s) => s.widgetPins);
  // A pin whose thread has been archived goes (the server drops it too). Only that re-renders here.
  const archived = useGame((s) => s.widgetPins.filter((p) => s.envs[p.envId]?.threads[p.threadId]?.archivedAt).map((p) => p.id).join("\n"));
  const shown = archived ? pins.filter((p) => !archived.split("\n").includes(p.id)) : pins;
  return <div className="widget-layer">{shown.map((pin) => <PinnedWidget key={pin.id} pin={pin} />)}</div>;
}

function useViewport(): { w: number; h: number } {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

function PinnedWidget({ pin }: { pin: WidgetPin }) {
  const threadTitle = useGame((s) => s.envs[pin.envId]?.threads[pin.threadId]?.title);
  const feed = useWidgetFeed(pin.envId, pin.cwd, pin.widget);
  const hudTheme = useHudTheme();
  const viewport = useViewport();
  const [moving, setMoving] = useState<WidgetPin>();
  const p = moving ?? pin;
  const current = useRef(p);
  current.current = p;
  const box = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLButtonElement>(null);
  const [offscreen, setOffscreen] = useState(false);
  const op = useRef<{ kind: "move" | "resize"; x: number; y: number; start: WidgetPin; zoom: number; moved: boolean } | undefined>(undefined);
  const title = feed.meta.title ?? pin.widget;

  // A map pin follows the camera every frame; only what changed is written.
  useEffect(() => {
    if (pin.mode !== "map") { setOffscreen(false); return; }
    let frame = 0;
    let last = "";
    const step = () => {
      frame = requestAnimationFrame(step);
      const at = worldToScreen(current.current.x, current.current.y);
      const map = mapRect();
      if (!at || !map) return;
      const { w, h } = current.current;
      // Off screen, its marker keeps clear of the HUD, which opens and closes on its own.
      const inset = offscreen ? hudInsets() : undefined;
      const key = `${at.x}|${at.y}|${w}|${h}|${map.width}|${map.height}|${inset ? Object.values(inset).join(",") : ""}`;
      if (key === last) return;
      last = key;
      if (box.current) box.current.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
      const off = at.x > map.width - VISIBLE_PX || at.x + w < VISIBLE_PX || at.y > map.height - VISIBLE_PX || at.y + h < VISIBLE_PX;
      setOffscreen(off);
      if (off && inset && marker.current) {
        const x = clamp(at.x + w / 2, inset.left + 90, Math.max(inset.left + 90, map.width - inset.right - 90));
        const y = clamp(at.y, inset.top, Math.max(inset.top, map.height - inset.bottom - 30));
        marker.current.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, 0)`;
      }
    };
    step();
    return () => cancelAnimationFrame(frame);
  }, [pin.mode, offscreen]);

  const begin = (kind: "move" | "resize") => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (kind === "move" && (e.target as HTMLElement).closest("button"))) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    op.current = { kind, x: e.clientX, y: e.clientY, start: p, zoom: worldRef.current?.cameraTransform()?.zoom ?? 1, moved: false };
  };
  const onMove = (e: ReactPointerEvent<HTMLElement>) => {
    const o = op.current;
    if (!o) return;
    const dx = e.clientX - o.x, dy = e.clientY - o.y;
    if (!o.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    if (!o.moved) dragging(true);
    o.moved = true;
    const s = o.start;
    if (o.kind === "resize") setMoving({ ...s, w: clamp(s.w + dx, PIN_SIZE.minW, PIN_SIZE.maxW), h: clamp(s.h + dy, PIN_SIZE.minH, PIN_SIZE.maxH) });
    else if (s.mode === "map") setMoving({ ...s, x: s.x + dx / o.zoom, y: s.y + dy / o.zoom });
    else setMoving({ ...s, x: s.x + dx, y: s.y + dy });
  };
  const end = (e: ReactPointerEvent<HTMLElement>) => {
    const o = op.current;
    op.current = undefined;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!o?.moved) return;
    dragging(false);
    void putPin(current.current).then(() => setMoving(undefined));
  };

  /** Switch between anchored to the map and fixed on screen, staying where it is now. */
  const toggleMode = () => {
    const map = mapRect();
    if (p.mode === "map") {
      const at = worldToScreen(p.x, p.y);
      if (at && map) void putPin({ ...p, mode: "screen", x: clamp(at.x, 0, map.width - VISIBLE_PX), y: clamp(at.y, 0, map.height - VISIBLE_PX) });
    } else {
      const at = screenToWorld(p.x, p.y);
      if (at) void putPin({ ...p, mode: "map", x: at.x, y: at.y });
    }
  };

  const select = () => {
    const selection = { kind: "unit" as const, envId: pin.envId, threadId: pin.threadId };
    setSelection(selection);
    worldRef.current?.focus(selection);
  };

  // A screen pin stays reachable whatever the window size.
  const style = p.mode === "screen"
    ? { width: p.w, height: p.h, transform: `translate(${clamp(p.x, VISIBLE_PX - p.w, viewport.w - VISIBLE_PX)}px, ${clamp(p.y, 0, viewport.h - 32)}px)` }
    : { width: p.w, height: p.h, visibility: offscreen ? "hidden" as const : undefined };

  return <>
    <div ref={box} className={`widget-window ${p.mode}`} style={style}>
      <header className="widget-bar" onPointerDown={begin("move")} onPointerMove={onMove} onPointerUp={end} onPointerCancel={end}>
        <button className="widget-title" onClick={select} title={`${title}: from ${threadTitle || "a crew member"} (select them)`}>{title}</button>
        <WidgetAge feed={feed} />
        <span className="spacer" />
        <button className="icon-btn widget-mode" onClick={toggleMode}
          title={p.mode === "map" ? "Anchored to the map: switch to fixed on screen" : "Fixed on screen: switch to anchored to the map"}>
          {p.mode === "map" ? "⌖" : "▭"}
        </button>
        <button className="icon-btn" onClick={() => void removePin(pin.id)} title="Unpin">✕</button>
      </header>
      <div className="widget-body"><WidgetFrame feed={feed} title={title} theme={hudTheme} /></div>
      <div className="widget-grip" title="Resize" onPointerDown={begin("resize")} onPointerMove={onMove} onPointerUp={end} onPointerCancel={end} />
    </div>
    {offscreen && <button ref={marker} className="widget-marker" onClick={() => showPin(p)} title={`Go to ${title} on the map`}>⌖ {title}</button>}
  </>;
}
