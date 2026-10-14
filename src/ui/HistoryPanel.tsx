// Turn history recorded by the Command server, plus spend history from each machine's T3.

import { PixelLabel } from "./PixelArt";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { agentMs, type HistorySummary, type TurnRecord } from "../../shared/history";
import { worldRef } from "../game/world";
import { setSelection, useGame } from "../store";
import { envClient, fetchJson } from "../t3/environment";
import { unitState } from "../t3/derive";
import { fleetSpend, formatSpend, historyWindow, type UsageSummary } from "../t3/usage";
import { BarChart } from "./BarChart";
import { timeAgo } from "./util";
import { useClock } from "./useClock";

const RANGES = [7, 30, 90] as const;
/** Spend history comes from each machine's own usage scan; longer ranges get expensive. */
const SPEND_MAX_DAYS = 30;

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const OUTCOME_LABEL = { completed: "done", error: "failed", interrupted: "interrupted" } as const;

export function HistoryPanel() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(7);
  const [summary, setSummary] = useState<HistorySummary>();
  const [error, setError] = useState<string>();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    let live = true;
    setError(undefined);
    fetchJson<HistorySummary>(`/api/history?days=${days}&tz=${encodeURIComponent(timeZone)}`)
      .then((s) => { if (live) setSummary(s); })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : String(err)); });
    return () => { live = false; };
  }, [days, timeZone]);


  const close = () => useGame.setState({ showHistory: false });
  const t = summary?.totals;
  const max = Math.max(1, ...(summary?.daily ?? []).map((d) => d.completed + d.error + d.interrupted));
  return createPortal(
    <div className="modal-backdrop" onClick={close}>
      <div className="modal history-modal" role="dialog" aria-label="Turn history" onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2 className="title-tab"><PixelLabel text="Turn history" /></h2>
          <span className="spacer" />
          <div className="history-ranges" role="group" aria-label="Range">
            {RANGES.map((r) => <button key={r} className="btn small" aria-pressed={r === days} onClick={() => setDays(r)}>{r} days</button>)}
          </div>
          <button className="icon-btn" aria-label="Close history" onClick={close}>✕</button>
        </header>
        <p className="muted small">
          Turn times are the agent's own work; time waiting on your approvals and answers is shown separately.
          {" "}Recorded by the Command server for every station{summary?.recordingSince ? `, since ${new Date(summary.recordingSince).toLocaleString()}` : ""}.
          {" "}Kept 90 days. Days in {timeZone}.
        </p>
        {error && <p className="small" role="alert">Could not load history: {error}</p>}
        {!summary && !error && <p className="muted">Loading…</p>}
        {summary && t && <>
          <div className="history-totals">
            <Stat label="Turns" value={String(t.turns)} />
            <Stat label="Done" value={String(t.completed)} tone="done" />
            <Stat label="Failed" value={String(t.error)} tone="error" />
            <Stat label="Interrupted" value={String(t.interrupted)} />
            <Stat label="Failure rate" value={t.turns ? `${Math.round(t.error / t.turns * 100)}%` : "—"} />
            <Stat label="Typical turn" value={formatDuration(t.medianMs)} />
            <Stat label="Slowest 10%" value={t.p90Ms === undefined ? "—" : `≥ ${formatDuration(t.p90Ms)}`} />
            <Stat label="Longest" value={formatDuration(t.longestMs)} />
            <Stat label="Waiting on you" value={formatDuration(t.waitingMs)} />
          </div>

          <h3>Turns per day</h3>
          <div className="history-bars" role="img" aria-label={summary.daily.map((d) => `${d.day}: ${d.completed} done, ${d.error} failed, ${d.interrupted} interrupted`).join(". ")}>
            {summary.daily.map((d) => (
              <div key={d.day} className="history-bar" title={`${d.day}: ${d.completed} done, ${d.error} failed, ${d.interrupted} interrupted · ${formatDuration(d.durationMs)} working`}>
                <span className="seg seg-interrupted" style={{ height: `${d.interrupted / max * 100}%` }} />
                <span className="seg seg-error" style={{ height: `${d.error / max * 100}%` }} />
                <span className="seg seg-completed" style={{ height: `${d.completed / max * 100}%` }} />
              </div>
            ))}
          </div>
          <div className="history-axis muted small"><span>{summary.daily[0]?.day.slice(5)}</span><span>{summary.daily.at(-1)?.day.slice(5)}</span></div>
          <p className="muted small"><span className="legend seg-completed" /> done <span className="legend seg-error" /> failed <span className="legend seg-interrupted" /> interrupted</p>

          <SpendHistory days={Math.min(days, SPEND_MAX_DAYS)} timeZone={timeZone} />

          <div className="history-columns">
            <Ranking title="Projects" rows={summary.projects} />
            <Ranking title="Models" rows={summary.models} />
          </div>

          {summary.topErrors.length > 0 && <>
            <h3>Most common failures</h3>
            <ul className="history-list">{summary.topErrors.map((e) => <li key={e.error}><strong>{e.count}×</strong> {e.error}</li>)}</ul>
          </>}

          {summary.gaps.length > 0 && <>
            <h3>Not recording</h3>
            <p className="muted small">Turns can be missing here: only each thread's latest turn is recovered after a gap.</p>
            <ul className="history-list">{summary.gaps.map((g) => <li key={`${g.envId}${g.from}`}>{g.envLabel}: {new Date(g.from).toLocaleString()} → {new Date(g.to).toLocaleString()}</li>)}</ul>
          </>}

          <LongTurns longest={summary.longest ?? []} />

          <h3>Recent turns</h3>
          {summary.recent.length === 0 && <p className="muted small">No turns recorded in this range yet.</p>}
          <ol className="history-list history-recent">
            {summary.recent.map((r) => (
              <li key={`${r.envId}${r.threadId}${r.turnId}`}>
                <span className={`pill state-${r.outcome === "completed" ? "done" : r.outcome === "error" ? "error" : "idle"}`}>{OUTCOME_LABEL[r.outcome]}</span>
                <span className="history-title" title={r.error ?? r.threadTitle}>{r.threadTitle}</span>
                <span className="muted small">{r.envLabel} · started {startTime(r.startedAt)} · {formatDuration(r.durationMs)} · {timeAgo(r.completedAt)}</span>
              </li>
            ))}
          </ol>
        </>}
      </div>
    </div>,
    document.body,
  );
}

