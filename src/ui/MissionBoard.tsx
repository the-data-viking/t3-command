// The work board: the whole fleet's work as cards in columns — what needs you, what's being
// planned, built, reviewed, or waiting to be read — so you can see where everything stands.

import { PixelLabel } from "./PixelArt";
import { useMemo } from "react";
import { createPortal } from "react-dom";
import { worldRef } from "../game/world";
import { openEvent, setSelection, unitKey, useGame } from "../store";
import { pendingRequests, type UnitState } from "../t3/derive";
import { boardOf, COLUMNS, type Card } from "./board";
import { DispatchList } from "./Dispatches";
import { openPrs } from "./dock";
import { openReview } from "./review";
import { prState } from "../t3/changes";
import type { ThreadShell } from "../t3/types";
import { requestSummary, waitingSince } from "./queue";
import { startQueue } from "./queue-run";
import { useClock } from "./useClock";
import { openDebrief } from "./debrief";
import { pulseOf, pulseText } from "./pulse";
import { FailedActions } from "./FailedActions";
import { modelName, stateLabel } from "./util";

/** Each state's shape, so a card's state never rests on colour alone. */
const MARK: Partial<Record<UnitState, string>> = { alert: "▲", question: "◆", error: "✕", working: "▶", monitoring: "○", done: "✓" };

