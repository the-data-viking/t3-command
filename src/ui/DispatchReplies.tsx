// The replies to a squad order, side by side: send "/status" to five crew, then read all five
// answers in one place instead of opening each crew member in turn. Each card is that crew
// member's last message in the turn the order started; reading them all marks those reports read.
// From here a mission carries on: follow up with the same crew (optionally passing each one what
// the others reported), copy the whole debrief, or close it.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { worldRef } from "../game/world";
import { sfx } from "../game/sfx";
import { markReportsRead, setSelection, unitKey, useGame } from "../store";
import { envClient, logError } from "../t3/environment";
import { turnBusy } from "../t3/derive";
import { closeDispatch, dispatchTitle, progressOf, RECEIPT, recordDispatch, replyOf, updateDispatch, type ReceiptStatus } from "./dispatch";
import { groupOf, type DispatchMember } from "../../shared/dispatches";
import { useDraft } from "./drafts";
import { debriefMarkdown, followUpBrief, type DebriefRound, type SharedReply } from "./mission";
import { confirmReplacing, orderCrew, wouldReplace } from "./squad";
import { MessageMarkdown } from "./MessageMarkdown";
import { PixelLabel } from "./PixelArt";

/** What a card says while there's no reply to show. */
const WAITING: Partial<Record<ReceiptStatus, string>> = {
  working: "Still working on it.",
  "needs-you": "Waiting on you before it can answer.",
  failed: "The turn failed before it replied.",
  stopped: "The turn was interrupted.",
  superseded: "Another turn started before this one was seen to end, so its reply isn't known here.",
};

/** Parts that went wrong before they produced anything: the same brief can be sent again. */
const RESENDABLE = new Set<ReceiptStatus>(["unsent", "undelivered", "unstarted", "failed", "stopped"]);

/** Replies you can read first, then what's waiting on you, still going, and what went wrong. */
const RANK: ReceiptStatus[] = ["reported", "needs-you", "working", "sent", "queued", "superseded", "stopped", "failed", "unstarted", "undelivered", "unsent", "gone"];

export function DispatchReplies() {
  const id = useGame((s) => s.replies);
  const dispatch = useGame((s) => s.dispatches.find((d) => d.id === id));
  if (!id || !dispatch) return null;
  return <Replies key={id} id={id} />;
}

