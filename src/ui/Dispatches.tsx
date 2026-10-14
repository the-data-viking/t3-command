// Order and mission receipts in the HUD: a top-bar chip while one is still playing out, and the
// work board's list of every order being followed, one row per crew member it went to.

import { useMemo } from "react";
import { worldRef } from "../game/world";
import { setSelection, useGame } from "../store";
import type { Dispatch } from "../../shared/dispatches";
import { logError } from "../t3/environment";
import { closeDispatch, dispatchTitle, progressOf, RECEIPT, type DispatchProgress } from "./dispatch";
import { useClock } from "./useClock";

function useProgress(): Array<{ dispatch: Dispatch; progress: DispatchProgress }> {
  const dispatches = useGame((s) => s.dispatches);
  const envs = useGame((s) => s.envs);
  return useMemo(() => dispatches.map((dispatch) => ({ dispatch, progress: progressOf(dispatch, envs) })), [dispatches, envs]);
}

function summary(p: DispatchProgress): string {
  return [
    `${p.reported} of ${p.total} reported`,
    p.needsYou && `${p.needsYou} need${p.needsYou === 1 ? "s" : ""} you`,
    p.trouble && `${p.trouble} went wrong`,
  ].filter(Boolean).join(" · ");
}

/** The newest squad order still playing out, as reported/total; hidden when none is. */
export function DispatchChip() {
  const open = useProgress().filter((d) => d.progress.done < d.progress.total);
  if (!open.length) return null;
  const { dispatch, progress } = open[0];
  const title = open.map((d) => `"${dispatchTitle(d.dispatch, 50)}": ${summary(d.progress)}`).join("\n");
  return (
    <button className="resource dispatch-chip" title={`${title}\nOn the work board (B)`} onClick={() => useGame.setState({ showBoard: true })}>
      <span className="res-key">{open.length > 1 ? `ORDERS ${open.length}` : dispatch.mission ? "MISSION" : "ORDER"}</span>
      <span className={`res-val${progress.needsYou ? " st-alert" : progress.trouble ? " st-error" : ""}`} aria-label={`${dispatchTitle(dispatch)}: ${summary(progress)}`}>{progress.reported}/{progress.total}</span>
    </button>
  );
}

function ago(ms: number): string {
  const m = Math.max(1, Math.floor(ms / 60_000));
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
}

/** The board's receipts: orders still playing out open, finished ones folded. */
export function DispatchList({ onGo }: { onGo: () => void }) {
  const list = useProgress();
  const envs = useGame((s) => s.envs);
  const now = useClock();
  if (!list.length) return null;
  const go = (envId: string, threadId: string) => {
    const sel = { kind: "unit" as const, envId, threadId };
    setSelection(sel);
    worldRef.current?.focus(sel);
    onGo();
  };
  return (
    <section className="dispatches" aria-label="Missions and squad orders">
      <h3 className="board-col-head">{list.some((d) => d.dispatch.mission) ? "Missions and orders" : "Orders to several crew"} <span className="board-count">{list.length}</span></h3>
      {list.map(({ dispatch, progress }) => {
        const finished = progress.done === progress.total;
        return (
          <details key={dispatch.id} className={`dispatch${finished ? " finished" : ""}`} open={!finished}>
            <summary>
              <span className="dispatch-title" title={dispatch.text}>{dispatchTitle(dispatch)}</span>
              <span className="muted small">{ago(now - dispatch.at)} · {summary(progress)}</span>
              {progress.total - progress.trouble > 0 && (
                <button className="btn small dispatch-read" title="Every reply to this order, side by side"
                  onClick={(e) => { e.preventDefault(); useGame.setState({ replies: dispatch.id }); }}>Read replies{progress.reported ? ` (${progress.reported})` : ""}</button>
              )}
              <button className="icon-btn small" aria-label={dispatch.mission ? "Close mission" : "Close order"} title={`${dispatch.mission ? "Close mission" : "Close order"}: stop following it (nothing is sent)`}
                onClick={(e) => { e.preventDefault(); void closeDispatch(dispatch.id).catch((err) => logError("Couldn't close the dispatch", err)); }}>✕</button>
            </summary>
            {dispatch.mission && <p className="dispatch-goal small"><strong>Goal:</strong> {dispatch.mission.goal}</p>}
            <ul className="dispatch-receipts">
              {progress.receipts.map(({ member, status }) => {
                const live = envs[member.envId]?.threads[member.threadId];
                return (
                  <li key={`${member.envId}:${member.threadId}`} className={`receipt r-${status}`}>
                    <span className="receipt-mark" aria-hidden>{RECEIPT[status].mark}</span>
                    {status === "gone" ? <span className="muted">{member.title}</span>
                      : <button className="receipt-crew" onClick={() => go(member.envId, member.threadId)}>{live?.title || member.title}</button>}
                    <span className="receipt-status">{RECEIPT[status].label}</span>
                    {member.part && <span className="receipt-part muted small" title={member.part}>{member.part}</span>}
                  </li>
                );
              })}
            </ul>
          </details>
        );
      })}
    </section>
  );
}