/** Turns running over an hour right now (live), and the longest finished ones in the range. */
function LongTurns({ longest }: { longest: TurnRecord[] }) {
  const envs = useGame((s) => s.envs);
  const now = useClock(true, 10000);
  const running = Object.values(envs).flatMap((env) => Object.values(env.threads)
    .filter((t) => t.latestTurn?.state === "running" && t.latestTurn.startedAt && now - Date.parse(t.latestTurn.startedAt) > LONG_MS)
    .map((t) => ({ env, t, ms: now - Date.parse(t.latestTurn!.startedAt!) })))
    .sort((a, b) => b.ms - a.ms);
  const open = (envId: string, threadId: string) => {
    const sel = { kind: "unit" as const, envId, threadId };
    useGame.setState({ showHistory: false });
    setSelection(sel);
    worldRef.current?.focus(sel);
  };
  if (!running.length && !longest.length) return null;
  return <>
    <h3>Long-running turns</h3>
    {running.length > 0 && <>
      <p className="muted small">Running for over an hour now (wall time, including waits on you):</p>
      <ol className="history-list history-recent">
        {running.map(({ env, t, ms }) => (
          <li key={`${env.summary.id}${t.id}`}>
            {(() => {
              // What the turn is doing now, as its colour says everywhere else: a turn waiting on
              // you isn't "running" in working cyan.
              const st = unitState(t);
              const live = st === "alert" ? "Needs approval" : st === "question" ? "Has a question" : "Working";
              return <span className={`pill state-${st === "alert" || st === "question" ? st : "working"}`}>{live}</span>;
            })()}
            <button className="history-title link-button" onClick={() => open(env.summary.id, t.id)}>{t.title || "Untitled"}</button>
            <span className="muted small">{env.summary.label} · {formatDuration(ms)}</span>
          </li>
        ))}
      </ol>
    </>}
    {longest.length > 0 && <>
      <p className="muted small">Longest finished turns in this range, by agent time (waits on you excluded):</p>
      <ol className="history-list history-recent">
        {longest.map((r) => (
          <li key={`${r.envId}${r.threadId}${r.turnId}`}>
            <span className={`pill state-${r.outcome === "completed" ? "done" : r.outcome === "error" ? "error" : "idle"}`}>{OUTCOME_LABEL[r.outcome]}</span>
            <span className="history-title" title={r.threadTitle}>{r.threadTitle}</span>
            <span className="muted small">{r.envLabel} · started {startTime(r.startedAt)} · {formatDuration(agentMs(r))}{r.waitMs ? ` + ${formatDuration(r.waitMs)} waiting` : ""}</span>
          </li>
        ))}
      </ol>
    </>}
  </>;
}

