import { useEffect } from "react";
import { useGame } from "../store";
import type { Grid } from "../art/sprites";
import { STYLES } from "../art/palettes";
import { rasterize } from "../art/render";
import { BADGES } from "../game/map-common";
import { STATUS } from "../game/theme";
import type { UnitState } from "../t3/derive";

const KEYS: Array<[string, string]> = [
  ["Ctrl/⌘ K", "Command palette: find anything, or act: order a crew member, read a report, open a PR"],
  ["Space", "Next crew waiting on you, longest wait first (approval or question)"],
  [".", "Next report, as a debrief card: what was done, what changed, accept or follow up"],
  ["W / M", "Next working / monitoring crew"],
  ["F", "Fit the whole fleet"],
  ["L / H", "Comms log / turn history"],
  ["1–9", "Recall a control group (press again to frame it)"],
  ["Ctrl or Alt 1–9", "Save the squad (or selected crew) as a control group"],
  ["Shift-click", "Add or remove crew from the squad (map or roster)"],
  ["Shift-drag", "Box-select crew on the map into the squad"],
  ["Drag · scroll · pinch", "Pan · zoom · zoom (touch)"],
  ["Alt+Enter", "In a busy crew member's order box: queue it to send when their turn ends"],
  ["/", "At the start of an order: pick a saved order (Tab or Enter)"],
  ["Esc", "Close dialogs, clear the squad, then deselect"],
  ["P", "Photo mode: hide the HUD, save the map as a PNG"],
  ["?", "This help"],
];

const LEGEND: Array<[string, string, string]> = [
  ["working", "Spinning pip", "Turn running; pips over the head show plan steps done / current / left"],
  ["muted", "Three grey dots", "Running turn with no activity for 10+ minutes (quiet)"],
  ["alert", "▲ badge · console pulses", "Waiting for your approval"],
  ["question", "◆ badge · console pulses", "Waiting for your answer"],
  ["done", "Round ✓ badge", "Report ready (finished, not yet sent to camp)"],
  ["error", "✕ badge · sparks, then scorch", "Last turn failed"],
  ["monitoring", "○ badge · drones orbiting", "Background tasks running"],
  ["selection", "White ring", "Selected crew (or station outline)"],
  ["muted", "Wide dim ring", "In the squad"],
  ["muted", "Rack LEDs · coolant", "Whole-host CPU · RAM on each engineering deck"],
  ["gauge-high", "Pips beside the head", "Turn running past 2, 6, 12, 24 hours (magenta past 12)"],
  ["gauge-high", "DISK % · hazard stripes", "Fullest checkout disk; stripes when nearly full"],
  ["muted", "Snow · NO SIGNAL · dashed lines", "Machine unreachable (offline or needs pairing)"],
  ["muted", "Grey crew · static", "Last known state from an unreachable machine"],
];

/** Legend marks that are a status badge on the map, shown as that badge. */
const SPRITES: Record<string, UnitState> = {
  "▲ badge · console pulses": "alert",
  "◆ badge · console pulses": "question",
  "Round ✓ badge": "done",
  "✕ badge · sparks, then scorch": "error",
  "○ badge · drones orbiting": "monitoring",
};

function LegendMark({ color, mark }: { color: string; mark: string }) {
  const artStyle = useGame((s) => s.artStyle);
  const state = SPRITES[mark];
  const grid: Grid | undefined = state && BADGES[state];
  if (!state || !grid) return <i className="help-chip" style={{ background: `var(--${color})` }} />;
  const url = rasterize(grid, STYLES[artStyle], { visor: STATUS[state] }).toDataURL();
  return <img className="help-sprite" src={url} alt="" width={grid[0].length * 2} height={grid.length * 2} draggable={false} />;
}

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
                <div key={mark}><dt><LegendMark color={color} mark={mark} />{mark}</dt><dd>{what}</dd></div>
              ))}
            </dl>
            <p className="muted small">Zoomed far out, the map becomes the fleet view: each station a block of its rooms (lit while occupied), each awake crew member and Hermes operator one status glyph in the room they're in, most urgent first.</p>
            <p className="muted small">The map only shows what T3 reports: consoles light for real turns, crew walk for real tool calls.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
