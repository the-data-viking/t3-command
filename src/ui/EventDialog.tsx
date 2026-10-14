import { useEffect, useMemo, useRef, useState } from "react";
import { PixelLabel } from "./PixelArt";
import { sfx } from "../game/sfx";
import { worldRef } from "../game/world";
import { openEvent, setSelection, unitKey, useGame } from "../store";
import { pendingRequests } from "../t3/derive";
import { envClient, logError } from "../t3/environment";
import { QuestionForm } from "./QuestionForm";
import { ARM_MS } from "./event-guard";
import { waitQueue } from "./queue";
import { advanceQueue, finishQueue, queueLength, skipInQueue, stopQueue } from "./queue-run";
import { useSwipe } from "./useSwipe";
import { isPhone } from "./phone";
import { RiskBanner } from "./RiskBanner";
import { requestContext, type RequestContext } from "./request-context";
import { allowedDecisions, assessRisk, RISK_ARM_MS } from "./risk";
import type { ApprovalDecision, PendingRequest } from "../t3/types";

const DEFAULT_OPTIONS: Array<{ decision: ApprovalDecision; label: string }> = [
  { decision: "accept", label: "Approve" },
  { decision: "acceptForSession", label: "Approve for the rest of this session" },
  { decision: "decline", label: "Deny" },
];

const VERB: Record<string, string> = {
  command: "run a command",
  "file-change": "change files",
  "file-read": "read files",
  "mcp-elicitation": "use an external tool",
  permission: "proceed",
};

interface Choice {
  label: string;
  tone?: "good" | "bad";
  run: () => Promise<unknown> | void;
}

/** FTL-style event box for approvals and questions. Keys 1–9 choose approval actions. */
export function EventDialog() {
  const event = useGame((s) => s.event);
  if (!event) return null;
  return <EventBox key={`${event.envId}:${event.threadId}`} envId={event.envId} threadId={event.threadId} />;
}

