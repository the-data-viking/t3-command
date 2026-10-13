import { setSquad, useGame } from "../store";
import { isSettled } from "../t3/derive";
import { batchSettle, liveMembers } from "./squad";

/** Batch actions for the crew picked with shift-click, shift-drag or a control group. */
export function SquadBar() {
  const squad = useGame((s) => s.squad);
  const envs = useGame((s) => s.envs);
  const members = liveMembers(squad, envs);
  if (!members.length) return null;
  const settled = members.filter((m) => isSettled(envs[m.envId].threads[m.threadId])).length;
  return (
    <div className="squad-bar hud-frame" role="toolbar" aria-label="Squad actions">
      <span className="squad-count"><strong>{members.length}</strong> crew picked</span>
      <button className="btn" disabled={settled === members.length} onClick={() => void batchSettle(true, members)}>Send to camp</button>
      <button className="btn" disabled={settled === 0} onClick={() => void batchSettle(false, members)}>Wake</button>
      <span className="muted small squad-hint">Ctrl or Alt + 1–9 saves a group</span>
      <button className="icon-btn" aria-label="Clear squad" title="Clear (Esc)" onClick={() => setSquad([])}>✕</button>
    </div>
  );
}