const LONG_MS = 3_600_000;

/** When a turn started, so several turns of the same thread read apart: "Mon 14:02". */
function startTime(iso: string): string {
  return new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "done" | "error" }) {
  return <div className="history-stat"><span className="tele-key">{label}</span><strong className={tone ? `st-${tone}` : undefined}>{value}</strong></div>;
}

function Ranking({ title, rows }: { title: string; rows: HistorySummary["projects"] }) {
  return (
    <div>
      <h3>{title}</h3>
      {rows.length === 0 ? <p className="muted small">—</p> : (
        <table className="history-table"><thead><tr><th>{title === "Models" ? "Model" : "Project"}</th><th>Turns</th><th>Time</th></tr></thead><tbody>
          {rows.map((r) => <tr key={r.name}><td title={r.name}>{r.name}</td><td>{r.turns}</td><td className="muted">{formatDuration(r.durationMs)}</td></tr>)}
        </tbody></table>
      )}
    </div>
  );
}

/** Daily API-equivalent spend for the range, asked of each machine's T3 when the panel opens. */
function SpendHistory({ days, timeZone }: { days: number; timeZone: string }) {
  const envs = useGame((s) => s.envs);
  const window = useMemo(() => historyWindow(new Date(), timeZone, days), [days, timeZone]);
  const targets = useMemo(() => Object.values(envs).filter((e) => e.connection === "live" && e.summary.kind !== "hermes")
    .map((e) => ({ id: e.summary.id, label: e.summary.label, connection: e.connection })), [envs]);
  const ids = targets.map((t) => t.id).join(",");
  const [summaries, setSummaries] = useState<Record<string, UsageSummary | Error>>();
  useEffect(() => {
    let live = true;
    setSummaries(undefined);
    void Promise.all(ids.split(",").filter(Boolean).map(async (id) => {
      try { return [id, await envClient(id)!.usageFor(window)] as const; }
      catch (err) { return [id, err instanceof Error ? err : new Error(String(err))] as const; }
    })).then((rows) => { if (live) setSummaries(Object.fromEntries(rows)); });
    return () => { live = false; };
  }, [ids, window]);
  const spend = summaries && fleetSpend(targets.map((t) => ({ ...t, usage: summaries[t.id] instanceof Error ? { error: (summaries[t.id] as Error).message } : { summary: summaries[t.id] as UsageSummary } })), window);
  return (
    <>
      <h3>Spend, last {days} days</h3>
      {!spend && <p className="muted small">Asking each machine for its usage…</p>}
      {spend && spend.costUsd !== undefined && <>
        <BarChart label={`Daily API-equivalent usage, last ${days} days`} points={spend.daily.map((p) => ({ label: p.day.slice(5), value: p.costUsd, detail: `${p.day}: ${formatSpend(p.costUsd)}` }))} />
        <p className="muted small">{formatSpend(spend.costUsd)} API-equivalent over the range{spend.partial ? " · some machines missing or partial" : ""}. Subscription charges are billed separately.</p>
      </>}
      {spend && spend.costUsd === undefined && <p className="muted small">No machine reported usage for this range.</p>}
    </>
  );
}
