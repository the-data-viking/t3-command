// Order and mission receipts in the HUD: a top-bar chip while one is still playing out, and the
// work board's list of every order being followed, one row per crew member it went to.

import { useMemo } from "react";
import { worldRef } from "../game/world";
import { setSelection, useGame } from "../store";
import { groupOf, type Dispatch } from "../../shared/dispatches";
import { logError } from "../t3/environment";
import { closeDispatch, dispatchTitle, progressOf, RECEIPT, receiptLabel, type DispatchProgress } from "./dispatch";
import { useClock } from "./useClock";

/**
 * Each order or mission once, by its newest round (`earlier`: how many rounds came before it):
 * a mission's follow-ups are one thread of work, not separate copies on the board.
 */
function useProgress(): Array<{ dispatch: Dispatch; progress: DispatchProgress; earlier: number }> {
  const dispatches = useGame((s) => s.dispatches);
  const envs = useGame((s) => s.envs);
  return useMemo(() => {
    const newest = new Map<string, Dispatch>(), count = new Map<string, number>();
    for (const d of dispatches) {
      const g = groupOf(d);
      count.set(g, (count.get(g) ?? 0) + 1);
      const have = newest.get(g);
      if (!have || (d.round ?? 1) > (have.round ?? 1)) newest.set(g, d);
    }
    return [...newest.values()].sort((a, b) => b.at - a.at).map((dispatch) => ({ dispatch, progress: progressOf(dispatch, envs), earlier: (count.get(groupOf(dispatch)) ?? 1) - 1 }));
  }, [dispatches, envs]);
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
  const { dispatch } = open[0];
  // Every open order's crew together: reported of all, so "ORDERS 2 · 1/5" never reads as 1 of 2 orders.
  const sum = (k: "reported" | "total" | "needsYou" | "trouble") => open.reduce((n, d) => n + d.progress[k], 0);
  const title = open.map((d) => `"${dispatchTitle(d.dispatch, 50)}": ${summary(d.progress)}`).join("\n");
  const label = open.length > 1 ? `${open.length} orders: ${sum("reported")} of ${sum("total")} crew reported` : `${dispatchTitle(dispatch)}: ${summary(open[0].progress)}`;
  return (
    <button className="resource dispatch-chip" title={`${title}\nOn the work board (B)`} onClick={() => useGame.setState({ showBoard: true })}>
      <span className="res-key">{open.length > 1 ? `ORDERS ${open.length}` : dispatch.mission ? "MISSION" : "ORDER"}</span>
      <span className={`res-val${sum("needsYou") ? " st-alert" : sum("trouble") ? " st-error" : ""}`} aria-label={label}>{sum("reported")}/{sum("total")}</span>
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
      {list.map(({ dispatch, progress, earlier }) => {
        const finished = progress.done === progress.total;
        return (
          <details key={dispatch.id} className={`dispatch${finished ? " finished" : ""}`} open={!finished}>
            <summary>
              <span className="dispatch-title" title={dispatch.text}>{dispatchTitle(dispatch)}</span>
              <span className="muted small">{ago(now - dispatch.at)} · {summary(progress)}{earlier ? ` · ${earlier} earlier round${earlier === 1 ? "" : "s"}` : ""}</span>
              {progress.total - progress.trouble > 0 && (
                <button className="btn small dispatch-read" title="Every reply to this order, side by side"
                  onClick={(e) => { e.preventDefault(); useGame.setState({ replies: dispatch.id }); }}>Read replies{progress.reported ? ` (${progress.reported})` : ""}</button>
              )}
              <button className="icon-btn small" aria-label={dispatch.mission ? "Close mission" : "Close order"} title={`${dispatch.mission ? "Close mission" : "Close order"}: stop following it (nothing is sent; anything still queued is cancelled, after asking)`}
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
                    <span className="receipt-status" title={receiptLabel(status, member)}>{receiptLabel(status, member)}</span>
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
