import { useEffect, useMemo, useState } from "react";
import { PixelLabel } from "./PixelArt";
import { sfx } from "../game/sfx";
import { worldRef } from "../game/world";
import { markReportsRead, markStuckOk, setSelection, unitKey, useGame } from "../store";
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
import { answerFailure, fixOrder } from "./failed";
import { isPhone } from "./phone";
import { pulseOf, pulseText } from "./pulse";
import { blockedOrder, spinSign } from "./stuck";

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
  const startedAt = thread?.latestTurn?.requestedAt;
  const report = useMemo(() => {
    const written = [...(detail?.thread.messages ?? [])].reverse().filter((m) => m.role === "assistant" && m.text.trim());
    // Hermes messages carry no turn id: its report is the last thing it wrote since the turn began.
    const since = startedAt ? Date.parse(startedAt) : NaN;
    const last = written.find((m) => m.turnId === turnId)
      ?? written.find((m) => !m.turnId && (!Number.isFinite(since) || Date.parse(m.createdAt) >= since));
    return last?.text.trim();
  }, [detail, turnId, startedAt]);
  const changes = useMemo(() => {
    const checkpoint = detail?.thread.checkpoints.find((c) => c.turnId === turnId);
    return checkpoint ? { files: checkpoint.files.length, ...changeTotals(checkpoint.files) } : undefined;
  }, [detail, turnId]);
  const time = detail ? turnBreakdown(detail.thread, Date.now()) : undefined;

  const close = () => { stopQueue(); openDebrief(null); };
  const running = useGame((s) => !!s.queueRun);
  const skip = () => skipInQueue({ envId, threadId });
  // In a run on a phone: swipe left to leave the report for later, right to mark it read.
  // (A turn that may be stuck: right says it's fine.)
  const swipe = useSwipe(running && isPhone(), skip, () => {
    if (stuck) markStuckOk(envId, threadId, stuck.sign);
    else if (turnId) markReportsRead([{ envId, threadId, turnId }]);
    sfx.select();
    next();
  });
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
  // A Hermes operator's report is a conversation, not code: read it, or open the chat to reply.
  const hermes = env?.summary.kind === "hermes";
  // A turn still running with a spin sign: halt it, ask what's in the way, look, or let it run.
  const stuck = !failed && thread ? spinSign(thread, detail?.thread, Date.now()) : undefined;
  const client = envClient(envId);
  const halt = async () => {
    await client?.interrupt(threadId);
    sfx.order();
  };
  const choices: Array<{ label: string; run: () => void | Promise<void>; tone?: "good" }> = stuck ? [
    { label: "Halt it.", run: async () => { try { await halt(); next(); } catch (err) { sfx.error(); logError("Couldn't halt", err); } } },
    { label: "Halt it and ask what's blocking.", tone: "good", run: async () => {
      try {
        await halt();
        // The order goes once the turn has actually stopped (up to 15 s), so it starts a new turn.
        for (let i = 0; i < 60 && useGame.getState().envs[envId]?.threads[threadId]?.latestTurn?.state === "running"; i++) await new Promise((r) => setTimeout(r, 250));
        await client?.order(threadId, blockedOrder(stuck.why));
        next();
      } catch (err) { sfx.error(); logError("Couldn't halt and ask", err); }
    } },
    { label: "Open the crew log.", run: openLog },
    { label: "It's fine: let it run (until a new sign).", run: () => { markStuckOk(envId, threadId, stuck.sign); sfx.select(); next(); } },
  ] : hermes ? [
    { label: "Mark read.", tone: "good", run: () => { if (turnId) markReportsRead([member]); sfx.select(); next(); } },
    { label: "Open the conversation to reply.", run: openLog },
  ] : failed ? [
    { label: "Ask it to find and fix the cause.", tone: "good", run: async () => { if (thread && await answerFailure(envId, thread, fixOrder(thread), "fix order")) next(); } },
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
    // In a queue run, the run waits: closing the review comes back here, or moves on once it's read.
    { label: "Review the changes and checks.", run: () => openReview({ envId, threadId }) },
    { label: "Open the crew log.", run: openLog },
    { label: "Give follow-up orders.", run: openLog },
    { label: "Mark read.", run: () => { if (turnId) markReportsRead([member]); sfx.select(); next(); } },
    { label: "Mark read and send to camp.", tone: "good", run: async () => { if (turnId) markReportsRead([member]); await batchSettle(true, [{ envId, threadId }]); next(); } },
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
        {swipe.armed === 1 && <div className="swipe-hint right">{stuck ? "It's fine" : "Mark read"}</div>}
        <div className="ftl-tab"><PixelLabel text={stuck ? "Stuck?" : failed ? "Failed" : plan ? "Plan" : "Report"} /></div>
        <div className="event-meta">{env.summary.label} · {project?.title ?? "?"}</div>
        <div className="event-body">
          <p className="event-text"><strong>{thread.title || "A crew member"}</strong> {stuck ? `may be stuck: ${stuck.why}.` : failed ? "failed its last turn." : plan ? "has a plan for you to approve." : "finished."}</p>
          {stuck && detail && <p className="muted small">{pulseText(pulseOf(detail.thread, Date.now())!, Date.now())} · a prompt to look, not a ruling.</p>}
          {failed && <pre className="event-detail failure-detail">{error ?? "No error message was reported."}</pre>}
          {failed && report && <p className="muted small">Its last words before failing:</p>}
          {stuck ? null : failed && !report ? null : report
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
