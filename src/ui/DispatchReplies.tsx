// The replies to a squad order, side by side: send "/status" to five crew, then read all five
// answers in one place instead of opening each crew member in turn. Each card is that crew
// member's last message in the turn the order started; reading them all marks those reports read.

import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { worldRef } from "../game/world";
import { sfx } from "../game/sfx";
import { markReportsRead, setSelection, unitKey, useGame } from "../store";
import { envClient } from "../t3/environment";
import { dispatchTitle, progressOf, RECEIPT, replyOf, type ReceiptStatus } from "./dispatch";
import { MessageMarkdown } from "./MessageMarkdown";
import { PixelLabel } from "./PixelArt";

/** What a card says while there's no reply to show. */
const WAITING: Partial<Record<ReceiptStatus, string>> = {
  working: "Still working on it.",
  "needs-you": "Waiting on you before it can answer.",
  failed: "The turn failed before it replied.",
  stopped: "The turn was interrupted.",
};

/** Replies you can read first, then what's waiting on you, still going, and what went wrong. */
const RANK: ReceiptStatus[] = ["reported", "needs-you", "working", "sent", "queued", "stopped", "failed", "undelivered", "unsent", "gone"];

export function DispatchReplies() {
  const id = useGame((s) => s.replies);
  const dispatch = useGame((s) => s.dispatches.find((d) => d.id === id));
  if (!id || !dispatch) return null;
  return <Replies key={id} id={id} />;
}

function Replies({ id }: { id: string }) {
  const dispatch = useGame((s) => s.dispatches.find((d) => d.id === id))!;
  const envs = useGame((s) => s.envs);
  const followUps = useGame((s) => s.followUps);
  const details = useGame((s) => s.details);
  const readReports = useGame((s) => s.readReports);
  const progress = useMemo(() => progressOf(dispatch, envs, followUps), [dispatch, envs, followUps]);
  const close = () => useGame.setState({ replies: null });

  // Follow every recipient's thread while the panel is open, so their replies load and update.
  const members = dispatch.members.map((m) => `${m.envId}\n${m.threadId}`).join("|");
  useEffect(() => {
    const stops = members.split("|").map((k) => { const [envId, threadId] = k.split("\n"); return envClient(envId)?.watchThread(threadId); });
    return () => { for (const stop of stops) stop?.(); };
  }, [members]);

  const cards = progress.receipts.map(({ member, status }) => {
    const thread = envs[member.envId]?.threads[member.threadId];
    const reply = replyOf(status, thread, details[unitKey(member.envId, member.threadId)]);
    const turnId = thread?.latestTurn?.turnId;
    const unread = status === "reported" && !!turnId && readReports[unitKey(member.envId, member.threadId)] !== turnId;
    return { member, status, thread, reply, turnId, unread };
  }).sort((a, b) => RANK.indexOf(a.status) - RANK.indexOf(b.status));
  const unread = cards.filter((c) => c.unread);
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
        <div className="replies">
          {cards.map(({ member, status, thread, reply, unread: fresh }) => (
            <article key={`${member.envId}:${member.threadId}`} className={`reply r-${status}${fresh ? " unread" : ""}`}>
              <header className="reply-head">
                <span className="receipt-mark" aria-hidden>{RECEIPT[status].mark}</span>
                {status === "gone" ? <span className="muted">{member.title}</span>
                  : <button className="receipt-crew" onClick={() => go(member.envId, member.threadId)} title="Go to this crew member">{thread?.title || member.title}</button>}
                <span className="receipt-status">{RECEIPT[status].label}</span>
              </header>
              <p className="muted small">{envs[member.envId]?.summary.label ?? member.envId}{member.part ? ` · part: ${member.part}` : ""}</p>
              {reply ? <div className="reply-body"><MessageMarkdown text={reply} envId={member.envId} threadId={member.threadId} /></div>
                : <p className="muted reply-body">{WAITING[status] ?? (status === "reported" ? "Loading…" : `${RECEIPT[status].label[0].toUpperCase()}${RECEIPT[status].label.slice(1)}.`)}</p>}
            </article>
          ))}
        </div>
        <div className="review-actions">
          <button className="btn approve" disabled={!unread.length} title="Mark every reply here read; they leave Needs you"
            onClick={() => { markReportsRead(unread.map((c) => ({ envId: c.member.envId, threadId: c.member.threadId, turnId: c.turnId! }))); sfx.order(); close(); }}>
            {unread.length ? `Mark ${unread.length} read` : "All read"}
          </button>
          <span className="spacer" />
          <button className="btn" onClick={close}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
