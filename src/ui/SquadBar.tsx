import { useState } from "react";
import { expandPlaybook } from "../../shared/playbooks";
import { sfx } from "../game/sfx";
import { setSquad, useGame } from "../store";
import { isSettled, unitState } from "../t3/derive";
import { envClient } from "../t3/environment";
import { queueFollowUp } from "../t3/followups";
import { batchSettle, liveMembers } from "./squad";

/**
 * Batch actions for the crew picked with shift-click, shift-drag or a control group: camp, wake,
 * and one order to all of them. The order names how many it goes to before it's sent; busy crew
 * get it as a follow-up when their turn ends (or straight away, starting a new turn, if you say so).
 */
export function SquadBar() {
  const squad = useGame((s) => s.squad);
  const envs = useGame((s) => s.envs);
  const playbooks = useGame((s) => s.playbooks);
  const [ordering, setOrdering] = useState(false);
  const [text, setText] = useState("");
  const [queueBusy, setQueueBusy] = useState(true);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string>();
  const members = liveMembers(squad, envs);
  if (!members.length) return null;
  const settled = members.filter((m) => isSettled(envs[m.envId].threads[m.threadId])).length;
  // Orders go only to crew on a connected T3 station; the count on the button is who gets it.
  const orderable = members.filter((m) => envs[m.envId].connection === "live" && envs[m.envId].summary.kind !== "hermes");
  const busy = orderable.filter((m) => { const s = unitState(envs[m.envId].threads[m.threadId]); return s === "working" || s === "alert" || s === "question"; });

  const send = async () => {
    const order = expandPlaybook(text.trim(), playbooks);
    if (!order || sending) return;
    setSending(true);
    let sent = 0, queued = 0, failed = 0;
    await Promise.all(orderable.map(async (m) => {
      try {
        if (queueBusy && busy.includes(m)) { await queueFollowUp(m.envId, m.threadId, order); queued++; }
        else {
          const client = envClient(m.envId);
          if (!client) throw new Error("not connected");
          await client.order(m.threadId, order);
          sent++;
        }
      } catch { failed++; }
    }));
    (failed ? sfx.error : sfx.order)();
    setResult([sent && `Sent to ${sent}`, queued && `queued for ${queued}`, failed && `${failed} failed`].filter(Boolean).join(" · "));
    setSending(false);
    if (!failed) { setText(""); setOrdering(false); }
  };

  return (
    <div className="squad-bar hud-frame" role="toolbar" aria-label="Squad actions">
      <span className="squad-count"><strong>{members.length}</strong> crew picked</span>
      {ordering ? (
        <>
          <input className="squad-order" autoFocus value={text} placeholder="Order for all of them… (or /saved)" disabled={sending}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void send(); } if (e.key === "Escape") { e.stopPropagation(); setOrdering(false); } }} />
          {busy.length > 0 && (
            <label className="squad-queue small"><input type="checkbox" checked={queueBusy} onChange={(e) => setQueueBusy(e.target.checked)} /> {busy.length} busy: after their turn</label>
          )}
          <button className="btn primary" disabled={!text.trim() || sending || !orderable.length} onClick={() => void send()}>{sending ? "…" : `Send to ${orderable.length}`}</button>
        </>
      ) : (
        <>
          <button className="btn" disabled={!orderable.length} title={orderable.length < members.length ? `${members.length - orderable.length} on a disconnected station` : undefined} onClick={() => { setOrdering(true); setResult(undefined); }}>Order {orderable.length}…</button>
          <button className="btn" disabled={settled === members.length} onClick={() => void batchSettle(true, members)}>Send to camp</button>
          <button className="btn" disabled={settled === 0} onClick={() => void batchSettle(false, members)}>Wake</button>
          <span className="muted small squad-hint">{result ?? "Ctrl or Alt + 1–9 saves a group"}</span>
        </>
      )}
      <button className="icon-btn" aria-label="Clear squad" title="Clear (Esc)" onClick={() => setSquad([])}>✕</button>
    </div>
  );
}