function span(ms: number): string {
  const m = Math.max(1, Math.floor(ms / 60_000));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d`;
}

export function MissionBoard() {
  const envs = useGame((s) => s.envs);
  const readReports = useGame((s) => s.readReports);
  const details = useGame((s) => s.details);
  const stuckOk = useGame((s) => s.stuckOk);
  const now = useClock(true, 10000);
  const board = useMemo(() => boardOf(envs, readReports, { details, stuckOk }, now), [envs, readReports, details, stuckOk, now]);
  const close = () => useGame.setState({ showBoard: false });


  const prs = useMemo(() => openPrs(envs).length, [envs]);
  const total = COLUMNS.reduce((n, c) => n + board[c.id].length, 0);
  return createPortal(
    <div className="modal-backdrop" onClick={close}>
      <div className="modal board-modal" role="dialog" aria-label="Work board" onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2 className="title-tab"><PixelLabel text="Work board" /></h2>
          <span className="muted small">{total} crew at work</span>
          <span className="spacer" />
          {board["needs-you"].length + board.report.length > 0 && (
            <button className="btn small" onClick={() => { close(); startQueue(); }} title="One card at a time (Q)">▶ Work the queue</button>
          )}
          {prs > 0 && <button className="btn small" onClick={() => useGame.setState({ showBoard: false, showDock: true })} title="Every open PR, by how ready it is to merge (D)">Shipping dock ({prs})</button>}
          <button className="icon-btn" aria-label="Close work board" onClick={close}>✕</button>
        </header>
        <DispatchList onGo={close} />
        <div className="board">
          {COLUMNS.map((col) => (
            <section key={col.id} className={`board-col col-${col.id}`} aria-label={`${col.title}: ${board[col.id].length}`}>
              <h3 className="board-col-head" title={col.hint}>{col.title} <span className={`board-count${board[col.id].length ? "" : " zero"}`}>{board[col.id].length}</span></h3>
              <div className="board-cards">
                {board[col.id].length === 0 && <p className="muted small board-empty">Nothing here.</p>}
                {board[col.id].map((card) => <BoardCard key={unitKey(card.envId, card.thread.id)} card={card} onGo={close} />)}
              </div>
            </section>
          ))}
        </div>
        <p className="muted small">Crew at camp or idle are off the board. Click a card to go to its crew member.</p>
      </div>
    </div>,
    document.body,
  );
}

function BoardCard({ card, onGo }: { card: Card; onGo: () => void }) {
  const { envId, thread, state, column } = card;
  const env = useGame((s) => s.envs[envId]);
  const detail = useGame((s) => s.details[unitKey(envId, thread.id)]);
  const now = useClock();
  const project = env?.projects[thread.projectId]?.title ?? "No project";
  const turn = thread.latestTurn;
  const since = column === "needs-you" && state !== "error" && state !== "working"
    ? `waiting ${span(now - waitingSince(thread, detail?.thread))}`
    : state === "working" && turn?.startedAt ? `for ${span(now - Date.parse(turn.startedAt))}`
    : turn?.completedAt ? `${span(now - Date.parse(turn.completedAt))} ago` : "";
  const ask = (state === "alert" || state === "question") && detail ? requestSummary(pendingRequests(detail.thread)[0], 70) : undefined;
  // A long-running turn's pulse: is it moving, and is anything worth a look.
  const pulse = state === "working" && detail ? pulseOf(detail.thread, now) : undefined;
  const go = () => {
    const sel = { kind: "unit" as const, envId, threadId: thread.id };
    setSelection(sel);
    worldRef.current?.focus(sel);
    onGo();
  };
  return (
    <article className={`board-card st-border-${state}`}>
      <button className="board-card-main" onClick={go}>
        <span className="board-card-state">
          <span className={`st-${state}`}>{MARK[state] ?? "·"} {stateLabel(thread, state)}</span>
          {since && <span className="muted"> · {since}</span>}
          {env?.connection !== "live" && <span className="muted"> · no signal, last known</span>}
        </span>
        <span className="board-card-title">{thread.title || "Untitled"}</span>
        <span className="muted small">{project} · {env?.summary.label} · {modelName(env, thread)}</span>
        {ask && <span className={`board-card-ask st-${state}`}>{ask}</span>}
        {pulse && <span className={`board-card-pulse small${pulse.repeatFail ? " orange" : " muted"}`}>{pulseText(pulse, now)}</span>}
        {state === "error" && thread.session?.lastError && <span className="board-card-ask st-error">{thread.session.lastError.split("\n")[0].slice(0, 90)}</span>}
      </button>
      <OpenPrs thread={thread} />
      {(state === "alert" || state === "question") && (
        <button className="btn small board-card-act" onClick={() => { onGo(); openEvent({ envId, threadId: thread.id }); }}>{state === "alert" ? "Decide" : "Answer"}</button>
      )}
      {state === "error" && <FailedActions envId={envId} thread={thread} />}
      {column === "needs-you" && state === "working" && (
        <button className="btn small board-card-act" title="Halt it, ask what's blocking, or let it run" onClick={() => { onGo(); openDebrief({ envId, threadId: thread.id }); }}>Look</button>
      )}
      {(column === "report" || column === "review") && (
        <button className="btn small board-card-act" onClick={() => { onGo(); openReview({ envId, threadId: thread.id }); }}>Review</button>
      )}
    </article>
  );
}

const CHECK_MARK: Record<string, string> = { passing: "✓", failing: "✗", pending: "…" };

/** A card's open and draft PRs only, newest first, two at most: merged and linked history stays in the crew panel. */
function OpenPrs({ thread }: { thread: ThreadShell }) {
  const open = [...new Map((thread.pullRequests ?? []).filter((pr) => pr.snapshot?.state === "open").map((pr) => [`${pr.repository}#${pr.number}`, pr])).values()]
    .sort((a, b) => b.number - a.number);
  if (!open.length) return null;
  return (
    <div className="pr-chips">
      {open.slice(0, 2).map((pr) => {
        const state = prState(pr), checks = pr.snapshot?.checksState;
        return (
          <a key={`${pr.repository}#${pr.number}`} className={`pr-chip pr-${state}`} href={pr.url} target="_blank" rel="noreferrer" title={pr.snapshot?.title ?? pr.url}>
            <span className="pr-number">#{pr.number}</span>
            <span className="pr-state">{state.toUpperCase()}</span>
            {checks && CHECK_MARK[checks] && <span>{CHECK_MARK[checks]} checks</span>}
          </a>
        );
      })}
      {open.length > 2 && <span className="muted small">+{open.length - 2} open</span>}
    </div>
  );
}

