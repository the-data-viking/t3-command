import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useGame } from "../store";
import { fleetSpend, formatSpend, historyWindow, todayWindow } from "../t3/usage";
import { BarChart } from "./BarChart";
import { useClock } from "./useClock";

export function SpendTelemetry() {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const envs = useGame((s) => s.envs);
  const now = useClock();
  const window = todayWindow(new Date(now));
  const history = historyWindow(new Date(now));
  const stations = useMemo(() => Object.values(envs).map((e) => ({
    id: e.summary.id, label: e.summary.label, connection: e.connection, usage: e.usage,
  })), [envs]);
  const spend = fleetSpend(stations, window);
  const trend = fleetSpend(stations, history);

  useEffect(() => {
    if (!open) return;
    const close = () => { if (disclosure.current) disclosure.current.open = false; setOpen(false); };
    const outside = (event: PointerEvent) => {
      if (!disclosure.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);

  return (
    <>
    <details ref={disclosure} className="spend-menu" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="resource" aria-controls="spend-breakdown" aria-expanded={open} title="Today's API-equivalent estimate; open station breakdowns">
        <span className="res-key">EST. TODAY</span>
        <span className="res-val green">{spend.costUsd === undefined ? "—" : formatSpend(spend.costUsd)}{spend.partial && spend.costUsd !== undefined ? "*" : ""}</span>
      </summary>
    </details>
    {open && createPortal(<section ref={panel} id="spend-breakdown" className="spend-breakdown hud-frame" aria-label="Today's estimated spend">
        <h3>Today's fleet estimate</h3>
        <p className="muted small">{window.sinceDay} · {window.timeZone} · USD</p>
        <p className="small">API-equivalent value of local provider usage, including work outside T3 Code. Subscription charges are billed separately.</p>
        {trend.costUsd !== undefined && <>
          <div className="spend-station-head"><strong>Last 7 days</strong><span>{formatSpend(trend.costUsd)}{trend.partial ? "*" : ""}</span></div>
          <BarChart label="Daily API-equivalent usage, last 7 days" points={trend.daily.map((p) => ({ label: p.day.slice(5), value: p.costUsd, detail: `${p.day}: ${formatSpend(p.costUsd)}` }))} />
          <details className="daily-totals"><summary className="muted small">Daily totals</summary><table><tbody>{trend.daily.map((p) => <tr key={p.day}><td>{p.day}</td><td>{formatSpend(p.costUsd)}</td></tr>)}</tbody></table></details>
        </>}
        {spend.cacheAvailable && <div className="spend-cache">
          <div className="spend-station-head"><strong>Today's input cached</strong><span>{spend.inputTokens > 0 ? `${Math.round(spend.cachedInputTokens / spend.inputTokens * 100)}%` : "No input yet"}</span></div>
          {spend.inputTokens > 0 && <meter min={0} max={100} value={spend.cachedInputTokens / spend.inputTokens * 100} aria-label="Cached input share today" />}
          <p className="muted small">{formatSpend(spend.cacheSavingsUsd)} estimated API-equivalent cache savings{spend.partial ? " · partial coverage" : ""}.</p>
        </div>}
        {spend.rows.length === 0 && <p className="muted">No stations connected.</p>}
        {spend.rows.map((row) => (
          <div className="spend-station" key={row.id}>
            <div className="spend-station-head"><strong>{row.label}</strong><span>{row.costUsd === undefined ? "—" : formatSpend(row.costUsd)}</span></div>
            {row.readAt && <div className="muted small">Updated {new Date(row.readAt).toLocaleTimeString()}</div>}
            {row.sharedSources > 0 && <div className="muted small">{row.sharedSources} shared source{row.sharedSources === 1 ? "" : "s"} counted at another station.</div>}
            {row.unpricedRecords > 0 && <div className="orange small">{row.unpricedRecords} unpriced response{row.unpricedRecords === 1 ? "" : "s"} excluded from cost.</div>}
            {row.notes.map((note) => <div className="muted small" key={note}>{note}</div>)}
          </div>
        ))}
        <p className="muted small">Refreshes every minute while visible. Shared sources count once in the fleet total.{spend.partial || trend.partial ? " * Estimate has coverage or freshness gaps." : ""}</p>
      </section>, document.body)}
    </>
  );
}
