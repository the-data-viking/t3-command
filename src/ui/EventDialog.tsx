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

  // Each request's choices arm only after it has been on screen for a moment, so a key or click
  // meant for something else (a control group, the map) can't land on "Approve".
  const requestId = request?.requestId;
  const [armedFor, setArmedFor] = useState<string>();
  useEffect(() => {
    if (!requestId) return;
    const timer = setTimeout(() => setArmedFor(requestId), ARM_MS);
    return () => clearTimeout(timer);
  }, [requestId]);
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
    if (!decided.current || !nextKey) { openEvent(null); return; }
    const [nextEnv, ...rest] = nextKey.split(":");
    const timer = setTimeout(() => openEvent({ envId: nextEnv, threadId: rest.join(":") }), 180);
    return () => clearTimeout(timer);
  }, [synced, request, nextKey]);

  const close = () => openEvent(null);
  const openLog = () => {
    const sel = { kind: "unit" as const, envId, threadId };
    setSelection(sel);
    worldRef.current?.focus(sel);
    close();
  };

  const choices: Choice[] = [];
  if (request?.kind === "approval") {
    const p = request.activity.payload ?? {};
    const options = (p.options as Array<{ decision: ApprovalDecision; label: string }> | undefined) ?? DEFAULT_OPTIONS;
    for (const o of options) {
      const deny = o.decision === "decline" || o.decision === "cancel";
      choices.push({
        label: `${o.label}.`,
        tone: deny ? "bad" : "good",
        run: async () => {
          (deny ? sfx.deny : sfx.order)();
          await envClient(envId)?.respondToApproval(threadId, request.requestId, o.decision);
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
      const n = Number(e.key);
      // Not armed yet: the keypress wasn't meant for this card, so leave it to its own handler.
      if (!armed) return;
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
        e.preventDefault();
        e.stopPropagation();
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
      <div className="event ftl-frame" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Crew request">
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
              {detailText && <pre className="event-detail">{detailText}</pre>}
            </>
          ) : (
            <>
              <p className="event-text">
                <strong>{thread.title || "A crew member"}</strong> needs an answer before continuing:
              </p>
              <QuestionForm key={request.requestId} request={request} envId={envId} threadId={threadId} onAnswered={() => { decided.current = true; }} />
            </>
          )}
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
          {request?.kind === "user-input" ? "Select or type your answers" : "Press a number to choose"}
          {queue.length > 0 ? ` · ${queue.length} more waiting, next after this · Esc stops` : " · Esc to decide later"}
        </div>
      </div>
    </div>
  );
}
