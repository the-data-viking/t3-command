// Review: "is this done?" answered in Command. The agent's report (what it claims) beside what
// Command can observe — its PR's checks, the tests it ran this turn and how they ended, the PR
// against its base — and the whole branch's changes, then a verdict: accept, request changes,
// open the PR, or stand the crew member down. Merging stays on the host: it can't be undone here.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { sfx } from "../game/sfx";
import { markReportsRead, unitKey, useGame } from "../store";
import { parseDiff, type ParsedDiff } from "../t3/diff";
import { readPrDetail } from "../t3/pr-detail";
import { envClient, logError } from "../t3/environment";
import type { PullRequestDetail } from "../t3/types";
import { DiffFiles } from "./DiffFiles";
import { useDraft } from "./drafts";
import { MessageMarkdown } from "./MessageMarkdown";
import { PixelLabel, PixelIcon } from "./PixelArt";
import { changesOrder, checksSummary, doubts, openReview, reviewPullRequest, testsRun } from "./review";
import { batchSettle } from "./squad";
import { DEMO, demoReview } from "../demo";

/** The PR snapshot's overall check state, when the host's per-check detail can't be read. */
function snapshotChecks(state: string | null | undefined): string {
  return state === "passing" ? "passing (summary)" : state === "failing" ? "failing (summary)" : state === "pending" ? "pending (summary)" : "unavailable";
}

const CHECK_MARK: Record<string, string> = { success: "✓", skipped: "–", neutral: "–", pending: "…", failure: "✕", cancelled: "✕", "action-required": "!" };

export function ReviewPanel() {
  const at = useGame((s) => s.review);
  if (!at) return null;
  return <Review key={unitKey(at.envId, at.threadId)} envId={at.envId} threadId={at.threadId} />;
}

