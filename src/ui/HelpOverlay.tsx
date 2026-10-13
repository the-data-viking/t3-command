import { useEffect } from "react";
import { useGame } from "../store";

const KEYS: Array<[string, string]> = [
  ["Ctrl/⌘ K", "Command palette: find crew, stations, machines, actions"],
  ["Space", "Next crew waiting on you (approval or question)"],
  [".", "Next report ready"],
  ["W / M", "Next working / monitoring crew"],
  ["F", "Fit the whole fleet"],
  ["L / H", "Comms log / turn history"],
  ["1–9", "Recall a control group (press again to frame it)"],
  ["Ctrl or Alt 1–9", "Save the squad (or selected crew) as a control group"],
  ["Shift-click", "Add or remove crew from the squad (map or roster)"],
  ["Shift-drag", "Box-select crew on the map into the squad"],
  ["Drag · scroll · pinch", "Pan · zoom · zoom (touch)"],
  ["Esc", "Close dialogs, clear the squad, then deselect"],
  ["?", "This help"],
];

const LEGEND: Array<[string, string, string]> = [
  ["working", "Spinning pip", "Turn running; pips over the head show plan steps done / current / left"],
  ["question", "Three amber dots", "Running turn with no activity for 10+ minutes (quiet)"],
  ["alert", "Pulsing ring + !", "Waiting for your approval"],
  ["question", "Pulsing ring + ?", "Waiting for your answer"],
  ["done", "✓ badge", "Report ready (finished, not yet sent to camp)"],
  ["error", "Sparks, then scorch and smoke", "Last turn failed"],
  ["monitoring", "Drones orbiting", "Background tasks running"],
  ["done", "Green ring", "Selected crew"],
  ["working", "Wide cyan ring", "In the squad"],
  ["muted", "Rack LEDs · coolant", "Whole-host CPU · RAM on each engineering deck"],
  ["gauge-high", "DISK % · hazard stripes", "Fullest checkout disk; stripes when nearly full"],
  ["gauge-critical", "Snow · NO SIGNAL · dashed lines", "Machine unreachable (offline or needs pairing)"],
];

/** `?`: hotkeys, gestures and what the map's lights and effects mean. */
export function HelpOverlay() {
  const close = () => useGame.setState({ showHelp: false });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" || e.key === "?") { e.preventDefault(); e.stopPropagation(); close(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal help-modal" role="dialog" aria-label="Help" onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2>Command reference</h2><span className="spacer" />
          <button className="icon-btn" aria-label="Close help" onClick={close}>✕</button>
        </header>
        <div className="help-columns">
          <section>
            <h3>Keys and gestures</h3>
            <dl className="help-keys">
              {KEYS.map(([key, what]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{what}</dd></div>)}
            </dl>
          </section>
          <section>
            <h3>On the map</h3>
            <dl className="help-legend">
              {LEGEND.map(([color, mark, what]) => (
                <div key={mark}><dt><i className="help-chip" style={{ background: `var(--${color})` }} />{mark}</dt><dd>{what}</dd></div>
              ))}
            </dl>
            <p className="muted small">The map only shows what T3 reports: consoles light for real turns, crew walk for real tool calls.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
