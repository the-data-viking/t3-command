import { useEffect, useRef, useState } from "react";
import { HOST_RANGES, type HostHistory, type HostPoint } from "../../shared/host";
import { fetchJson } from "../t3/environment";

const W = 320, H = 132;
const PLOT = { left: 30, right: 270, top: 8, bottom: 104 };
const pct = (f: number | null | undefined) => (f === null || f === undefined ? "—" : `${Math.round(f * 100)}%`);

const x = (h: HostHistory, at: number) => PLOT.left + ((at - h.from) / Math.max(1, h.to - h.from)) * (PLOT.right - PLOT.left);
const y = (f: number) => PLOT.bottom - f * (PLOT.bottom - PLOT.top);

/** Polyline segments, broken where a value is missing or samples skip (machine offline). */
function segments(h: HostHistory, value: (p: HostPoint) => number | null): Array<Array<[number, number]>> {
  const gap = Math.max(3 * 60_000, ((h.to - h.from) / 240) * 3);
  const out: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  let last = -Infinity;
  for (const p of h.points) {
    const v = value(p);
    if (v === null || p.at - last > gap) { if (current.length) out.push(current); current = []; }
    if (v !== null) current.push([x(h, p.at), y(v)]);
    last = p.at;
  }
  if (current.length) out.push(current);
  return out;
}

const path = (pts: Array<[number, number]>) => pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");

function timeLabel(at: number, hours: number): string {
  return new Date(at).toLocaleString([], hours > 24 ? { weekday: "short", hour: "numeric" } : { hour: "numeric", minute: "2-digit" });
}

/** Whole-host CPU and RAM over the last hour, day or week, recorded by the Command server. */
export function HostHistoryChart({ envId }: { envId: string }) {
  const [hours, setHours] = useState<number>(24);
  const [history, setHistory] = useState<HostHistory>();
  const [error, setError] = useState<string>();
  const [hover, setHover] = useState<HostPoint>();
  const svg = useRef<SVGSVGElement>(null);

  useEffect(() => {
    let live = true;
    const load = () => fetchJson<HostHistory>(`/api/hosts/history?envId=${encodeURIComponent(envId)}&hours=${hours}`)
      .then((h) => { if (live) { setHistory(h); setError(undefined); } })
      .catch((err: Error) => { if (live) setError(err.message); });
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => { live = false; clearInterval(timer); };
  }, [envId, hours]);

  const points = history?.points ?? [];
  const last = [...points].reverse().find((p) => p.cpu !== null || p.mem !== null);
  const bucketed = points.some((p) => p.cpuPeak !== p.cpu);
  const cpu = history ? segments(history, (p) => p.cpu) : [];
  const ram = history ? segments(history, (p) => p.mem) : [];
  // Peak band: from each bucket's peak down to its average.
  const band = history && bucketed ? segments(history, (p) => p.cpuPeak).map((top) => {
    const lows = top.map(([px]) => {
      const p = points.find((q) => Math.abs(x(history, q.at) - px) < 0.01);
      return [px, y(p?.cpu ?? 0)] as [number, number];
    });
    return `${path(top)}L${lows.reverse().map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join("L")}Z`;
  }) : [];

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!history || !points.length || !svg.current) return;
    const box = svg.current.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * W;
    let best = points[0];
    for (const p of points) if (Math.abs(x(history, p.at) - sx) < Math.abs(x(history, best.at) - sx)) best = p;
    setHover(best);
  };

  return (
    <div className="host-history">
      <div className="host-history-head">
        <span className="chart-legend">
          <span><i className="swatch cpu" /> CPU{bucketed ? " (band: peak)" : ""}</span>
          <span><i className="swatch ram" /> RAM used</span>
        </span>
        <span className="history-ranges" role="group" aria-label="Range">
          {HOST_RANGES.map((r) => (
            <button key={r.hours} className="btn small" aria-pressed={hours === r.hours} onClick={() => setHours(r.hours)}>{r.label}</button>
          ))}
        </span>
      </div>
      {error && <p className="orange small">{error}</p>}
      {history && !points.length && <p className="muted small">No samples recorded for this range yet. The Command server samples every minute.</p>}
      {history && points.length > 0 && points[0].at - history.from > (history.to - history.from) * 0.05 && (
        <p className="muted small">Recorded since {new Date(points[0].at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}; nothing earlier is known.</p>
      )}
      {history && points.length > 0 && (
        <div className="host-history-plot">
          <svg ref={svg} viewBox={`0 0 ${W} ${H}`} role="img" onPointerMove={onMove} onPointerLeave={() => setHover(undefined)}
            aria-label={`CPU and RAM over the last ${HOST_RANGES.find((r) => r.hours === hours)?.label}. Latest CPU ${pct(last?.cpu)}, RAM ${pct(last?.mem)}.`}>
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line x1={PLOT.left} x2={PLOT.right} y1={y(f)} y2={y(f)} className="grid" />
                <text x={PLOT.left - 4} y={y(f) + 3} textAnchor="end" className="axis">{f * 100}%</text>
              </g>
            ))}
            {band.map((d, i) => <path key={i} d={d} className="band cpu" />)}
            {ram.map((s, i) => <path key={i} d={path(s)} className="line ram" />)}
            {cpu.map((s, i) => <path key={i} d={path(s)} className="line cpu" />)}
            {last && (
              <>
                {last.cpu !== null && <text x={PLOT.right + 6} y={y(last.cpu) + 3} className="end-label">CPU {pct(last.cpu)}</text>}
                {last.mem !== null && <text x={PLOT.right + 6} y={y(last.mem) + (last.cpu !== null && Math.abs(y(last.cpu) - y(last.mem)) < 10 ? (last.mem > last.cpu ? -6 : 12) : 3)} className="end-label">RAM {pct(last.mem)}</text>}
              </>
            )}
            <text x={PLOT.left} y={H - 8} className="axis">{timeLabel(history.from, hours)}</text>
            <text x={PLOT.right} y={H - 8} textAnchor="end" className="axis">now</text>
            {hover && <line x1={x(history, hover.at)} x2={x(history, hover.at)} y1={PLOT.top} y2={PLOT.bottom} className="crosshair" />}
          </svg>
          {hover && (
            <div className="chart-tooltip" style={{ left: `${Math.min(76, Math.max(24, (x(history, hover.at) / W) * 100))}%` }}>
              <strong>{new Date(hover.at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</strong>
              <span><i className="swatch cpu" /> CPU {pct(hover.cpu)}{hover.cpuPeak !== hover.cpu ? ` · peak ${pct(hover.cpuPeak)}` : ""}</span>
              <span><i className="swatch ram" /> RAM {pct(hover.mem)}</span>
            </div>
          )}
          <details className="chart-table">
            <summary className="small muted">Data table</summary>
            <table>
              <thead><tr><th>Time</th><th>CPU</th><th>CPU peak</th><th>RAM</th></tr></thead>
              <tbody>{points.map((p) => <tr key={p.at}><td>{new Date(p.at).toLocaleString()}</td><td>{pct(p.cpu)}</td><td>{pct(p.cpuPeak)}</td><td>{pct(p.mem)}</td></tr>)}</tbody>
            </table>
          </details>
        </div>
      )}
    </div>
  );
}
