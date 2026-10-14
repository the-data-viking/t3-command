// The fleet timeline: every crew member's turns over the last hours, one lane each, grouped by
// project, with what's running or waiting on you now at the right edge.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { agentMs, type TimelineView } from "../../shared/history";
import { worldRef } from "../game/world";
import { setSelection, useGame } from "../store";
import { fetchJson } from "../t3/environment";
import { buildTimeline, ticks, type Bar, type BarTone, type Lane } from "./timeline";
import { useClock } from "./useClock";

const RANGES = [{ hours: 6, label: "6h" }, { hours: 24, label: "24h" }, { hours: 72, label: "3d" }] as const;
const REFRESH_MS = 60_000;

/** Each tone's colour token, shape and words: identity never rests on colour alone. */
const TONES: Record<BarTone, { color: string; mark: string; label: string }> = {
  done: { color: "var(--done)", mark: "✓", label: "Done" },
  error: { color: "var(--error)", mark: "✕", label: "Failed" },
  interrupted: { color: "var(--idle)", mark: "–", label: "Interrupted" },
  working: { color: "var(--working)", mark: "▶", label: "Running now" },
  alert: { color: "var(--alert)", mark: "▲", label: "Waiting on your approval" },
  question: { color: "var(--question)", mark: "◆", label: "Waiting on your answer" },
};

function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${Math.max(1, m)}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const clock = (t: number, withDay: boolean) =>
  new Date(t).toLocaleString([], withDay ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });

