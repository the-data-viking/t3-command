import { useEffect, useMemo, useState } from "react";
import { PixelLabel } from "./PixelArt";
import { sfx } from "../game/sfx";
import { worldRef } from "../game/world";
import { markReportsRead, setSelection, unitKey, useGame } from "../store";
import { changeTotals } from "../t3/changes";
import { envClient, logError } from "../t3/environment";
import { turnBreakdown } from "../t3/progress";
import { elapsed } from "../t3/timing";
import { ARM_MS } from "./event-guard";
import { PullRequestChips } from "./MissionTelemetry";
import { batchSettle } from "./squad";
import { openDebrief, unreadReports } from "./debrief";
import { needsYou } from "./needs-you";
import { advanceQueue, finishQueue, queueLength, skipInQueue, stopQueue } from "./queue-run";
import { useSwipe } from "./useSwipe";
import { approvePlan } from "./plan";
import { openReview } from "./review";
import { isPhone } from "./phone";

/**
 * A finished job, as a card: what the agent reported, what changed, the PRs and their checks, and
 * how long it took, with numbered choices. The release beat after the tension of a long turn.
 */
export function DebriefCard() {
  const at = useGame((s) => s.debrief);
  if (!at) return null;
  return <Debrief key={`${at.envId}:${at.threadId}`} envId={at.envId} threadId={at.threadId} />;
}

