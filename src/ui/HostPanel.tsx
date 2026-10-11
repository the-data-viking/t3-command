import { useGame } from "../store";
import { gib, hostView } from "../t3/host";
import { BarChart } from "./BarChart";
import { useClock } from "./useClock";

export function HostPanel({ envId }: { envId: string }) {
  const env = useGame((s) => s.envs[envId]);
  const host = useGame((s) => s.hosts[envId]);
  const now = useClock();
  const view = hostView(host, env?.connection ?? "offline", now);
  const s = view.snapshot;
  const points = host?.history.filter((h) => hostView({ snapshot: h, history: [] }, "live", now).cpuFraction !== undefined && now - h.sampledAt < 20 * 60_000) ?? [];
  return (
    <aside className="panel host-panel" aria-label="Engineering host resources">
      <header className="panel-head">
        <div className="panel-title"><h2>{env?.summary.label ?? "Host"}</h2><div className="muted small">Engineering · whole-host resources</div></div>
        <button className="icon-btn" title="Close host details" aria-label="Close host details" onClick={() => useGame.setState({ hostPanel: null })}>✕</button>
      </header>
      <div className="host-body">
        {view.stale && <p className="orange">Last known sample · stale</p>}
        {!s && <p className="muted">{host?.error ?? "Loading host resources…"}</p>}
        {s && <>
          <div className="host-stat"><span>CPU load</span><strong>{view.cpuFraction === undefined ? "Unavailable" : `${Math.round(view.cpuFraction * 100)}%`}</strong></div>
          {view.cpuFraction !== undefined && <meter min={0} max={100} low={85} high={95} optimum={0} value={view.cpuFraction * 100} aria-label="Whole-host CPU utilization" />}
          <p className="muted small">Across {s.cpuCount} logical processors</p>
          <div className="host-stat"><span>RAM used</span><strong>{view.memoryFraction === undefined ? "Unavailable" : `${Math.round(view.memoryFraction * 100)}%`}</strong></div>
          {view.memoryFraction !== undefined && <meter min={0} max={100} low={85} high={95} optimum={0} value={view.memoryFraction * 100} aria-label="RAM used percentage" />}
          {view.memoryFraction !== undefined && <p className="muted small">{gib(s.totalMemoryBytes - s.availableMemoryBytes)} of {gib(s.totalMemoryBytes)} used · {gib(s.availableMemoryBytes)} available</p>}
          {points.length > 1 && <>
            <h3>Observed CPU load</h3>
            <BarChart label="CPU samples from this browser, up to 20 minutes" ceiling={100} points={points.map((p) => ({ label: new Date(p.sampledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), value: p.cpuUtilization! * 100, detail: `${new Date(p.sampledAt).toLocaleTimeString()}: ${Math.round(p.cpuUtilization! * 100)}% CPU` }))} />
          </>}
          <p className="muted small">Sampled {new Date(s.sampledAt).toLocaleTimeString()} · refreshes every 10 seconds while visible.</p>
        </>}
        {host?.error && s && <p className="orange small">{host.error}</p>}
        <p className="muted small">Includes all applications on this machine. RAM used is total minus reported availability; it does not measure memory pressure.</p>
      </div>
    </aside>
  );
}
