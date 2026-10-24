/* eslint-disable react-refresh/only-export-components -- Standalone review-page entrypoint. */
// Scale lab: the live fleet layout beside a tiered study, on a made-up fleet of any size. Mock data
// only; nothing here talks to an environment or changes the live map.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { computeFleetLayout } from './game/layout';
import { computeTieredLayout, fitZoom, type Viewport } from './game/fleet-tiers';
import { FLEET_VIEW_ZOOM } from './game/map-common';
import { FLEET_PRESETS, makeFleet, type FleetSpec } from './lab/fleet-fixture';
import { fromLive, fromTiered, hits, render, type Camera, type DrawModel, type Hit } from './lab/fleet-canvas';
import './designlab.css';
import './scalelab.css';

const SCREENS: Record<string, { name: string; viewport: Viewport }> = {
  laptop: { name: 'Laptop · 1600 × 1000', viewport: { w: 1600, h: 1000 } },
  desktop: { name: 'Desktop · 2560 × 1440', viewport: { w: 2560, h: 1440 } },
};
type Settings = FleetSpec & { screen: string; tiers: boolean; lit: boolean; shape: boolean; same: boolean };
const DEFAULTS: Settings = { ...FLEET_PRESETS[2].spec, screen: 'laptop', tiers: true, lit: true, shape: true, same: true };

function load(): Settings {
  const q = new URLSearchParams(location.search);
  const s = { ...DEFAULTS };
  for (const k of ['machines', 'projects', 'active', 'resting'] as const) { const v = Number(q.get(k)); if (q.has(k) && Number.isFinite(v)) s[k] = v; }
  for (const k of ['hermes', 'tiers', 'lit', 'shape', 'same'] as const) if (q.has(k)) s[k] = q.get(k) === '1';
  if (q.get('screen') && SCREENS[q.get('screen')!]) s.screen = q.get('screen')!;
  return s;
}
const clampSpec = (s: Settings): Settings => {
  const machines = Math.max(1, Math.min(16, s.machines)), projects = Math.max(1, Math.min(40, s.projects));
  const active = Math.max(0, Math.min(projects, s.active));
  return { ...s, machines, projects, active, resting: Math.max(0, Math.min(projects - active, s.resting)) };
};
const zoomLabel = (z: number) => z >= 1 ? `${z}×` : z === 0.5 ? '½' : z === 0.25 ? '¼' : Math.abs(z - 1 / 3) < 1e-9 ? '⅓' : Math.abs(z - 1 / 6) < 1e-9 ? '⅙' : z === 0.125 ? '⅛' : z.toFixed(2);

function stats(model: DrawModel, viewport: Viewport) {
  const z = fitZoom(model.bounds, viewport);
  return {
    z,
    art: z >= FLEET_VIEW_ZOOM,
    size: `${Math.round(model.bounds.w)} × ${Math.round(model.bounds.h)}`,
    area: model.bounds.w * model.bounds.h,
    lines: model.links.filter((l) => l.lit).length,
    allLines: model.links.length,
    crewPx: Math.round(44 * z),
  };
}

function FleetCanvas({ model, scale, screenZoom, label, height, onHover }: { model: DrawModel; scale: number; screenZoom: number; label: string; height: number; onHover: (h?: Hit) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [cam, setCam] = useState<Camera>({ x: 0, y: 0, z: 0.2 });
  const [hover, setHover] = useState<Hit>();
  const drag = useRef<{ x: number; y: number; cam: Camera }>(undefined);
  const centre = (z: number): Camera => ({ z, x: width / 2 - (model.bounds.x + model.bounds.w / 2) * z, y: height / 2 - (model.bounds.y + model.bounds.h / 2) * z });
  useEffect(() => {
    const el = ref.current!.parentElement!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recentre when the fleet, scale or panel changes.
  useEffect(() => setCam(centre(scale)), [model, scale, width, height]);
  useEffect(() => {
    const canvas = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    render(canvas.getContext('2d')!, model, cam, { w: width, h: height, dpr }, hover);
  }, [model, cam, width, height, hover]);
  const world = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - cam.x) / cam.z, y: (e.clientY - r.top - cam.y) / cam.z };
  };
  const all = useMemo(() => hits(model), [model]);
  // Zoom about the cursor. A native listener, so the page doesn't scroll under it (React's is passive).
  const camRef = useRef(cam);
  camRef.current = cam;
  useEffect(() => {
    const canvas = ref.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = camRef.current, r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const z = Math.max(0.05, Math.min(3, c.z * Math.exp(-e.deltaY * 0.0015)));
      setCam({ z, x: sx - ((sx - c.x) / c.z) * z, y: sy - ((sy - c.y) / c.z) * z });
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', wheel);
  }, []);
  return <div className="fleet-canvas">
    <div className="canvas-tools"><span>{label}</span><div>
      <button className="text-button" onClick={() => setCam(centre(scale))}>Overview</button>
      <button className="text-button" onClick={() => setCam(centre(screenZoom))} title="The zoom the map would settle on for the chosen screen, one CSS pixel per screen pixel">Screen zoom ({zoomLabel(screenZoom)})</button>
    </div></div>
    <canvas ref={ref} style={{ width, height }}
      onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, cam }; (e.target as HTMLElement).setPointerCapture(e.pointerId); }}
      onPointerUp={() => { drag.current = undefined; }}
      onPointerLeave={() => { setHover(undefined); onHover(undefined); }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) { setCam({ ...d.cam, x: d.cam.x + e.clientX - d.x, y: d.cam.y + e.clientY - d.y }); return; }
        const p = world(e);
        const hit = all.find((h) => p.x >= h.rect.x && p.x <= h.rect.x + h.rect.w && p.y >= h.rect.y && p.y <= h.rect.y + h.rect.h);
        if (hit?.key !== hover?.key) { setHover(hit); onHover(hit); }
      }} />
  </div>;
}