function Debrief({ envId, threadId }: { envId: string; threadId: string }) {
  const env = useGame((s) => s.envs[envId]);
  const thread = env?.threads[threadId];
  const detail = useGame((s) => s.details[unitKey(envId, threadId)]);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => envClient(envId)?.watchThread(threadId), [envId, threadId]);
  useEffect(() => { const t = setTimeout(() => setArmed(true), ARM_MS); return () => clearTimeout(t); }, []);

  const turnId = thread?.latestTurn?.turnId;
  const report = useMemo(() => {
    const messages = detail?.thread.messages ?? [];
    const last = [...messages].reverse().find((m) => m.role === "assistant" && m.turnId === turnId && m.text.trim());
    return last?.text.trim();
  }, [detail, turnId]);
  const changes = useMemo(() => {
    const checkpoint = detail?.thread.checkpoints.find((c) => c.turnId === turnId);
    return checkpoint ? { files: checkpoint.files.length, ...changeTotals(checkpoint.files) } : undefined;
  }, [detail, turnId]);
  const time = detail ? turnBreakdown(detail.thread, Date.now()) : undefined;

  const close = () => { stopQueue(); openDebrief(null); };
  const running = useGame((s) => !!s.queueRun);
  const skip = () => skipInQueue({ envId, threadId });
  // In a run on a phone: swipe left to leave the report for later, right to mark it read.
  const swipe = useSwipe(running && isPhone(), skip, () => { if (turnId) markReportsRead([{ envId, threadId, turnId }]); sfx.select(); next(); });
  const member = { envId, threadId, turnId: turnId ?? "" };
  const next = () => {
    if (useGame.getState().queueRun) { if (!advanceQueue(`${envId}:${threadId}`)) finishQueue(); return; }
    const after = unreadReports().filter((r) => !(r.envId === envId && r.threadId === threadId));
    openDebrief(after[0] ?? null);
  };
  const openLog = () => {
    const sel = { kind: "unit" as const, envId, threadId };
    setSelection(sel);
    worldRef.current?.focus(sel);
    close();
  };
  // A plan-mode crew member's finished turn is a plan to approve, not work to accept: building
  // it is the next step, and sending it to camp would shelve the plan unbuilt.
  const plan = thread?.interactionMode === "plan";
  // A failed turn is a triage card: ask the crew member to fix it, look, dismiss, or stand it down.
  const failed = thread?.latestTurn?.state === "error" || thread?.session?.status === "error";
  const error = thread?.session?.lastError?.trim();
  const fixOrder = `Your last turn failed${error ? `: ${error.split("\n")[0].slice(0, 300)}` : ""}. Find the cause, fix it, and tell me what you changed and how you verified it.`;
  const choices: Array<{ label: string; run: () => void | Promise<void>; tone?: "good" }> = failed ? [
    { label: "Ask it to find and fix the cause.", tone: "good", run: async () => {
      try { await envClient(envId)?.order(threadId, fixOrder); sfx.order(); if (turnId) markReportsRead([member]); next(); }
      catch (err) { sfx.error(); logError("Couldn't send the fix order", err); }
    } },
    { label: "Open the crew log.", run: openLog },
    { label: "Dismiss: I've seen it.", run: () => { if (turnId) markReportsRead([member]); sfx.select(); next(); } },
    { label: "Send to camp.", run: async () => { if (turnId) markReportsRead([member]); await batchSettle(true, [{ envId, threadId }]); next(); } },
  ] : plan ? [
    { label: "Approve the plan and build it.", tone: "good", run: async () => {
      try { await approvePlan(envId, threadId); sfx.order(); if (turnId) markReportsRead([member]); next(); }
      catch (err) { sfx.error(); logError("Couldn't start building", err); }
    } },
    { label: "Open the crew log to revise the plan.", run: openLog },
    { label: "Mark read (decide later in its panel).", run: () => { if (turnId) markReportsRead([member]); sfx.select(); next(); } },
  ] : [
    { label: "Review the changes and checks.", run: () => { stopQueue(); openReview({ envId, threadId }); } },
    { label: "Open the crew log.", run: openLog },
    { label: "Give follow-up orders.", run: openLog },
    { label: "Mark read.", run: () => { if (turnId) markReportsRead([member]); sfx.select(); next(); } },
    { label: "Accept and send to camp.", tone: "good", run: async () => { if (turnId) markReportsRead([member]); await batchSettle(true, [{ envId, threadId }]); next(); } },
  ];
  const choose = async (i: number) => {
    if (!armed || busy) return;
    setBusy(true);
    try { await choices[i].run(); } finally { setBusy(false); }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
      if (running && (e.key === "s" || e.key === "S")) { e.preventDefault(); e.stopImmediatePropagation(); skip(); return; }
      const n = Number(e.key);
      if (!armed || !Number.isInteger(n) || n < 1 || n > choices.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void choose(n - 1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!env || !thread) return null;
  const project = env.projects[thread.projectId];
  // The same list as the top bar's Needs you: requests, plans, failures and reports.
  const remaining = needsYou(useGame.getState()).filter((r) => !(r.envId === envId && r.threadId === threadId)).length;
  return (
    <div className="event-backdrop" onClick={close}>
      <div className="event debrief ftl-frame" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Report" {...swipe.handlers} style={swipe.style}>
        {swipe.armed === -1 && <div className="swipe-hint left">Later</div>}
        {swipe.armed === 1 && <div className="swipe-hint right">Mark read</div>}
        <div className="ftl-tab"><PixelLabel text={failed ? "Failed" : plan ? "Plan" : "Report"} /></div>
        <div className="event-meta">{env.summary.label} · {project?.title ?? "?"}</div>
        <div className="event-body">
          <p className="event-text"><strong>{thread.title || "A crew member"}</strong> {failed ? "failed its last turn." : plan ? "has a plan for you to approve." : "finished."}</p>
          {failed && <pre className="event-detail failure-detail">{error ?? "No error message was reported."}</pre>}
          {failed && report && <p className="muted small">Its last words before failing:</p>}
          {failed && !report ? null : report
            ? <div className="debrief-report">{report.length > 900 ? `${report.slice(0, 899)}…` : report}</div>
            : <p className="muted">{detail ? "No written report this turn." : "Loading the report…"}</p>}
          <div className="debrief-facts">
            {changes && <span>{changes.files} file{changes.files === 1 ? "" : "s"} · <span className="st-done">+{changes.additions}</span> <span className="st-error">−{changes.deletions}</span>{changes.generated ? ` · ${changes.generated} generated` : ""}</span>}
            {time && <span>Agent {elapsed(time.agentMs)}{time.waitingMs > 0 ? ` · waited on you ${elapsed(time.waitingMs)}` : ""}</span>}
          </div>
          <PullRequestChips thread={thread} />
          <ol className={`event-choices ${armed ? "" : "arming"}`}>
            {choices.map((c, i) => (
              <li key={i}>
                <button className={`event-choice ${c.tone ?? ""}`} disabled={!armed || busy} onClick={() => void choose(i)}>
                  <span className="choice-num">{i + 1}.</span> {c.label}
                </button>
              </li>
            ))}
          </ol>
        </div>
        <div className="event-foot muted">Press a number to choose{running
          ? ` · ${queueLength() > 1 ? `${queueLength() - 1} more in the queue` : "last one"} · ${isPhone() ? "tap outside to stop" : "Esc stops"}`
          : `${remaining > 0 ? ` · ${remaining} more need${remaining === 1 ? "s" : ""} you` : ""} · Esc to close`}
          {running && <button className="link-button queue-skip" onClick={skip}>{isPhone() ? "Later (or swipe left; right marks read)" : "Later (S)"}</button>}</div>
      </div>
    </div>
  );
}
