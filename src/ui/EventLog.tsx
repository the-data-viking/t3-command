import { useEffect, useState } from "react";
import { PixelLabel } from "./PixelArt";
import { sfx } from "../game/sfx";
import { worldRef } from "../game/world";
import { clearLog, setSelection, useGame } from "../store";
import { ROUTINE_KINDS } from "../../shared/comms";
import { entryKind } from "./away";

const VISIBLE_MS = 12_000;

export function EventLog() {
  const log = useGame((s) => s.log);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      const time = Date.now();
      setNow(time);
      if (!document.hidden && log.some((entry) => time - entry.at < VISIBLE_MS)) timer = setTimeout(refresh, 1000);
    };
    document.addEventListener("visibilitychange", refresh);
    refresh();
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [log]);

  // The ticker skips routine lines (work starting, background watching): they'd bury the rest.
  const recent = log.filter((e) => now - e.at < VISIBLE_MS && !ROUTINE_KINDS.has(entryKind(e))).slice(-6);
  return (
    <div className="event-log">
      {recent.map((e) => (
        <button
          key={e.id}
          className={`log-line tone-${e.tone}`}
          style={{ opacity: Math.min(1, (VISIBLE_MS - (now - e.at)) / 3000) }}
          disabled={!e.envId || !e.threadId}
          onClick={() => {
            if (!e.envId || !e.threadId) return;
            const sel = { kind: "unit" as const, envId: e.envId, threadId: e.threadId };
            sfx.select();
            setSelection(sel);
            worldRef.current?.focus(sel);
          }}
        >
          {e.text}
        </button>
      ))}
    </div>
  );
}

/** Scrollback of everything the comms feed announced, newest first. */
export function CommsLog() {
  const all = useGame((s) => s.log);
  const envs = useGame((s) => s.envs);
  const dispatches = useGame((s) => s.dispatches);
  // Routine lines (work starting, background watching) are folded away unless asked for.
  const [routine, setRoutine] = useState(false);
  const hidden = all.filter((e) => ROUTINE_KINDS.has(entryKind(e))).length;
  const log = routine ? all : all.filter((e) => !ROUTINE_KINDS.has(entryKind(e)));
  return (
    <section className="comms-log hud-frame" aria-label="Comms log">
      <div className="hud-label"><PixelLabel text="Comms log" /></div>
      <header className="comms-log-head">
        <span className="muted small">{log.length} event{log.length === 1 ? "" : "s"} · shared by every device, kept 30 days</span>
        <span className="spacer" />
        {hidden > 0 && <button className="btn small" aria-pressed={routine} onClick={() => setRoutine(!routine)}>{routine ? "Hide routine" : `Show routine (${hidden})`}</button>}
        <button className="btn small" disabled={!all.length} onClick={clearLog}>Clear</button>
        <button className="icon-btn" aria-label="Close comms log" onClick={() => useGame.setState({ showLog: false })}>✕</button>
      </header>
      <ol className="comms-log-list">
        {log.length === 0 && <li className="muted small">Nothing yet.</li>}
        {[...log].reverse().map((e) => (
          <li key={e.id}>
            <button className={`comms-log-row tone-${e.tone}`} disabled={e.dispatchId ? !dispatches.some((d) => d.id === e.dispatchId) : !e.envId || !e.threadId || !envs[e.envId]?.threads[e.threadId]}
              onClick={() => {
                // A finished squad order or mission: its replies.
                if (e.dispatchId) { sfx.select(); useGame.setState({ replies: e.dispatchId }); return; }
                if (!e.envId || !e.threadId) return;
                const sel = { kind: "unit" as const, envId: e.envId, threadId: e.threadId };
                sfx.select();
                setSelection(sel);
                worldRef.current?.focus(sel);
              }}>
              <time dateTime={new Date(e.at).toISOString()}>{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
              <span>{e.text}</span>
              {e.envId && envs[e.envId] && <span className="muted small">{envs[e.envId].summary.label}</span>}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
