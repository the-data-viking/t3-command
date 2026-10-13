import { diskLevel, gb, type StorageView } from "../../shared/storage";
import { useGame } from "../store";
import { storageSummary } from "../t3/storage";
import { BarChart } from "./BarChart";

const BUCKET_MS = 6 * 3_600_000;
const SHOWN = 8;

/** Peak disk use per 6-hour block over the last week. */
function trendBars(trend: StorageView["trend"], now: number) {
  const buckets = new Map<number, number>();
  for (const p of trend) {
    const k = Math.floor(p.at / BUCKET_MS);
    buckets.set(k, Math.max(buckets.get(k) ?? 0, p.usedFraction));
  }
  const last = Math.floor(now / BUCKET_MS);
  const first = Math.min(...buckets.keys(), last);
  const bars = [];
  for (let k = Math.max(first, last - 27); k <= last; k++) {
    const at = new Date(k * BUCKET_MS);
    const value = buckets.get(k);
    bars.push({ label: at.toLocaleDateString([], { weekday: "short" }), value: value === undefined ? 0 : value * 100,
      detail: `${at.toLocaleString([], { weekday: "short", hour: "numeric" })}: ${value === undefined ? "no sample" : `${Math.round(value * 100)}% used`}` });
  }
  return bars;
}

export function StorageSection({ envId, now }: { envId: string; now: number }) {
  const view = useGame((s) => s.storage[envId]);
  const threads = useGame((s) => s.envs[envId]?.threads);
  const summary = storageSummary(view, now);
  const latest = view?.latest;
  const worktrees = latest?.worktrees;
  const owner = (path: string) => Object.values(threads ?? {}).find((t) => t.worktreePath === path);
  const bars = view && view.trend.length > 1 ? trendBars(view.trend, now) : [];
  return <>
    <h3>Storage</h3>
    {!latest && <p className="muted small">Measured by the Command server every 5 minutes; the first reading arrives shortly after it starts.</p>}
    {summary.stale && <p className="orange small">Last reading {new Date(latest!.sampledAt).toLocaleString()} · stale</p>}
    {latest?.error && <p className="orange small">{latest.error}</p>}
    {latest?.volumes.map((v) => {
      const used = v.totalBytes > 0 ? (v.totalBytes - v.availableBytes) / v.totalBytes : 0;
      const level = diskLevel(v);
      return (
        <div key={v.mount} className="storage-volume">
          <div className="host-stat"><span title={v.mount}>Disk {v.mount}</span><strong className={level === "ok" ? undefined : `gauge-${level}`}>{Math.round(used * 100)}%</strong></div>
          <meter min={0} max={100} low={85} high={95} optimum={0} value={used * 100} aria-label={`Disk ${v.mount} used percentage`} />
          <p className="muted small">{gb(v.availableBytes)} free of {gb(v.totalBytes)}{level === "critical" ? " · nearly full" : level === "high" ? " · running low" : ""}</p>
        </div>
      );
    })}
    {bars.length > 1 && <BarChart label="Peak disk use per 6 hours, last 7 days" ceiling={100} points={bars} color="var(--chart-neutral)" />}
    {worktrees && <>
      <div className="host-stat"><span>T3 worktrees</span><strong>{gb(worktrees.totalBytes)}</strong></div>
      {worktrees.entries.length === 0 && <p className="muted small">No T3 worktrees on this machine.</p>}
      <ul className="storage-worktrees">
        {worktrees.entries.slice(0, SHOWN).map((w) => {
          const thread = owner(w.path);
          return (
            <li key={w.path} title={w.path}>
              <span className="storage-name">{thread?.title || w.path.split(/[\\/]/).pop()}</span>
              <span className="muted small">{w.project}{thread ? "" : " · no thread"}</span>
              <strong>{gb(w.bytes)}</strong>
            </li>
          );
        })}
      </ul>
      {worktrees.entries.length > SHOWN && <p className="muted small">+{worktrees.entries.length - SHOWN} smaller worktrees</p>}
      {worktrees.scratchBytes !== undefined && <div className="host-stat"><span title="~/.t3/scratch">Scratch folder</span><strong>{gb(worktrees.scratchBytes)}</strong></div>}
      <p className="muted small">Measured {new Date(worktrees.measuredAt).toLocaleTimeString()} · every 15 minutes. “No thread” means no current T3 thread on this machine uses that worktree.</p>
    </>}
  </>;
}
