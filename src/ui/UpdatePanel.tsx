import { useEffect, useRef, useState } from "react";
import type { UpdateStatus } from "../../shared/api";
import { createPortal } from "react-dom";
import { fetchJson } from "../t3/environment";

/** Someone is typing: a text field has focus. */
function typing(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLElement && !!el.closest("input, textarea, select, [contenteditable]");
}

const BUSY = ["checking", "fetching", "installing", "building", "restarting"];
const short = (commit: string | null) => commit ? commit.slice(0, 8) : "unknown";

export function UpdatePanel() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<UpdateStatus>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const reconnecting = useRef(false);
  const version = useRef<string | undefined>(undefined);
  const busy = submitting || !!status && BUSY.includes(status.phase);
  // A new release is live. Reload for it, but never out from under someone typing: wait until
  // they leave the field or the tab goes to the background (drafts are saved either way).
  const [pending, setPending] = useState(false);
  const reloadSoon = () => { if (typing() && !document.hidden) setPending(true); else window.location.reload(); };
  useEffect(() => {
    if (!pending) return;
    const check = () => { if (!typing() || document.hidden) window.location.reload(); };
    // Focus moves after focusout fires; look once it has landed.
    const left = () => setTimeout(check, 300);
    document.addEventListener("focusout", left);
    document.addEventListener("visibilitychange", check);
    return () => { document.removeEventListener("focusout", left); document.removeEventListener("visibilitychange", check); };
  }, [pending]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await fetchJson<UpdateStatus>("/api/update");
        if (disposed) return;
        setStatus(result);
        setError(undefined);
        const currentVersion = `${result.currentCommit}:${result.localChanges}`;
        if (version.current !== undefined && version.current !== currentVersion) {
          reloadSoon();
          return;
        }
        version.current = currentVersion;
        if (result.phase === "restarting") reconnecting.current = true;
        if (reconnecting.current && result.phase === "succeeded") {
          // Fetch a fresh HTML entry point after the backend confirms startup.
          reloadSoon();
          return;
        }
        if (result.phase === "failed") reconnecting.current = false;
      } catch (err) {
        if (!disposed) setError(reconnecting.current ? "Reconnecting to the new release…" : (err as Error).message);
      }
      if (!disposed) timer = setTimeout(poll, open || reconnecting.current ? 1500 : 15_000);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [open]);

  const run = async (action: "check" | "deploy") => {
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await fetchJson<UpdateStatus>(action === "check" ? "/api/update/check" : "/api/update", {
        method: "POST", body: JSON.stringify({}),
      });
      setStatus(result);
      if (action === "deploy") reconnecting.current = true;
    } catch (err) { setError((err as Error).message); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="update-menu">
      {pending && createPortal(
        <div className="update-ready hud-frame" role="status">
          <span>New release ready. It loads when you finish typing; your draft is saved.</span>
          <button className="btn small primary" onMouseDown={(e) => e.preventDefault()} onClick={() => window.location.reload()}>Reload now</button>
        </div>, document.body)}
      <button className="btn" aria-expanded={open} aria-controls="update-panel" onClick={() => setOpen(!open)}>Update</button>
      {open && (
        <section id="update-panel" className="update-panel hud-frame" aria-label="Update T3 Command">
          <header className="panel-head">
            <h2>Update T3 Command</h2><span className="spacer" />
            <button className="icon-btn" aria-label="Close update panel" onClick={() => setOpen(false)}>✕</button>
          </header>
          <p>Deploy the latest <strong>main</strong>. The current app stays available while the new release builds. Crew reconnect after a brief server restart.</p>
          {status ? <>
            <div className="small muted">Running {short(status.currentCommit)}{status.localChanges ? " · local changes" : ""}</div>
            {status.latestCommit && <div className="small muted">main {short(status.latestCommit)}</div>}
            {status.localChanges && <p className="small">Your local checkout is preserved. The new release contains the committed code on main.</p>}
            {!status.enabled && <p className="small muted">{status.reason}</p>}
            <p role="status" className={status.phase === "failed" ? "error" : "small"}>{status.message}</p>
            <div className="pending-actions">
              <button className="btn" disabled={!status.enabled || busy} onClick={() => void run("check")}>Check main</button>
              <button className="btn primary" disabled={!status.enabled || busy} onClick={() => void run("deploy")}>
                {busy ? "Updating…" : "Redeploy main"}
              </button>
            </div>
            {status.log && <details className="update-log"><summary>Build log</summary><pre>{status.log}</pre></details>}
          </> : <p className="muted small">Loading update status…</p>}
          {error && <p role="alert" className="error small">{error}</p>}
        </section>
      )}
    </div>
  );
}