function Replies({ id }: { id: string }) {
  const dispatch = useGame((s) => s.dispatches.find((d) => d.id === id))!;
  const envs = useGame((s) => s.envs);
  const details = useGame((s) => s.details);
  const readReports = useGame((s) => s.readReports);
  const progress = useMemo(() => progressOf(dispatch, envs), [dispatch, envs]);
  const close = () => useGame.setState({ replies: null });

  // Follow every recipient's thread while the panel is open, so their replies load and update.
  const members = dispatch.members.map((m) => `${m.envId}\n${m.threadId}`).join("|");
  useEffect(() => {
    const stops = members.split("|").map((k) => { const [envId, threadId] = k.split("\n"); return envClient(envId)?.watchThread(threadId); });
    return () => { for (const stop of stops) stop?.(); };
  }, [members]);

  const cards = progress.receipts.map(({ member, status }) => {
    const thread = envs[member.envId]?.threads[member.threadId];
    const reply = replyOf(status, thread, details[unitKey(member.envId, member.threadId)], member);
    const turnId = member.turnId ?? thread?.latestTurn?.turnId;
    const unread = status === "reported" && !!turnId && readReports[unitKey(member.envId, member.threadId)] !== turnId;
    return { member, status, thread, reply, turnId, unread };
  }).sort((a, b) => RANK.indexOf(a.status) - RANK.indexOf(b.status));
  const unread = cards.filter((c) => c.unread);
  const [asking, setAsking] = useState(false);
  const [text, setText, clearText] = useDraft(`followup:${id}`);
  const [share, setShare] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const shared: SharedReply[] = cards.map((c) => ({ title: c.thread?.title || c.member.title, reply: c.reply, status: RECEIPT[c.status].label, part: c.member.part }));
  // Every round of this order or mission, in order: tabs to move between them, one debrief for all.
  const allDispatches = useGame((s) => s.dispatches);
  const rounds = useMemo(() => allDispatches.filter((d) => groupOf(d) === groupOf(dispatch)).sort((a, b) => (a.round ?? 1) - (b.round ?? 1)), [allDispatches, dispatch]);
  const debriefRounds: DebriefRound[] = rounds.map((r) => ({ round: r.round ?? 1, order: r.text,
    replies: progressOf(r, envs).receipts.map(({ member, status }) => {
      const t = envs[member.envId]?.threads[member.threadId];
      return { title: t?.title || member.title, status: RECEIPT[status].label, part: member.part, reply: replyOf(status, t, details[unitKey(member.envId, member.threadId)], member) };
    }) }));
  // Who a follow-up can reach: still aboard, on a connected T3 station.
  const reachable = cards.filter((c) => c.thread && !c.thread.archivedAt && envs[c.member.envId]?.connection === "live" && envs[c.member.envId]?.summary.kind !== "hermes");
  const replied = cards.filter((c) => c.reply).length;

  const followUp = async () => {
    if (!text.trim() || busy || !reachable.length) return;
    setBusy(true);
    const byKey = new Map(cards.map((c) => [unitKey(c.member.envId, c.member.threadId), c]));
    const targets = reachable.map((c) => ({ envId: c.member.envId, threadId: c.member.threadId }));
    const others = (key: string) => share ? shared.filter((_, i) => unitKey(cards[i].member.envId, cards[i].member.threadId) !== key) : [];
    const queueFor = (m: { envId: string; threadId: string }) => turnBusy(envs[m.envId].threads[m.threadId]);
    if (!confirmReplacing(wouldReplace(targets, queueFor))) { setBusy(false); return; }
    const { receipts, failed } = await orderCrew(targets,
      (m) => followUpBrief({ mission: dispatch.mission, text, part: byKey.get(unitKey(m.envId, m.threadId))?.member.part, others: others(unitKey(m.envId, m.threadId)) }),
      queueFor,
      (m) => byKey.get(unitKey(m.envId, m.threadId))?.member.part);
    try {
      // Read what's been answered: the follow-up is the response to it.
      markReportsRead(unread.map((c) => ({ envId: c.member.envId, threadId: c.member.threadId, turnId: c.turnId! })));
      // The next round of the same mission (or order): one thread of work on the board, not copies.
      const next = await recordDispatch(text.trim(), receipts, dispatch.mission, groupOf(dispatch));
      clearText();
      setAsking(false);
      (failed ? sfx.error : sfx.order)();
      // Follow the new round from here; the earlier one stays on the board until closed.
      useGame.setState({ replies: next.id });
    } catch (err) { sfx.error(); logError("Couldn't record the follow-up", err); }
    finally { setBusy(false); }
  };
  /**
   * Send one crew member exactly what they were sent before (a failed send, a follow-up that never
   * went, a turn that failed or never started), recorded on this same order or mission.
   */
  const resend = async (member: DispatchMember) => {
    if (busy) return;
    const target = { envId: member.envId, threadId: member.threadId };
    const queueFor = () => turnBusy(envs[member.envId].threads[member.threadId]);
    if (!confirmReplacing(wouldReplace([target], queueFor))) return;
    setBusy(true);
    try {
      const { receipts, failed } = await orderCrew([target], () => member.brief ?? dispatch.text, queueFor, () => member.part);
      await updateDispatch(dispatch.id, receipts);
      (failed ? sfx.error : sfx.order)();
      setNote(failed ? `Couldn't resend to ${member.title}.` : `Resent to ${member.title}.`);
    } catch (err) { sfx.error(); logError("Couldn't resend", err); }
    finally { setBusy(false); }
  };
  const copyDebrief = async () => {
    try {
      await navigator.clipboard.writeText(debriefMarkdown({ mission: dispatch.mission, order: rounds[0]?.text ?? dispatch.text, replies: shared, rounds: debriefRounds }));
      setNote("Debrief copied as markdown.");
    } catch { setNote("Couldn't copy: the browser blocked the clipboard."); }
  };
  const finish = () => {
    markReportsRead(unread.map((c) => ({ envId: c.member.envId, threadId: c.member.threadId, turnId: c.turnId! })));
    void closeDispatch(dispatch.id).catch((err) => logError("Couldn't close it", err));
    sfx.order();
    close();
  };
  const go = (envId: string, threadId: string) => {
    const sel = { kind: "unit" as const, envId, threadId };
    setSelection(sel);
    worldRef.current?.focus(sel);
    useGame.setState({ replies: null, showBoard: false });
  };

  return createPortal(
    <div className="modal-backdrop" onClick={close}>
      <div className="modal replies-modal" role="dialog" aria-label={`Replies: ${dispatchTitle(dispatch)}`} onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2 className="title-tab"><PixelLabel text="Replies" /></h2>
          <span className="review-title" title={dispatch.text}>{dispatchTitle(dispatch)}</span>
          <span className="spacer" />
          <button className="icon-btn" aria-label="Close replies" onClick={close}>✕</button>
        </header>
        <p className="muted small">{progress.reported} of {progress.total} reported{progress.needsYou ? ` · ${progress.needsYou} waiting on you` : ""}</p>
        {dispatch.mission && <p className="dispatch-goal small"><strong>Goal:</strong> {dispatch.mission.goal}</p>}
        {rounds.length > 1 && (
          <div className="round-tabs" role="tablist" aria-label="Rounds">
            {rounds.map((r) => (
              <button key={r.id} role="tab" aria-selected={r.id === dispatch.id} className={`btn small${r.id === dispatch.id ? " primary" : ""}`}
                title={r.text.split("\n")[0]} onClick={() => useGame.setState({ replies: r.id })}>Round {r.round ?? 1}</button>
            ))}
          </div>
        )}
        <div className="replies">
          {cards.map(({ member, status, thread, reply, unread: fresh }) => (
            <article key={`${member.envId}:${member.threadId}`} className={`reply r-${status}${fresh ? " unread" : ""}`}>
              <header className="reply-head">
                <span className="receipt-mark" aria-hidden>{RECEIPT[status].mark}</span>
                {status === "gone" ? <span className="muted">{member.title}</span>
                  : <button className="receipt-crew" onClick={() => go(member.envId, member.threadId)} title="Go to this crew member">{thread?.title || member.title}</button>}
                <span className="receipt-status">{RECEIPT[status].label}</span>
                {RESENDABLE.has(status) && thread && !thread.archivedAt && envs[member.envId]?.connection === "live" && (
                  <button className="btn small" disabled={busy} title="Send exactly what was sent before, on this same order" onClick={() => void resend(member)}>Resend</button>
                )}
              </header>
              <p className="muted small">{envs[member.envId]?.summary.label ?? member.envId}{member.part ? ` · part: ${member.part}` : ""}</p>
              {reply ? <div className="reply-body"><MessageMarkdown text={reply} envId={member.envId} threadId={member.threadId} /></div>
                : <p className="muted reply-body">{WAITING[status] ?? (status === "reported" ? "Loading…" : `${RECEIPT[status].label[0].toUpperCase()}${RECEIPT[status].label.slice(1)}.`)}</p>}
            </article>
          ))}
        </div>
        {asking && (
          <div className="review-changes-box">
            <textarea autoFocus rows={3} value={text} placeholder={dispatch.mission ? "What next, for everyone on the mission? Each keeps their own part." : "What next, for all of them?"}
              onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setAsking(false); } }} />
            <label className="squad-queue small"><input type="checkbox" checked={share && replied > 0} disabled={!replied} onChange={(e) => setShare(e.target.checked)} />
              {" "}Pass each one what the others reported{replied ? ` (${replied} repl${replied === 1 ? "y" : "ies"}, up to 1,500 characters each)` : " (no replies yet)"}</label>
          </div>
        )}
        {note && <p className="small muted" role="status">{note}</p>}
        <div className="review-actions">
          <button className="btn approve" disabled={!unread.length} title="Mark every reply here read; they leave Needs you"
            onClick={() => { markReportsRead(unread.map((c) => ({ envId: c.member.envId, threadId: c.member.threadId, turnId: c.turnId! }))); sfx.order(); close(); }}>
            {unread.length ? `Mark ${unread.length} read` : "All read"}
          </button>
          <button className="btn" title="Goal and every reply, as markdown" onClick={() => void copyDebrief()}>Copy debrief</button>
          <span className="spacer" />
          {asking
            ? <button className="btn primary" disabled={busy || !text.trim() || !reachable.length} onClick={() => void followUp()}>{busy ? "…" : `Send to ${reachable.length}`}</button>
            : <button className="btn" disabled={!reachable.length} title="Order the same crew again; busy ones get it after their turn" onClick={() => setAsking(true)}>Follow up…</button>}
          <button className="btn" title="Mark the replies read and stop following it (nothing is sent)" onClick={finish}>{dispatch.mission ? "Close mission" : "Close order"}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