function EventBox({ envId, threadId }: { envId: string; threadId: string }) {
  const env = useGame((s) => s.envs[envId]);
  const thread = env?.threads[threadId];
  const detail = useGame((s) => s.details[unitKey(envId, threadId)]);
  const [busy, setBusy] = useState(false);

  useEffect(() => envClient(envId)?.watchThread(threadId), [envId, threadId]);

  const pending = detail ? pendingRequests(detail.thread) : [];
  const request: PendingRequest | undefined = pending[0];
  const risk = assessRisk(request);
  const dangerous = risk?.level === "danger";

  // Each request's choices arm only after it has been on screen for a moment, so a key or click
  // meant for something else (a control group, the map) can't land on "Approve". A dangerous one
  // waits longer, long enough to read what it does.
  const requestId = request?.requestId;
  const [armedFor, setArmedFor] = useState<string>();
  useEffect(() => {
    if (!requestId) return;
    const timer = setTimeout(() => setArmedFor(requestId), dangerous ? RISK_ARM_MS : ARM_MS);
    return () => clearTimeout(timer);
  }, [requestId, dangerous]);
  const armed = !!requestId && armedFor === requestId;

  // Others waiting on you, longest first: after a decision here, the card moves on to the next.
  const envs = useGame((s) => s.envs);
  const details = useGame((s) => s.details);
  const queue = useMemo(() => waitQueue(envs, details).filter((q) => !(q.envId === envId && q.threadId === threadId)), [envs, details, envId, threadId]);
  const next = queue[0];
  const decided = useRef(false);

  // Nothing (left) to decide here: move on to the next crew member waiting on you if you just
  // decided something (a short beat, so the change reads), otherwise close.
  // Keyed by who is next (not the array), so streaming updates don't keep restarting the beat.
  const synced = detail?.synced;
  const nextKey = next ? `${next.envId}:${next.threadId}` : "";
  useEffect(() => {
    if (!synced || request) return;
    // Working the queue: go on to whatever is next, reports included, or end the run.
    if (useGame.getState().queueRun) {
      const timer = setTimeout(() => { if (!advanceQueue(`${envId}:${threadId}`)) finishQueue(); }, decided.current ? 180 : 0);
      return () => clearTimeout(timer);
    }
    if (!decided.current || !nextKey) { openEvent(null); return; }
    const [nextEnv, ...rest] = nextKey.split(":");
    const timer = setTimeout(() => openEvent({ envId: nextEnv, threadId: rest.join(":") }), 180);
    return () => clearTimeout(timer);
  }, [synced, request, nextKey, envId, threadId]);

  const close = () => { stopQueue(); openEvent(null); };
  const running = useGame((s) => !!s.queueRun);
  const left = running ? queueLength() - 1 : 0;
  // In a run on a phone, swiping the card left leaves it for later. Never approves.
  const skip = () => skipInQueue({ envId, threadId });
  const swipe = useSwipe(running && isPhone(), skip);
  const openLog = () => {
    const sel = { kind: "unit" as const, envId, threadId };
    setSelection(sel);
    worldRef.current?.focus(sel);
    close();
  };

  const choices: Choice[] = [];
  if (request?.kind === "approval") {
    const p = request.activity.payload ?? {};
    const offered = allowedDecisions((p.options as Array<{ decision: ApprovalDecision; label: string }> | undefined) ?? DEFAULT_OPTIONS, risk);
    // Dangerous: Deny comes first, so a reflexive 1 refuses rather than approves.
    const isDeny = (o: { decision: ApprovalDecision }) => o.decision === "decline" || o.decision === "cancel";
    const options = dangerous ? [...offered.filter(isDeny), ...offered.filter((o) => !isDeny(o))] : offered;
    for (const o of options) {
      const deny = isDeny(o);
      choices.push({
        label: `${o.label}.`,
        tone: deny ? "bad" : "good",
        run: async () => {
          // The sound confirms the response landed (a failure plays the error instead).
          await envClient(envId)?.respondToApproval(threadId, request.requestId, o.decision);
          (deny ? sfx.deny : sfx.order)();
        },
      });
    }
  }
  choices.push({ label: "Open the crew log.", run: openLog });

  const choose = async (choice: Choice) => {
    if (busy) return;
    setBusy(true);
    try {
      await choice.run();
      if (choice !== choices[choices.length - 1]) decided.current = true;
    } catch (err) {
      sfx.error();
      logError("Response failed", err);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (request?.kind === "user-input" || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      if (running && (e.key === "s" || e.key === "S")) { e.preventDefault(); e.stopImmediatePropagation(); skip(); return; }
      const n = Number(e.key);
      // Not armed yet: the keypress wasn't meant for this card, so leave it to its own handler.
      if (!armed) return;
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void choose(choices[n - 1]);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!env || !thread) return null;
  const project = env.projects[thread.projectId];
  const p = request?.activity.payload ?? {};
  const detailText = typeof p.detail === "string" ? p.detail : undefined;

  return (
    <div className="event-backdrop" onClick={close}>
      <div className="event ftl-frame" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Crew request" {...swipe.handlers} style={swipe.style}>
        {swipe.armed !== 0 && <div className="swipe-hint left">Later</div>}
        <div className="ftl-tab"><PixelLabel text={request?.kind === "user-input" ? "Incoming question" : "Incoming request"} /></div>
        <div className="event-meta">
          {env.summary.label} · {project?.title ?? "?"}
          {pending.length > 1 && ` · 1 of ${pending.length}`}
        </div>
        <div className="event-body">
          {!request ? (
            <p className="event-text muted">Loading the request…</p>
          ) : request.kind === "approval" ? (
            <>
              <p className="event-text">
                <strong>{thread.title || "A crew member"}</strong> requests permission to {VERB[String(p.requestKind)] ?? "proceed"}.
              </p>
              {risk && <RiskBanner risk={risk} />}
              {detailText && <pre className={`event-detail ${risk ? `risk-${risk.level}` : ""}`}>{detailText}</pre>}
              <RequestContextView context={requestContext(env, thread, detail?.thread, request)} />
            </>
          ) : (
            <>
              <p className="event-text">
                <strong>{thread.title || "A crew member"}</strong> needs an answer before continuing:
              </p>
              <QuestionForm key={request.requestId} request={request} envId={envId} threadId={threadId} onAnswered={() => { decided.current = true; }} />
            </>
          )}
        </div>
        {/* The choices sit outside the scrolling context, so every one is always in view (on a
            phone, Deny is never below the fold while Approve is showing). */}
        <div className="event-actions">
          {request?.kind === "user-input" ? (
            <button className="btn" onClick={openLog}>Open the crew log</button>
          ) : <ol className={`event-choices ${armed ? "" : "arming"}`}>
            {choices.map((c, i) => (
              <li key={i}>
                <button className={`event-choice ${c.tone ?? ""}`} disabled={busy || (i < choices.length - 1 && !armed)} onClick={() => void choose(c)}>
                  <span className="choice-num">{i + 1}.</span> {c.label}
                </button>
              </li>
            ))}
          </ol>}
        </div>
        <div className="event-foot muted">
          {request?.kind === "user-input" ? "Select or type your answers" : isPhone() ? "Tap a choice" : "Press a number to choose"}
          {running ? ` · ${left > 0 ? `${left} more in the queue` : "last one"} · ${isPhone() ? "tap outside to stop" : "Esc stops"}`
            : queue.length > 0 ? ` · ${queue.length} more waiting, next after this${isPhone() ? "" : " · Esc stops"}` : isPhone() ? "" : " · Esc to decide later"}
          {running && <button className="link-button queue-skip" onClick={skip}>{isPhone() ? "Later (or swipe left)" : "Later (S)"}</button>}
        </div>
      </div>
    </div>
  );
}

/** Why the agent is asking, from its own turn: the order, its last words, where, and what it just did. */
function RequestContextView({ context }: { context: RequestContext }) {
  const { order, intent, where, recent } = context;
  if (!order && !intent && !recent.length && !where.length) return null;
  return (
    <dl className="request-context">
      {intent && <><dt>It said</dt><dd className="request-intent">“{intent}”</dd></>}
      {order && <><dt>Your order</dt><dd>{order}</dd></>}
      {recent.length > 0 && <><dt>This turn</dt><dd><ol>{recent.map((r, i) => <li key={i}><code>{r}</code></li>)}</ol></dd></>}
      {where.length > 0 && <><dt>Where</dt><dd className="muted">{where.join(" · ")}</dd></>}
    </dl>
  );
}
