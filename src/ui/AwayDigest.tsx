import { useEffect, useState } from "react";
import { useGame } from "../store";
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
  const parts = [shown.done && `${shown.done} job${shown.done === 1 ? "" : "s"} done`, shown.failed && `${shown.failed} failed`, shown.waiting && `${shown.waiting} waiting on you`].filter(Boolean);
  return (
    <section className="away-digest hud-frame" role="status" aria-label="While you were away">
      <header className="panel-head">
        <h2>While you were away <span className="muted small">· {elapsed(Date.now() - shown.since)}</span></h2>
        <span className="spacer" />
        <button className="icon-btn" aria-label="Dismiss" onClick={() => setShown(undefined)}>✕</button>
      </header>
      {parts.length > 0 && <p className="away-counts">{parts.join(" · ")}</p>}
      {shown.notable.length > 0 && (
        <ul className="history-list">
          {shown.notable.map((e) => <li key={e.id} className={`tone-${e.tone}`}>{e.text}</li>)}
        </ul>
      )}
      <div className="away-actions">
        <button className="btn" onClick={() => { useGame.setState({ showLog: true }); setShown(undefined); }}>Open comms log</button>
      </div>
    </section>
  );
}
