// The mission board: the whole fleet's work as cards in columns — what needs you, what's being
// planned, built, reviewed, or waiting to be read — so you can see where everything stands.

import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { worldRef } from "../game/world";
import { openEvent, setSelection, unitKey, useGame } from "../store";
import { pendingRequests, type UnitState } from "../t3/derive";
import { boardOf, COLUMNS, type Card } from "./board";
import { openDebrief } from "./debrief";
import { PullRequestChips } from "./MissionTelemetry";
import { requestSummary, waitingSince } from "./queue";
import { startQueue } from "./queue-run";
import { useClock } from "./useClock";
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
  const board = useMemo(() => boardOf(envs, readReports), [envs, readReports]);
  const close = () => useGame.setState({ showBoard: false });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const total = COLUMNS.reduce((n, c) => n + board[c.id].length, 0);
  return createPortal(
    <div className="modal-backdrop" onClick={close}>
      <div className="modal board-modal" role="dialog" aria-label="Mission board" onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2>Mission board</h2>
          <span className="muted small">{total} mission{total === 1 ? "" : "s"} in flight</span>
          <span className="spacer" />
          {board["needs-you"].length + board.report.length > 0 && (
            <button className="btn small" onClick={() => { close(); startQueue(); }} title="One card at a time (Q)">▶ Work the queue</button>
          )}
          <button className="icon-btn" aria-label="Close mission board" onClick={close}>✕</button>
        </header>
        <div className="board">
          {COLUMNS.map((col) => (
            <section key={col.id} className={`board-col col-${col.id}`} aria-label={`${col.title}: ${board[col.id].length}`}>
              <h3 className="board-col-head" title={col.hint}>{col.title} <span className="board-count">{board[col.id].length}</span></h3>
              <div className="board-cards">
                {board[col.id].length === 0 && <p className="muted small board-empty">Nothing here.</p>}
                {board[col.id].map((card) => <BoardCard key={unitKey(card.envId, card.thread.id)} card={card} onGo={close} />)}
              </div>
            </section>
          ))}
        </div>
        <p className="muted small">Missions at camp or idle are off the board. Click a card to go to its crew member.</p>
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
  const since = column === "needs-you" && state !== "error"
    ? `waiting ${span(now - waitingSince(thread, detail?.thread))}`
    : state === "working" && turn?.startedAt ? `for ${span(now - Date.parse(turn.startedAt))}`
    : turn?.completedAt ? `${span(now - Date.parse(turn.completedAt))} ago` : "";
  const ask = (state === "alert" || state === "question") && detail ? requestSummary(pendingRequests(detail.thread)[0], 70) : undefined;
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
        {state === "error" && thread.session?.lastError && <span className="board-card-ask st-error">{thread.session.lastError.split("\n")[0].slice(0, 90)}</span>}
      </button>
      <PullRequestChips thread={thread} />
      {(state === "alert" || state === "question") && (
        <button className="btn small board-card-act" onClick={() => { onGo(); openEvent({ envId, threadId: thread.id }); }}>{state === "alert" ? "Decide" : "Answer"}</button>
      )}
      {column === "report" && (
        <button className="btn small board-card-act" onClick={() => { onGo(); openDebrief({ envId, threadId: thread.id }); }}>Read report</button>
      )}
    </article>
  );
}
