/* eslint-disable react-refresh/only-export-components -- Standalone review-page entrypoint. */
// Scale lab: the live fleet layout beside a tiered study, on a made-up fleet of any size. Mock data
// only; nothing here talks to an environment or changes the live map.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { computeFleetLayout } from './game/layout';
import { computeCoreStation, fitZoom, type Viewport } from './game/core-station';
import { FLEET_VIEW_ZOOM } from './game/map-common';
import { FLEET_PRESETS, makeFleet, type FleetSpec } from './lab/fleet-fixture';
import { fromCore, fromLive, hits, render, type Camera, type DrawModel, type Hit } from './lab/fleet-canvas';
import './designlab.css';
import './scalelab.css';

const SCREENS: Record<string, { name: string; viewport: Viewport }> = {
  laptop: { name: 'Laptop · 1600 × 1000', viewport: { w: 1600, h: 1000 } },
  desktop: { name: 'Desktop · 2560 × 1440', viewport: { w: 2560, h: 1440 } },
};
type Settings = FleetSpec & { screen: string; tiers: boolean; same: boolean };
const DEFAULTS: Settings = { ...FLEET_PRESETS[2].spec, screen: 'laptop', tiers: true, same: true };

function load(): Settings {
  const q = new URLSearchParams(location.search);
  const s = { ...DEFAULTS };
  for (const k of ['machines', 'projects', 'active', 'resting'] as const) { const v = Number(q.get(k)); if (q.has(k) && Number.isFinite(v)) s[k] = v; }
  for (const k of ['hermes', 'tiers', 'same'] as const) if (q.has(k)) s[k] = q.get(k) === '1';
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
    pipes: model.links.length,
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
  const core = useMemo(() => computeCoreStation(state, { tiers: s.tiers, viewport, now }), [state, s.tiers, viewport, now]);
  const tiered = useMemo(() => fromCore(state, core), [state, core]);
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
        <p>A is the live layout engine, unchanged. B builds the fleet as one station: Hermes on the crown, the machines as an engine room at the base, and every project docked straight onto an arm of the core. Supply runs as light lanes inside the structure. Both use the Flight Deck kit in Night Shift on a made-up fleet. Hover a machine or a project to trace its lanes.</p></div>
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
          <label className="check"><input type="checkbox" checked={s.tiers} onChange={(e) => update({ tiers: e.target.checked })} /> Quiet projects as cryo modules</label>
          <div className="section-head"><h2>View</h2></div>
          <div className="preset-row"><button className={s.same ? 'on' : ''} onClick={() => update({ same: true })}>Same scale</button><button className={!s.same ? 'on' : ''} onClick={() => update({ same: false })}>Fit each</button></div>
          <p className="hint">Scroll to zoom, drag to pan. “Screen zoom” shows a layout at the zoom the map would settle on for the chosen screen. Below ½ the live map switches to its flat fleet view, which this lab doesn’t draw.</p>
        </aside>
        <section className="viewer" ref={viewerRef}>
          <div className="viewer-toolbar"><span>{hover ? `HOVER · ${hover.toUpperCase()}` : 'HOVER A MACHINE OR PROJECT TO TRACE ITS SUPPLY'}</span></div>
          <div className="panel-stats">
            <div className="scene-label">A / LIVE LAYOUT</div>
            <Stat k="World" v={a.size} /><Stat k="Fits at" v={`${zoomLabel(a.z)} · ${a.art ? 'art' : 'flat view'}`} /><Stat k="Crew height" v={`${a.crewPx}px`} /><Stat k="Pipes" v={`${a.pipes} freestanding`} /><Stat k="Stations" v={`${live.stations.length} full`} />
          </div>
          <FleetCanvas model={live} scale={s.same ? same : fit(live)} screenZoom={a.z} height={panelH} label="computeFleetLayout · as shipped" onHover={(h) => setHover(h?.label)} />
          <div className="panel-stats">
            <div className="scene-label">B / STUDY</div>
            <Stat k="World" v={`${b.size} · ${Math.round((100 * b.area) / a.area)}% area`} good={b.area < a.area} /><Stat k="Fits at" v={`${zoomLabel(b.z)} · ${b.art ? 'art' : 'flat view'}`} good={b.z > a.z} /><Stat k="Crew height" v={`${b.crewPx}px`} good={b.crewPx > a.crewPx} /><Stat k="Pipes" v="none · lanes in the frame" good /><Stat k="Stations" v={`${tiered.stations.length} full · ${tiered.modules.length} cryo · ${core.levels} level${core.levels > 1 ? 's' : ''}`} />
          </div>
          <FleetCanvas model={tiered} scale={s.same ? same : fit(tiered)} screenZoom={b.z} height={panelH} label="computeCoreStation · study" onHover={(h) => setHover(h?.label)} />
        </section>
      </div>
      <section className="rules">
        <div><p className="eyebrow">01 / ONE STATION</p><h3>A core, not a campus</h3><p>Hermes’s hall is the command module on the crown. The machines’ engineering decks are the engine room at the base. Between them the core rises through chamfered hubs, and symmetric arms branch off it level by level.</p></div>
        <div><p className="eyebrow">02 / EVERY PROJECT DOCKED</p><h3>Collars, all of them visible</h3><p>Each project docks straight onto an arm through a short collar, above or below it, mirrored either side of the core. Busy projects keep their full station, nearest the core. Quiet ones stay aboard as cryo modules with their name, pods and machines further out. Nothing is hidden.</p></div>
        <div><p className="eyebrow">03 / SUPPLY IN THE FRAME</p><h3>Light lanes, not pipes</h3><p>Each machine owns one lane: up from its deck through the manifold, up the core, and out along the arms it serves. A lane glows while that machine has crew awake there and dims otherwise. Hover a project to trace its machines’ lanes from the engine room to its collar.</p></div>
        <div><p className="eyebrow">NOT YET IN THIS STUDY</p><h3>Open questions</h3><p>How modules animate between full and cryo. A designed flat view for zooms below ½. Exterior detail: radiators, solar wings, lights along the arms. Whether projects needing attention should stay full size even when quiet.</p></div>
      </section>
    </main>
    <footer>REVIEW PROTOTYPE / Original sprites and palette. Mock fleet; the live map is unchanged.</footer>
  </>;
}
createRoot(document.getElementById('root')!).render(<App />);