export function TimelinePanel() {
  const [hours, setHours] = useState<number>(24);
  const [view, setView] = useState<TimelineView>();
  const [error, setError] = useState<string>();
  const [hover, setHover] = useState<{ lane: Lane; bar: Bar; x: number; y: number }>();
  const envs = useGame((s) => s.envs);
  const now = useClock();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const load = () => fetchJson<TimelineView>(`/api/history/timeline?hours=${hours}`)
      .then((v) => { if (live) { setView(v); setError(undefined); } })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : String(err)); });
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => { live = false; clearInterval(timer); };
  }, [hours]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      useGame.setState({ showTimeline: false });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // The window ends now and slides with the clock between fetches.
  const to = now, from = to - hours * 3_600_000;
  const groups = useMemo(() => (view ? buildTimeline({ ...view, from, to }, envs, now) : []), [view, envs, now, from, to]);
  const lanes = groups.reduce((n, g) => n + g.lanes.length, 0);
  const turns = groups.reduce((n, g) => n + g.lanes.reduce((m, l) => m + l.bars.filter((b) => !b.live).length, 0), 0);
  const live = groups.reduce((n, g) => n + g.lanes.filter((l) => l.bars.some((b) => b.live)).length, 0);
  const pct = (t: number) => ((t - from) / (to - from)) * 100;
  const close = () => useGame.setState({ showTimeline: false });
  const open = (lane: Lane) => {
    if (!envs[lane.envId]?.threads[lane.threadId]) return;
    const sel = { kind: "unit" as const, envId: lane.envId, threadId: lane.threadId };
    setSelection(sel);
    worldRef.current?.focus(sel);
    close();
  };
  const axis = ticks(from, to);
  // Tooltip position inside the (scrolling) dialog, flipped left near its right edge.
  const place = (clientX: number, clientY: number) => {
    const el = box.current!, r = el.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top + el.scrollTop;
    return { x: x > r.width - 360 ? x - 344 : x + 12, y: y + 14 };
  };

  return createPortal(
    <div className="modal-backdrop" onClick={close}>
      <div className="modal timeline-modal" ref={box} role="dialog" aria-label="Fleet timeline" onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2>Fleet timeline</h2>
          <span className="spacer" />
          <div className="history-ranges" role="group" aria-label="Range">
            {RANGES.map((r) => <button key={r.hours} className={`btn small ${r.hours === hours ? "primary" : ""}`} aria-pressed={r.hours === hours} onClick={() => setHours(r.hours)}>{r.label}</button>)}
          </div>
          <button className="icon-btn" aria-label="Close timeline" onClick={close}>✕</button>
        </header>
        <div className="tl-legend" aria-label="Legend">
          {(Object.keys(TONES) as BarTone[]).map((t) => (
            <span key={t} className="tl-legend-item"><i className="tl-swatch" style={{ background: TONES[t].color }} />{TONES[t].mark} {TONES[t].label}</span>
          ))}
          <span className="tl-legend-item"><i className="tl-swatch tl-wait-swatch" />Waiting on you (within a turn)</span>
        </div>
        {error && <p className="small" role="alert">Could not load the timeline: {error}</p>}
        {!view && !error && <p className="muted">Loading…</p>}
        {view && (
          <div className="tl" onPointerLeave={() => setHover(undefined)}>
            <div className="tl-row tl-axis">
              <span className="tl-label-col" />
              <div className="tl-track">
                {axis.map((t) => <span key={t} className="tl-tick" style={{ left: `${pct(t)}%` }}>{clock(t, hours > 24)}</span>)}
                <span className="tl-tick tl-tick-now" style={{ left: "100%" }}>now</span>
              </div>
            </div>
            {groups.length === 0 && <p className="muted small">No turns in the last {hours} hours.</p>}
            {groups.map((g) => (
              <section key={g.project} className="tl-group" aria-label={g.project}>
                <h3 className="tl-group-name">{g.project}</h3>
                {g.lanes.map((lane) => (
                  <div key={lane.key} className="tl-row">
                    <button className="tl-label-col tl-label" title={`${lane.title} · ${lane.machine}`} onClick={() => open(lane)}>
                      <span className="tl-title">{lane.title}</span><span className="muted small">{lane.machine}</span>
                    </button>
                    <div className="tl-track">
                      {axis.map((t) => <i key={t} className="tl-grid" style={{ left: `${pct(t)}%` }} />)}
                      {lane.bars.map((bar, k) => (
                        <button key={k} className={`tl-bar ${bar.live ? "live" : ""}`} aria-label={`${TONES[bar.tone].label}: ${clock(bar.start, true)} to ${bar.live ? "now" : clock(bar.end, true)}`}
                          style={{ left: `${pct(bar.start)}%`, width: `max(4px, calc(${pct(bar.end) - pct(bar.start)}% - 2px))`, background: TONES[bar.tone].color }}
                          onPointerEnter={(e) => setHover({ lane, bar, ...place(e.clientX, e.clientY) })}
                          onFocus={(e) => { const b = e.currentTarget.getBoundingClientRect(); setHover({ lane, bar, ...place(b.left, b.bottom) }); }}
                          onBlur={() => setHover(undefined)}
                          onClick={() => open(lane)}>
                          {(bar.record?.waits ?? []).map(([w0, w1], j) => {
                            const len = bar.end - bar.start;
                            if (len <= 0 || w1 <= bar.start) return null;
                            const a = Math.max(0, (w0 - bar.start) / len), b = Math.min(1, (w1 - bar.start) / len);
                            return <i key={j} className="tl-wait" style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }} />;
                          })}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            ))}
          </div>
        )}
        {hover && <Tooltip {...hover} />}
        {view && <p className="muted small">{turns} turn{turns === 1 ? "" : "s"} finished · {lanes} crew · {live} running or waiting now. Click a lane to go to its crew member. Finished turns come from the Command server's history; the right edge is live.</p>}
      </div>
    </div>,
    document.body,
  );
}

function Tooltip({ lane, bar, x, y }: { lane: Lane; bar: Bar; x: number; y: number }) {
  const r = bar.record;
  const tone = TONES[bar.tone];
  return (
    <div className="tl-tooltip hud-frame" role="tooltip" style={{ left: x, top: y }}>
      <strong>{lane.title}</strong>
      <span className="muted small">{lane.machine}{r ? ` · ${r.model}` : ""}</span>
      <span><i className="tl-swatch" style={{ background: tone.color }} />{tone.mark} {tone.label}</span>
      <span className="small">{clock(bar.start, true)} → {bar.live ? "now" : clock(bar.end, true)} · {duration(bar.end - bar.start)}</span>
      {r && <span className="small muted">Agent {duration(agentMs(r))}{r.waitMs ? ` · waited on you ${duration(r.waitMs)}` : ""}</span>}
      {r?.error && <span className="small">{r.error}</span>}
    </div>
  );
}
