// The shipping dock (D): every open pull request in the fleet, ranked by how ready it is to merge,
// with what's holding each one back. Review it, open it on the host, or ask its crew member to
// rebase. Merging stays on the host: it can't be undone from here.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { expandPlaybook } from "../../shared/playbooks";
import { sfx } from "../game/sfx";
import { worldRef } from "../game/world";
import { setSelection, useGame } from "../store";
import { turnBusy } from "../t3/derive";
import { envClient, logError } from "../t3/environment";
import type { PullRequestDetail } from "../t3/types";
import { DEMO, demoReview } from "../demo";
import { LANES, openPrs, readiness, type DockPr } from "./dock";
import { PixelLabel } from "./PixelArt";
import { openReview, reviewPullRequest } from "./review";
import { confirmReplacing, orderCrew, wouldReplace } from "./squad";

/** Host reads at once, and how many PRs get one (the rest go by their snapshot). */
const CONCURRENCY = 3;
const MAX_READS = 30;

export function ShippingDock() {
  const envs = useGame((s) => s.envs);
  const playbooks = useGame((s) => s.playbooks);
  const prs = useMemo(() => openPrs(envs), [envs]);
  const [details, setDetails] = useState<Record<string, PullRequestDetail | "error">>({});
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);
  const close = () => useGame.setState({ showDock: false });

  // Read each PR's detail from the host (checks, conflicts, commits behind), a few at a time.
  const wanted = prs.slice(0, MAX_READS).map((p) => p.key).join("|");
  useEffect(() => {
    let live = true;
    const queue = prs.slice(0, MAX_READS);
    if (DEMO) { const { pr } = demoReview(); setDetails(Object.fromEntries(queue.filter((p) => p.pr.number === pr.number).map((p) => [p.key, pr]))); return; }
    const next = async (): Promise<void> => {
      const item = queue.shift();
      if (!item || !live) return;
      try {
        const client = envClient(item.envId);
        if (!client) throw new Error("not connected");
        const d = await client.pullRequestDetail(item.thread.projectId, item.pr.repository, item.pr.number, item.pr.host);
        if (live) setDetails((s) => ({ ...s, [item.key]: d }));
      } catch { if (live) setDetails((s) => ({ ...s, [item.key]: "error" })); }
      return next();
    };
    void Promise.all(Array.from({ length: CONCURRENCY }, next));
    return () => { live = false; };
  }, [wanted]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = prs.map((p) => {
    const d = details[p.key];
    return { ...p, detail: d === "error" ? undefined : d, unread: d === "error", ready: readiness(p.pr, d === "error" ? undefined : d) };
  });

  const go = (p: DockPr) => {
    const sel = { kind: "unit" as const, envId: p.envId, threadId: p.thread.id };
    setSelection(sel);
    worldRef.current?.focus(sel);
    close();
  };
  // Ask the PR's crew member to rebase (your saved /rebase order); queued if they're busy.
  const rebase = async (p: DockPr) => {
    if (busy) return;
    const target = { envId: p.envId, threadId: p.thread.id };
    const queueFor = () => turnBusy(envs[p.envId].threads[p.thread.id]);
    if (!confirmReplacing(wouldReplace([target], queueFor))) return;
    setBusy(true);
    try {
      const order = `${expandPlaybook("/rebase", playbooks)}\n\n(For PR #${p.pr.number}, ${p.pr.snapshot?.headBranch ?? "its branch"} onto ${p.pr.snapshot?.baseBranch ?? "its base"}.)`;
      const { sent, queued, failed } = await orderCrew([target], () => order, queueFor);
      (failed ? sfx.error : sfx.order)();
      setNote(failed ? `Couldn't ask "${p.thread.title}" to rebase.` : `${queued ? "Queued for after its turn" : sent ? "Sent" : ""}: "${p.thread.title}" will rebase #${p.pr.number}.`);
    } catch (err) { sfx.error(); logError("Couldn't send the rebase", err); }
    finally { setBusy(false); }
  };

  const connected = (p: DockPr) => envs[p.envId]?.connection === "live" && envs[p.envId]?.summary.kind !== "hermes";
  return createPortal(
    <div className="modal-backdrop" onClick={close}>
      <div className="modal dock-modal" role="dialog" aria-label="Shipping dock" onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2 className="title-tab"><PixelLabel text="Shipping dock" /></h2>
          <span className="muted small">{prs.length} open PR{prs.length === 1 ? "" : "s"} · {rows.filter((r) => r.ready.lane === "ready").length} ready to merge</span>
          <span className="spacer" />
          <button className="icon-btn" aria-label="Close shipping dock" onClick={close}>✕</button>
        </header>
        {note && <p className="small muted" role="status">{note}</p>}
        {prs.length === 0 && <p className="muted">No open pull requests in the fleet.</p>}
        <div className="dock-lanes">
          {LANES.map((lane) => {
            const inLane = rows.filter((r) => r.ready.lane === lane.id);
            if (!inLane.length) return null;
            return (
              <section key={lane.id} className={`dock-lane lane-${lane.id}`} aria-label={`${lane.title}: ${inLane.length}`}>
                <h3 className="board-col-head" title={lane.hint}>{lane.title} <span className="board-count">{inLane.length}</span></h3>
                <ul className="dock-list">
                  {inLane.map((r) => (
                    <li key={r.key} className="dock-pr">
                      <div className="dock-pr-main">
                        <a href={r.pr.url} target="_blank" rel="noreferrer" className="dock-pr-title">#{r.pr.number} {r.pr.snapshot?.title ?? ""}</a>
                        <span className="muted small">{r.pr.repository} · <button className="dock-crew" onClick={() => go(r)} title="Go to the crew member">{r.thread.title || "Untitled"}</button>
                          {r.detail && <> · <span className="diff-add">+{r.detail.additions}</span> <span className="diff-del">−{r.detail.deletions}</span></>}</span>
                        <span className={`dock-why small${lane.id === "attention" ? " orange" : lane.id === "ready" ? " green" : " muted"}`}>
                          {r.ready.reasons.join(" · ")}{r.unread ? " · host detail unavailable (from T3's snapshot)" : !r.detail && !DEMO ? " · reading…" : ""}
                        </span>
                      </div>
                      <div className="dock-actions">
                        {reviewPullRequest(r.thread)?.number === r.pr.number && (
                          <button className="btn small" title="The crew member's last turn, claims beside evidence, and this PR" onClick={() => { close(); openReview({ envId: r.envId, threadId: r.thread.id }); }}>Review</button>
                        )}
                        {r.ready.rebase && <button className="btn small" disabled={busy || !connected(r)} title="Send its crew member your saved /rebase order (queued if busy)" onClick={() => void rebase(r)}>Rebase</button>}
                        <a className="btn small" href={r.pr.url} target="_blank" rel="noreferrer">Open ↗</a>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
        <p className="muted small">Merging stays on the host. Readiness is what T3 and the host report: checks, conflicts, commits behind, reviews.</p>
      </div>
    </div>,
    document.body,
  );
}
