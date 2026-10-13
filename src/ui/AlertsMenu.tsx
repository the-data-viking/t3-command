import { useEffect, useRef, useState } from "react";
import { PUSH_KINDS, PUSH_LABELS, type PushKind, type PushRules } from "../../shared/push";
import { setNotify, useGame } from "../store";
import { currentEndpoint, deviceLabel, disablePush, enablePush, needsHomeScreen, pushStatus, pushSupported, saveRules, testPush, type PushStatus } from "../t3/push";
import { PixelIcon } from "./PixelArt";

/**
 * Alerts: desktop notifications while this tab is open, and push to this device from the Command
 * server (which reaches a phone in a pocket), with which events and quiet hours.
 */
export function AlertsMenu() {
  const notify = useGame((s) => s.notify);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<PushStatus>();
  const [endpoint, setEndpoint] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
  const pushOn = !!endpoint && !!status?.devices.some((d) => d.endpoint === endpoint);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    if (pushSupported()) {
      void pushStatus().then(setStatus).catch(() => setMessage("Couldn't reach the Command server."));
      void currentEndpoint().then(setEndpoint);
    }
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(undefined);
    try { await fn(); } catch (err) { setMessage((err as Error).message); } finally { setBusy(false); }
  };
  const update = (change: (rules: PushRules) => PushRules) => {
    if (!status) return;
    const rules = change(structuredClone(status.rules));
    setStatus({ ...status, rules });
    void run(async () => { setStatus(await saveRules(rules)); });
  };
  const toggleKind = (k: PushKind) => update((r) => ({ ...r, kinds: { ...r.kinds, [k]: !r.kinds[k] } }));
  const toggleAllow = (k: PushKind) => update((r) => ({ ...r, quiet: { ...r.quiet, allow: r.quiet.allow.includes(k) ? r.quiet.allow.filter((x) => x !== k) : [...r.quiet.allow, k] } }));
  const anyOn = notify || pushOn;

  return (
    <div className="theme-menu alerts-menu" ref={root}>
      <button className="icon-btn" aria-haspopup="dialog" aria-expanded={open} title={anyOn ? "Alerts on" : "Alerts off"}
        aria-label={`${anyOn ? "Alerts on" : "Alerts off"}. Open alert settings`} onClick={() => setOpen(!open)}>
        <PixelIcon name={anyOn ? "bell" : "bellOff"} /><span className="phone-label">{anyOn ? "Alerts on" : "Alerts off"}</span>
      </button>
      {open && (
        <div className="theme-list alerts-panel hud-frame" role="dialog" aria-label="Alerts">
          <label className="sound-row">
            <input type="checkbox" checked={notify} onChange={(e) => void setNotify(e.target.checked)} /> Desktop alerts while this tab is open
          </label>
          <h3 className="alerts-heading">Push to this device</h3>
          {!pushSupported() ? (
            <p className="muted small">This browser can't receive push notifications here.</p>
          ) : needsHomeScreen() && !pushOn ? (
            <p className="muted small">On iPhone and iPad: tap Share, then <strong>Add to Home Screen</strong>, and open T3 Command from the Home Screen to turn on push.</p>
          ) : (
            <div className="alerts-row">
              <span className={pushOn ? "st-done" : "muted"}>{pushOn ? "On for this device" : "Off for this device"}</span>
              <span className="spacer" />
              {pushOn
                ? <><button className="btn small" disabled={busy} onClick={() => void run(async () => { const sent = await testPush(endpoint); setMessage(sent ? "Test sent." : "Nothing was delivered."); })}>Send test</button>
                  <button className="btn small" disabled={busy} onClick={() => void run(async () => { setStatus(await disablePush()); setEndpoint(undefined); })}>Turn off</button></>
                : <button className="btn small" disabled={busy || !status} onClick={() => void run(async () => { setStatus(await enablePush(deviceLabel())); setEndpoint(await currentEndpoint()); })}>Turn on</button>}
            </div>
          )}
          {status && (
            <>
              <p className="muted small">{status.devices.length} device{status.devices.length === 1 ? "" : "s"} receive push{status.devices.length ? `: ${status.devices.map((d) => d.label).join(", ")}` : ""}. These settings apply to all of them.</p>
              <h3 className="alerts-heading">Push these events</h3>
              <div className="alerts-kinds">
                {PUSH_KINDS.map((k) => (
                  <label key={k} className="sound-row"><input type="checkbox" checked={status.rules.kinds[k]} onChange={() => toggleKind(k)} /> {PUSH_LABELS[k]}</label>
                ))}
              </div>
              <h3 className="alerts-heading">Quiet hours</h3>
              <div className="alerts-row">
                <label className="sound-row"><input type="checkbox" checked={status.rules.quiet.enabled}
                  onChange={(e) => update((r) => ({ ...r, quiet: { ...r.quiet, enabled: e.target.checked, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } }))} /> From</label>
                <input type="time" value={status.rules.quiet.start} onChange={(e) => update((r) => ({ ...r, quiet: { ...r.quiet, start: e.target.value } }))} aria-label="Quiet hours start" />
                <span>to</span>
                <input type="time" value={status.rules.quiet.end} onChange={(e) => update((r) => ({ ...r, quiet: { ...r.quiet, end: e.target.value } }))} aria-label="Quiet hours end" />
              </div>
              <p className="muted small">During quiet hours only these come through:</p>
              <div className="alerts-kinds">
                {(["approval", "question", "failed", "offline"] as PushKind[]).map((k) => (
                  <label key={k} className="sound-row"><input type="checkbox" checked={status.rules.quiet.allow.includes(k)} onChange={() => toggleAllow(k)} /> {PUSH_LABELS[k]}</label>
                ))}
              </div>
            </>
          )}
          {message && <p className="small orange">{message}</p>}
        </div>
      )}
    </div>
  );
}
