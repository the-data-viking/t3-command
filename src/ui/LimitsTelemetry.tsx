import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useGame } from "../store";
import { fleetLimits, limitLevel } from "../t3/limits";
import { useClock } from "./useClock";

function resetsIn(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "resetting";
  const h = Math.floor(ms / 3_600_000);
  return h >= 48 ? `resets in ${Math.floor(h / 24)}d ${h % 24}h` : h >= 1 ? `resets in ${h}h ${Math.floor(ms / 60_000) % 60}m` : `resets in ${Math.ceil(ms / 60_000)}m`;
}

/** Compact countdown for the top bar: "40m", "3h12m", "2d". */
function resetShort(iso: string | undefined, now: number): string | undefined {
  const ms = iso ? Date.parse(iso) - now : NaN;
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const m = Math.ceil(ms / 60_000);
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h${m % 60 ? `${String(m % 60).padStart(2, "0")}m` : ""}` : `${Math.round(m / 1440)}d`;
}

/** Provider quota use across the fleet, with notes on providers that can't report it. */
export function LimitsTelemetry() {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const envs = useGame((s) => s.envs);
  const now = useClock();
  const limits = useMemo(() => fleetLimits(Object.values(envs)), [envs]);

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

  if (!limits.windows.length && !limits.notes.length) return null;
  const level = limits.peak === undefined ? undefined : limitLevel(limits.peak);
  // Telegraph the squeeze: when the fullest quota is high, when it gives capacity back.
  const fullest = limits.windows.reduce<typeof limits.windows[number] | undefined>((a, w) => (!a || w.usedPercent > a.usedPercent ? w : a), undefined);
  const reset = level && level !== "ok" ? resetShort(fullest?.resetsAt, now) : undefined;
  const { coverage } = limits;
  const partial = coverage.reporting < coverage.total;
  const silentText = coverage.silent.map((s) => `${s.provider} on ${s.machines.length === 1 ? s.machines[0] : `${s.machines.length} machines`} ${s.failed ? "couldn't be read" : "doesn't report limits"}`).join("; ");
  return (
    <>
      <details ref={disclosure} className="spend-menu" onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="resource" aria-controls="limits-breakdown" aria-expanded={open}
          title={partial ? `Fullest reported quota. Only ${coverage.reporting} of ${coverage.total} provider sign-ins report limits: ${silentText}.` : "Fullest provider quota across the fleet"}>
          <span className="res-key">LIMITS</span>
          <span className="res-val" style={level ? { color: `var(--gauge-${level})` } : undefined}>{limits.peak === undefined ? "—" : `${limits.peak}%`}</span>
          {reset && <span className="res-reset" title={`${fullest!.provider} · ${fullest!.label} ${resetsIn(fullest!.resetsAt, now)}`}>↺{reset}</span>}
          {partial && <span className="res-partial" aria-label={`${coverage.reporting} of ${coverage.total} report`}>{coverage.reporting}/{coverage.total}</span>}
        </summary>
      </details>
      {open && createPortal(<section ref={panel} id="limits-breakdown" className="spend-breakdown hud-frame" aria-label="Provider rate limits">
        <h3>Provider limits</h3>
        <p className={partial ? "orange small" : "muted small"}>
          {partial
            ? `Covers ${coverage.reporting} of ${coverage.total} provider sign-ins. The headline is the fullest of these, not the whole fleet.`
            : "Every provider sign-in reports its quota."}
        </p>
        {coverage.silent.length > 0 && (
          <ul className="history-list">
            {coverage.silent.map((s) => <li key={`${s.provider}${s.failed}`}><strong>{s.provider}</strong> {s.failed ? "couldn't be read" : "doesn't report limits"} on {s.machines.join(", ")}</li>)}
          </ul>
        )}
        <p className="muted small">Machines signed in to the same account share a row.</p>
        {limits.windows.map((w) => (
          <div className="spend-station" key={`${w.provider}|${w.label}|${w.resetsAt}|${w.machines.join()}`}>
            <div className="spend-station-head"><strong>{w.provider} · {w.label}</strong><span style={{ color: `var(--gauge-${limitLevel(w.usedPercent)})` }}>{w.usedPercent}%</span></div>
            <span className="hp"><span className="hp-fill" style={{ width: `${w.usedPercent}%`, background: `var(--gauge-${limitLevel(w.usedPercent)})` }} /></span>
            <div className="muted small">{[resetsIn(w.resetsAt, now), w.machines.join(", ")].filter(Boolean).join(" · ")}</div>
          </div>
        ))}
        {limits.notes.length > 0 && <>
          <h3>Provider notes</h3>
          {limits.notes.map((n) => (
            <div className="spend-station" key={`${n.provider}|${n.text}`}>
              <div className="small"><strong>{n.provider}</strong>: {n.text}</div>
              <div className="muted small">{n.machines.join(", ")}</div>
            </div>
          ))}
        </>}
        <p className="muted small">Updates live as providers report new status.</p>
      </section>, document.body)}
    </>
  );
}