function Slider({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return <label className="slider"><span>{label}<b>{value}</b></span><input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} /></label>;
}

function Stat({ k, v, good }: { k: string; v: string; good?: boolean }) {
  return <div className={`stat ${good ? 'good' : ''}`}><small>{k}</small><strong>{v}</strong></div>;
}

function App() {
  const [s, setS] = useState<Settings>(() => clampSpec(load()));
  const [now] = useState(() => Date.now());
  const [hover, setHover] = useState<string>();
  const [width, setWidth] = useState(900);
  const viewerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = viewerRef.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const update = (patch: Partial<Settings>) => {
    const next = clampSpec({ ...s, ...patch });
    setS(next);
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) q.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
    history.replaceState(null, '', `?${q}`);
  };
  const viewport = SCREENS[s.screen].viewport;
  const { machines, projects, active, resting, hermes } = s;
  const state = useMemo(() => makeFleet({ machines, projects, active, resting, hermes }, now), [machines, projects, active, resting, hermes, now]);
  const live = useMemo(() => fromLive(state, computeFleetLayout(state)), [state]);
  const tiered = useMemo(() => fromTiered(state, computeTieredLayout(state, { tiers: s.tiers, lines: s.lit ? 'lit' : 'all', shape: s.shape, viewport, now })), [state, s.tiers, s.lit, s.shape, viewport, now]);
  const a = stats(live, viewport), b = stats(tiered, viewport);
  const panelW = width - 2;
  const panelH = Math.round(Math.max(340, Math.min(600, panelW * 0.56)));
  const fit = (m: DrawModel) => Math.min((panelW - 40) / m.bounds.w, (panelH - 40) / m.bounds.h);
  const same = Math.min(fit(live), fit(tiered));
  const preset = FLEET_PRESETS.find((p) => (Object.keys(p.spec) as (keyof FleetSpec)[]).every((k) => p.spec[k] === s[k]));

  return <>
    <header><a href="/" className="brand">T3<span> / COMMAND</span></a><div className="lab-label">SCALE LAB <span>EXPLORATION 03</span></div><a href="/designlab.html">Spatial design lab ↗</a></header>
    <main>
      <section className="intro"><div><p className="eyebrow">THE SAME FLEET, LAID OUT TWICE</p><h1>Can the station hold thirty projects?</h1>
        <p>A is the live layout engine, unchanged. B is a study that sizes stations by what is happening in them and draws supply lines only where work flows. Both use the Flight Deck kit in Night Shift on a made-up fleet. Hover a machine or a station to see its lines.</p></div>
        <div className="fixture"><span className="dot" /> SIMULATED FLEET<br /><small>{s.machines} machines · {s.projects} projects · {s.active} busy</small></div></section>
      <div className="workspace">
        <aside>
          <div className="section-head"><h2>Fleet</h2><span>MOCK DATA</span></div>
          <div className="preset-row">{FLEET_PRESETS.map((p) => <button key={p.name} className={preset === p ? 'on' : ''} onClick={() => update(p.spec)}>{p.name}</button>)}</div>
          <Slider label="Machines" value={s.machines} min={1} max={16} onChange={(v) => update({ machines: v })} />
          <Slider label="Projects" value={s.projects} min={1} max={40} onChange={(v) => update({ projects: v })} />
          <Slider label="Busy now" value={s.active} min={0} max={s.projects} onChange={(v) => update({ active: v })} />
          <Slider label="Worked in last 3 days" value={s.resting} min={0} max={s.projects - s.active} onChange={(v) => update({ resting: v })} />
          <label className="check"><input type="checkbox" checked={s.hermes} onChange={(e) => update({ hermes: e.target.checked })} /> Hermes hall</label>
          <label><span>SCREEN</span><select value={s.screen} onChange={(e) => update({ screen: e.target.value })}>{Object.entries(SCREENS).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}</select></label>
          <div className="section-head"><h2>Study</h2><span>B ONLY</span></div>
          <label className="check"><input type="checkbox" checked={s.tiers} onChange={(e) => update({ tiers: e.target.checked })} /> Size stations by activity</label>
          <label className="check"><input type="checkbox" checked={s.lit} onChange={(e) => update({ lit: e.target.checked })} /> Lines only where work flows</label>
          <label className="check"><input type="checkbox" checked={s.shape} onChange={(e) => update({ shape: e.target.checked })} /> Shape wings to the screen</label>
          <div className="section-head"><h2>View</h2></div>
          <div className="preset-row"><button className={s.same ? 'on' : ''} onClick={() => update({ same: true })}>Same scale</button><button className={!s.same ? 'on' : ''} onClick={() => update({ same: false })}>Fit each</button></div>
          <p className="hint">Scroll to zoom, drag to pan. “Screen zoom” shows a layout at the zoom the map would settle on for the chosen screen. Below ½ the live map switches to its flat fleet view, which this lab doesn’t draw.</p>
        </aside>
        <section className="viewer" ref={viewerRef}>
          <div className="viewer-toolbar"><span>{hover ? `HOVER · ${hover.toUpperCase()}` : 'HOVER A MACHINE OR STATION TO SEE ITS SUPPLY LINES'}</span></div>
          <div className="panel-stats">
            <div className="scene-label">A / LIVE LAYOUT</div>
            <Stat k="World" v={a.size} /><Stat k="Fits at" v={`${zoomLabel(a.z)} · ${a.art ? 'art' : 'flat view'}`} /><Stat k="Crew height" v={`${a.crewPx}px`} /><Stat k="Lines" v={`${a.lines}`} /><Stat k="Stations" v={`${live.stations.length} full`} />
          </div>
          <FleetCanvas model={live} scale={s.same ? same : fit(live)} screenZoom={a.z} height={panelH} label="computeFleetLayout · as shipped" onHover={(h) => setHover(h?.label)} />
          <div className="panel-stats">
            <div className="scene-label">B / STUDY</div>
            <Stat k="World" v={`${b.size} · ${Math.round((100 * b.area) / a.area)}% area`} good={b.area < a.area} /><Stat k="Fits at" v={`${zoomLabel(b.z)} · ${b.art ? 'art' : 'flat view'}`} good={b.z > a.z} /><Stat k="Crew height" v={`${b.crewPx}px`} good={b.crewPx > a.crewPx} /><Stat k="Lines" v={`${b.lines} lit · ${b.allLines} on hover`} good={b.lines < a.lines} /><Stat k="Stations" v={`${tiered.stations.length} full · ${tiered.modules.length} cryo · ${tiered.capsules.length} docked`} />
          </div>
          <FleetCanvas model={tiered} scale={s.same ? same : fit(tiered)} screenZoom={b.z} height={panelH} label="computeTieredLayout · study" onHover={(h) => setHover(h?.label)} />
        </section>
      </div>
      <section className="rules">
        <div><p className="eyebrow">01 / STATIONS SIZED BY ACTIVITY</p><h3>Full, cryo, docked</h3><p>A project with crew awake, or active in the last 30 minutes, keeps its full station. One that worked in the last three days shrinks to a cryo module: its nameplate, three pods and its machines’ chips, about a fifth of the area. Anything quieter docks as a capsule in a rack below the wings. Busy stations sort to the top, next to the machines.</p></div>
        <div><p className="eyebrow">02 / LINES WHERE WORK FLOWS</p><h3>Chips, not wiring</h3><p>Every machine that serves a station has a chip in its colour on the port plate, bright while it has crew there. Only those pairs get a supply line and a corridor lane. The other pairs draw only on hover, so the wiring grows with active work, not with machines × projects.</p></div>
        <div><p className="eyebrow">03 / KEEL AND SHAPE</p><h3>Balanced decks, screen-shaped wings</h3><p>Up to six machines sit in one row. Past six, they split into two brick rows, so 7 becomes 4 + 3 and every upper deck drops straight through a gap below. The study tries one to four wings and keeps the one the chosen screen fits at the highest crisp zoom.</p></div>
        <div><p className="eyebrow">NOT YET IN THIS STUDY</p><h3>Open questions</h3><p>How a station animates between tiers. A designed flat fleet view for zooms below ½. A compact machine deck for very large keels. Whether projects needing attention should stay full size even when quiet.</p></div>
      </section>
    </main>
    <footer>REVIEW PROTOTYPE / Original sprites and palette. Mock fleet; the live map is unchanged.</footer>
  </>;
}
createRoot(document.getElementById('root')!).render(<App />);
