// Start a mission with the picked crew: a name, one goal, and each crew member's own part. Each
// gets a brief naming the mission, the goal, who else is on it and their part; it's tracked like
// any squad order (receipts, then the replies side by side) under the mission's name.

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { sfx } from "../game/sfx";
import { unitKey, useGame, type SquadMember } from "../store";
import { logError } from "../t3/environment";
import { recordDispatch, updateDispatch } from "./dispatch";
import { useDraft } from "./drafts";
import { missionBrief, type MissionMember, type MissionPlan } from "./mission";
import { PixelLabel, PixelIcon } from "./PixelArt";
import { confirmReplacing, orderCrew, wouldReplace } from "./squad";

export function MissionDialog({ crew, busy, onClose }: { crew: SquadMember[]; busy: SquadMember[]; onClose: () => void }) {
  const envs = useGame((s) => s.envs);
  const [name, setName, clearName] = useDraft("mission-name");
  const [goal, setGoal, clearGoal] = useDraft("mission-goal");
  const [partsRaw, setPartsRaw, clearParts] = useDraft("mission-parts");
  const parts = useMemo<Record<string, string>>(() => { try { return JSON.parse(partsRaw || "{}") as Record<string, string>; } catch { return {}; } }, [partsRaw]);
  const setPart = (key: string, value: string) => setPartsRaw(JSON.stringify({ ...parts, [key]: value }));
  const [queueBusy, setQueueBusy] = useState(true);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string>();
  const [retry, setRetry] = useState<{ keys: string[]; dispatchId?: string }>();
  const title = (m: SquadMember) => envs[m.envId]?.threads[m.threadId]?.title || "Untitled";
  const plan: MissionPlan = { name, goal, parts };
  const titles = crew.map(title);
  // Each teammate as the others will see them: title, part, and where they work.
  const roster: MissionMember[] = crew.map((m) => {
    const key = unitKey(m.envId, m.threadId), t = envs[m.envId]?.threads[m.threadId];
    const where = [envs[m.envId]?.summary.label, t?.branch ? `branch ${t.branch}` : undefined].filter(Boolean).join(", ");
    return { key, title: title(m), part: parts[key], ...(where ? { where } : {}) };
  });
  const ready = !!name.trim() && !!goal.trim() && crew.length > 0;
  // Crew sharing one checkout on one machine will edit the same files: say so before launch.
  const shared = useMemo(() => {
    const byCheckout = new Map<string, string[]>();
    for (const m of crew) {
      const t = envs[m.envId]?.threads[m.threadId];
      const path = t?.worktreePath ?? (t ? envs[m.envId]?.projects[t.projectId]?.workspaceRoot : undefined);
      if (!path) continue;
      const key = `${envs[m.envId]?.summary.label ?? m.envId}\u0000${path}`;
      byCheckout.set(key, [...(byCheckout.get(key) ?? []), title(m)]);
    }
    return [...byCheckout].filter(([, who]) => who.length > 1).map(([key, who]) => { const [machine, path] = key.split("\u0000"); return { machine, path, who }; });
  }, [crew, envs]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    if (!ready || sending) return;
    setSending(true);
    const targets = retry ? crew.filter((m) => retry.keys.includes(unitKey(m.envId, m.threadId))) : crew;
    const partOf = (m: SquadMember) => parts[unitKey(m.envId, m.threadId)];
    const queueFor = (m: SquadMember) => queueBusy && busy.includes(m);
    if (!confirmReplacing(wouldReplace(targets, queueFor))) { setSending(false); return; }
    const { receipts, sent, queued, failed, failedKeys } = await orderCrew(targets,
      (m) => missionBrief(plan, roster, unitKey(m.envId, m.threadId), partOf(m)), queueFor, partOf);
    let dispatchId = retry?.dispatchId;
    try {
      if (dispatchId) await updateDispatch(dispatchId, receipts);
      else dispatchId = (await recordDispatch(goal.trim(), receipts, { name: name.trim(), goal: goal.trim() })).id;
    } catch (err) { logError("Couldn't record the mission", err); }
    (failed ? sfx.error : sfx.order)();
    setSending(false);
    if (failed) {
      setRetry({ keys: failedKeys, dispatchId });
      setResult([sent && `Briefed ${sent}`, queued && `queued for ${queued}`, `${failed} failed`].filter(Boolean).join(" · "));
      return;
    }
    clearName(); clearGoal(); clearParts();
    useGame.setState({ showBoard: true });
    onClose();
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal mission-modal" role="dialog" aria-label="New mission" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
        <header className="panel-head">
          <h2 className="title-tab"><PixelLabel text="Mission" /></h2>
          <span className="muted small">{crew.length} crew, one goal, each with their own part</span>
          <span className="spacer" />
          <button className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
        </header>
        <label className="mission-field"><span>Name</span>
          <input autoFocus value={name} maxLength={60} placeholder="Ship the 2D renderer" onChange={(e) => { setName(e.target.value); setRetry(undefined); }} /></label>
        <label className="mission-field"><span>Goal</span>
          <textarea rows={3} value={goal} placeholder="What done looks like, for all of them together." onChange={(e) => { setGoal(e.target.value); setRetry(undefined); }} /></label>
        {shared.map((s) => (
          <p key={`${s.machine}${s.path}`} className="small orange" role="note"><PixelIcon name="warn" scale={1} /> {s.who.join(" and ")} share one checkout ({s.path} on {s.machine}): give them parts that won't touch the same files, or put one in a fresh worktree.</p>
        ))}
        <h3 className="alerts-heading">Parts</h3>
        <ul className="mission-crew">
          {crew.map((m) => {
            const key = unitKey(m.envId, m.threadId);
            const failed = retry?.keys.includes(key);
            return (
              <li key={key} className={failed ? "failed" : undefined}>
                <span className="mission-who" title={title(m)}>{title(m)}<span className="muted small"> · {envs[m.envId]?.summary.label}{busy.includes(m) ? " · busy" : ""}</span></span>
                <input value={parts[key] ?? ""} maxLength={500} placeholder="Their part (optional)" aria-label={`Part for ${title(m)}`} onChange={(e) => setPart(key, e.target.value)} />
              </li>
            );
          })}
        </ul>
        {crew.length > 0 && name.trim() && goal.trim() && (
          <details className="mission-preview"><summary className="muted small">What {titles[0]} will receive</summary>
            <pre>{missionBrief(plan, roster, roster[0].key, parts[roster[0].key])}</pre></details>
        )}
        <div className="review-actions">
          {busy.length > 0 && <label className="squad-queue small"><input type="checkbox" checked={queueBusy} onChange={(e) => setQueueBusy(e.target.checked)} /> {busy.length} busy: brief them after their turn</label>}
          {result && <span className="small orange" role="status">{result}</span>}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ready || sending} onClick={() => void send()}>
            {sending ? "…" : retry ? `Retry ${retry.keys.length} failed` : `Start mission with ${crew.length}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