function Review({ envId, threadId }: { envId: string; threadId: string }) {
  const env = useGame((s) => s.envs[envId]);
  const thread = env?.threads[threadId];
  const detail = useGame((s) => s.details[unitKey(envId, threadId)]);
  const [diff, setDiff] = useState<ParsedDiff>();
  /** What the diff covers: the whole branch, or (when T3 can't produce that) the latest turn. */
  const [diffScope, setDiffScope] = useState<"branch" | "turn">("branch");
  const [branchError, setBranchError] = useState<string>();
  const [turnFailed, setTurnFailed] = useState(false);
  const [diffError, setDiffError] = useState<string>();
  const [pr, setPr] = useState<PullRequestDetail>();
  const [prError, setPrError] = useState<string>();
  const [asking, setAsking] = useState(false);
  const [notes, setNotes, clearNotes] = useDraft(`review:${envId}:${threadId}`);
  const [busy, setBusy] = useState(false);
  const close = () => openReview(null);

  useEffect(() => envClient(envId)?.watchThread(threadId), [envId, threadId]);

  // The whole branch's changes, up to the latest checkpoint.
  const latest = useMemo(() => Math.max(0, ...(detail?.thread.checkpoints ?? []).map((c) => c.checkpointTurnCount)), [detail]);
  useEffect(() => {
    if (!latest) return;
    if (DEMO) { setDiff(parseDiff(demoReview().diff)); return; }
    const client = envClient(envId);
    if (!client) { setDiffError("this station is not connected"); return; }
    let live = true;
    // Show the latest turn's changes right away, then the whole branch's once T3 produces it (long
    // threads can be slow or unable to); whichever the panel shows is labelled.
    let branch = false;
    client.turnDiff(threadId, latest - 1, latest)
      .then((d) => { if (live && !branch) { setDiffScope("turn"); setDiff(parseDiff(d)); } })
      .catch(() => { if (live) setTurnFailed(true); });
    Promise.race([client.fullThreadDiff(threadId, latest), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 25_000))])
      .then((d) => { if (live) { branch = true; setDiffScope("branch"); setDiff(parseDiff(d)); } })
      .catch((err: unknown) => { if (live) setBranchError(err instanceof Error ? err.message : String(err)); });
    return () => { live = false; };
  }, [envId, threadId, latest]);

  const ref = thread ? reviewPullRequest(thread) : undefined;
  useEffect(() => {
    if (!ref || !thread) return;
    if (DEMO) { setPr(demoReview().pr); return; }
    let live = true;
    readPrDetail(envId, thread.projectId, ref)
      .then((d) => { if (live) setPr(d); })
      .catch((err: unknown) => { if (live) setPrError(err instanceof Error ? err.message : String(err)); });
    return () => { live = false; };
    // Re-read when the PR's snapshot moves (checks finishing, a merge).
  }, [envId, thread?.projectId, ref?.repository, ref?.number, ref?.host, ref?.snapshot?.checksState, ref?.snapshot?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!env || !thread) return null;
  const turnId = thread.latestTurn?.turnId;
  const report = [...(detail?.thread.messages ?? [])].reverse().find((m) => m.role === "assistant" && m.turnId === turnId && m.text.trim())?.text;
  const tests = detail ? testsRun(detail.thread) : [];
  const checks = checksSummary(pr);
  // Where the report and the evidence disagree: shown first, and Mark read stops looking like approval.
  const doubtful = doubts(report, tests, checks, (thread.pullRequests ?? []).map((p) => p.number));
  const project = env.projects[thread.projectId];

  const act = async (run: () => Promise<void> | void) => {
    if (busy) return;
    setBusy(true);
    try { await run(); } catch (err) { sfx.error(); logError("Review action failed", err); } finally { setBusy(false); }
  };
  const accept = () => act(() => { if (turnId) markReportsRead([{ envId, threadId, turnId }]); sfx.order(); close(); });
  const requestChanges = () => act(async () => {
    if (!notes.trim()) return;
    await envClient(envId)!.order(threadId, changesOrder(notes));
    clearNotes();
    if (turnId) markReportsRead([{ envId, threadId, turnId }]);
    sfx.order();
    close();
  });
  const camp = () => act(async () => { if (turnId) markReportsRead([{ envId, threadId, turnId }]); await batchSettle(true, [{ envId, threadId }]); close(); });

  return createPortal(
    <div className="modal-backdrop" onClick={close}>
      <div className="modal review-modal" role="dialog" aria-label={`Review: ${thread.title}`} onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2 className="title-tab"><PixelLabel text="Review" /></h2>
          <span className="review-title">{thread.title || "Untitled"}</span>
          <span className="spacer" />
          <button className="icon-btn" aria-label="Close review" onClick={close}>✕</button>
        </header>
        <p className="muted small">{[env.summary.label, project?.title, thread.branch && `branch ${thread.branch}`].filter(Boolean).join(" · ")}</p>

        {doubtful.length > 0 && (
          <div className="review-doubts" role="note">
            <strong><PixelIcon name="warn" /> Doesn't add up</strong>
            <ul>{doubtful.map((d) => <li key={d.claim}>{d.claim}, but {d.evidence}.</li>)}</ul>
            <span className="muted small">Pattern matching on the report: a reason to look, not a verdict.</span>
          </div>
        )}
        <div className="review-columns">
          <section className="review-claims" aria-label="What the agent says">
            <h3>What it says</h3>
            {report ? <div className="review-report"><MessageMarkdown text={report} envId={envId} threadId={threadId} /></div>
              : <p className="muted">{detail ? "No written report this turn." : "Loading…"}</p>}
          </section>

          <section className="review-evidence" aria-label="What Command can see">
            <h3>What Command can see</h3>
            <div className="review-block">
              <div className="review-row"><strong>Checks</strong>
                <span className={`review-verdict v-${checks.verdict}`}>
                  {checks.verdict === "none" ? (ref ? (prError ? snapshotChecks(ref.snapshot?.checksState) : pr ? "none reported" : "loading…") : "no PR")
                    : `${checks.passing}/${checks.total} passing${checks.failing ? ` · ${checks.failing} failing` : ""}${checks.pending ? ` · ${checks.pending} pending` : ""}`}
                </span>
              </div>
              {pr && pr.checks.length > 0 && (
                <ul className="review-list">{pr.checks.map((c) => (
                  <li key={c.name} className={`check-${c.status}`}><span className="review-mark">{CHECK_MARK[c.status] ?? "·"}</span>
                    {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.name}</a> : c.name}{c.description ? <span className="muted"> · {c.description}</span> : null}</li>
                ))}</ul>
              )}
            </div>
            <div className="review-block">
              <div className="review-row"><strong>Tests it ran this turn</strong>
                <span className={`review-verdict v-${!tests.length ? "none" : tests.some((t) => t.outcome === "failed") ? "failing" : tests.some((t) => t.outcome === "running") ? "pending" : tests.every((t) => t.outcome === "passed") ? "passing" : "none"}`}>
                  {tests.length ? [`${tests.filter((t) => t.outcome === "passed").length}/${tests.length} passed`,
                    tests.some((t) => t.outcome === "ran") && `${tests.filter((t) => t.outcome === "ran").length} ran, exit code unknown`].filter(Boolean).join(" · ") : "none seen"}
                </span>
              </div>
              {tests.length > 0 && <ul className="review-list">{tests.map((t) => (
                <li key={t.command} className={`test-${t.outcome}`}><span className="review-mark" title={t.outcome === "ran" ? "Finished, but no exit code was reported" : undefined}>{t.outcome === "passed" ? "✓" : t.outcome === "failed" ? "✕" : t.outcome === "ran" ? "·" : "…"}</span><code>{t.command}</code></li>
              ))}</ul>}
            </div>
            {ref && (
              <div className="review-block">
                <div className="review-row"><strong>Pull request</strong>
                  <a href={ref.url} target="_blank" rel="noreferrer">#{ref.number} {(pr?.state ?? ref.snapshot?.state ?? "").toUpperCase()}{pr?.isDraft ? " · DRAFT" : ""} ↗</a></div>
                {pr && <p className="small">
                  {pr.changedFiles} files · <span className="diff-add">+{pr.additions}</span> <span className="diff-del">−{pr.deletions}</span>
                  {pr.mergeability === "conflicting" && <span className="orange"> · conflicts with {pr.baseBranch}</span>}
                  {pr.baseComparison === "behind" && <span className="orange"> · {pr.behindBy ? `${pr.behindBy} commits` : ""} behind {pr.baseBranch}</span>}
                  {pr.reviewers.length > 0 && <span className="muted"> · reviewers {pr.reviewers.map((r) => r.login).join(", ")}</span>}
                </p>}
                {prError && <p className="muted small">The host's per-check detail isn't available for this PR ({prError}); the summary comes from T3's snapshot.</p>}
              </div>
            )}
            <p className="muted small">Agent claims are on the left; this side is only what T3 and the host report.</p>
          </section>
        </div>

        <section className="review-changes" aria-label="Changes">
          <h3>{diffScope === "turn" ? "Changes in the latest turn" : "Changes on the branch"}{diff ? ` · ${diff.files.length} files` : ""}</h3>
          {diffScope === "turn" && <p className="muted small">{branchError ? `T3 couldn't produce the whole branch's diff (${branchError}); this is the latest turn only.` : "Loading the whole branch's diff…"}</p>}
          {!latest && <p className="muted">No checkpoints yet.</p>}
          {latest > 0 && !diff && !diffError && !branchError && <p className="muted">Loading the diff…</p>}
          {latest > 0 && !diff && branchError && (turnFailed
            ? <p className="small" role="alert">Could not load the diff: {branchError}</p>
            : <p className="muted">The whole branch's diff didn't come ({branchError}); loading the latest turn's…</p>)}
          {diffError && <p className="small" role="alert">Could not load the diff: {diffError}</p>}
          {diff && <DiffFiles parsed={diff} open={2} />}
        </section>

        {asking && (
          <div className="review-changes-box">
            <textarea autoFocus rows={4} value={notes} placeholder="What should change? It's sent as an order with your notes." onChange={(e) => setNotes(e.target.value)} />
          </div>
        )}
        <div className="review-actions">
          <button className={`btn${doubtful.length ? "" : " approve"}`} disabled={busy} onClick={() => void accept()} title="Mark the report read; it leaves Needs you. Reading isn't approving: merging stays on the host.">Mark report read</button>
          {asking
            ? <button className="btn primary" disabled={busy || !notes.trim() || env.connection !== "live"} onClick={() => void requestChanges()}>Send changes</button>
            : <button className="btn" disabled={env.connection !== "live"} onClick={() => setAsking(true)}>Request changes…</button>}
          {ref && <a className="btn" href={ref.url} target="_blank" rel="noreferrer">Open PR ↗</a>}
          <span className="spacer" />
          <button className="btn" disabled={busy} onClick={() => void camp()}>Mark read, send to camp</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
