// Agent widgets: small pages an agent puts up in its workspace (.t3/widgets/<id>.html, fed by an
// optional <id>.json that a live process rewrites), shown in the crew's panel and pinnable to the
// map. Command reads them through T3's own file RPCs; pins are kept on the Command server.

/** Where agents put widgets, relative to the thread's workspace. */
export const WIDGET_DIR = ".t3/widgets";

/** A widget's id: its file name without .html. */
export const WIDGET_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Pins kept at most (oldest dropped). */
export const MAX_PINS = 40;

/** "map": anchored to a spot in the world, moving with the map. "screen": fixed on screen. */
export type PinMode = "map" | "screen";

export interface WidgetPin {
  id: string;
  envId: string;
  /** The thread it was pinned from; archiving or removing that thread drops the pin. */
  threadId: string;
  /** The workspace the widget lives in. */
  cwd: string;
  widget: string;
  mode: PinMode;
  /** Top-left corner: world px for "map", screen px for "screen". */
  x: number;
  y: number;
  /** Size in px at its own scale: a screen pin's on screen, a map pin's at the zoom it was pinned at. */
  w: number;
  h: number;
  /** A map pin's map zoom when pinned: it's drawn at (current zoom ÷ this), growing and shrinking with the map. */
  zoom?: number;
}

export const PIN_SIZE = { minW: 200, maxW: 1600, minH: 120, maxH: 1200 } as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Validate a pin from a client; undefined when it isn't one. */
export function sanitizePin(input: unknown): WidgetPin | undefined {
  if (!input || typeof input !== "object") return undefined;
  const p = input as Record<string, unknown>;
  const str = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const id = str(p.id, 80), envId = str(p.envId, 200), threadId = str(p.threadId, 200), cwd = str(p.cwd, 4096);
  const widget = typeof p.widget === "string" && WIDGET_ID.test(p.widget) ? p.widget : undefined;
  const mode = p.mode === "map" || p.mode === "screen" ? p.mode : undefined;
  const x = num(p.x), y = num(p.y), w = num(p.w), h = num(p.h), zoom = num(p.zoom);
  if (!id || !envId || !threadId || !cwd || !widget || !mode || x === undefined || y === undefined || w === undefined || h === undefined) return undefined;
  return {
    id, envId, threadId, cwd, widget, mode,
    x: clamp(Math.round(x), -1e7, 1e7), y: clamp(Math.round(y), -1e7, 1e7),
    w: clamp(Math.round(w), PIN_SIZE.minW, PIN_SIZE.maxW), h: clamp(Math.round(h), PIN_SIZE.minH, PIN_SIZE.maxH),
    ...(mode === "map" && zoom !== undefined && zoom > 0 ? { zoom: clamp(zoom, 0.02, 16) } : {}),
  };
}

/** Widget ids from a listing of the widgets directory: each <id>.html, sorted. */
export function widgetIds(entries: Array<{ path: string; kind: string }>): string[] {
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.kind !== "file") continue;
    const m = /(?:^|\/)([^/]+)\.html$/.exec(e.path);
    if (m && WIDGET_ID.test(m[1])) ids.add(m[1]);
  }
  return [...ids].sort();
}
