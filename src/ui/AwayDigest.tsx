import { useEffect, useState } from "react";
import { openEvent, setSelection, useGame, type LogEntry } from "../store";
import { worldRef } from "../game/world";
import { waitQueue } from "./queue";
import { elapsed } from "../t3/timing";
import { AWAY_MS, digest, type Digest } from "./away";

const SEEN_KEY = "t3c:last-seen";

function lastSeen(): number {
  try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; }
}
function markSeen(): void {
  try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch { /* Per-browser convenience only. */ }
}

/** After 30+ minutes away, what the fleet did meanwhile, from the shared comms log. */
export function AwayDigest() {
  const [shown, setShown] = useState<Digest>();
  const envs = useGame((s) => s.envs);
  const details = useGame((s) => s.details);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const since = lastSeen();
      // Give the comms stream a moment to deliver what happened while the tab was gone.
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (since && Date.now() - since > AWAY_MS) setShown(digest(useGame.getState().log, since));
        markSeen();
      }, 3000);
    };
    const onVisibility = () => { if (document.hidden) markSeen(); else check(); };
    check();
    const tick = setInterval(() => { if (!document.hidden) markSeen(); }, 60_000);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", markSeen);
    return () => { clearTimeout(timer); clearInterval(tick); document.removeEventListener("visibilitychange", onVisibility); window.removeEventListener("pagehide", markSeen); };
  }, []);

  if (!shown) return null;
  const parts = [shown.done && `${shown.done} finished`, shown.merged && `${shown.merged} PR${shown.merged === 1 ? "" : "s"} merged`, shown.failed && `${shown.failed} failed`].filter(Boolean);
  // Still waiting is the live queue (not the log): who is blocked on you right now, longest first.
  const waiting = waitQueue(envs, details);
  const goTo = (envId?: string, threadId?: string, ask = false) => {
    if (!envId || !threadId || !envs[envId]?.threads[threadId]) return;
    const sel = { kind: "unit" as const, envId, threadId };
    setSelection(sel);
    worldRef.current?.focus(sel);
    if (ask) openEvent({ envId, threadId });
  };
  const line = (e: LogEntry) => (
    <li key={e.id}><button className={`away-link tone-${e.tone}`} disabled={!e.threadId} onClick={() => goTo(e.envId, e.threadId)}>{e.text}</button></li>
  );
  return (
    <section className="away-digest hud-frame" role="status" aria-label="While you were away">
      <header className="panel-head">
        <h2>While you were away <span className="muted small">· {elapsed(Date.now() - shown.since)}</span></h2>
        <span className="spacer" />
        <button className="icon-btn" aria-label="Dismiss" onClick={() => setShown(undefined)}>✕</button>
      </header>
      {parts.length > 0 && <p className="away-counts">{parts.join(" · ")}</p>}
      {waiting.length > 0 && (
        <>
          <h3 className="away-heading">Still waiting on you</h3>
          <ul className="away-list">
            {waiting.slice(0, 5).map((w) => (
              <li key={`${w.envId}:${w.threadId}`}>
                <button className="away-link tone-alert" onClick={() => goTo(w.envId, w.threadId, true)}>{envs[w.envId]?.threads[w.threadId]?.title || "Untitled"}</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {shown.landed.length > 0 && <><h3 className="away-heading">Landed</h3><ul className="away-list">{shown.landed.map(line)}</ul></>}
      {shown.notable.length > 0 && <><h3 className="away-heading">Worth a look</h3><ul className="away-list">{shown.notable.map(line)}</ul></>}
      <div className="away-actions">
        <button className="btn" onClick={() => { useGame.setState({ showLog: true }); setShown(undefined); }}>Open comms log</button>
      </div>
    </section>
  );
}
