import { useEffect, useState } from "react";
import { sfx } from "../game/sfx";
import { worldRef } from "../game/world";
import { openEvent, setSelection, unitKey, useGame } from "../store";
import { pendingRequests } from "../t3/derive";
import { envClient, logError } from "../t3/environment";
import { QuestionForm } from "./QuestionForm";
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

  // Nothing (left) to decide: close.
  useEffect(() => {
    if (detail?.synced && !request) openEvent(null);
  }, [detail?.synced, request]);

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
        <div className="ftl-tab">{request?.kind === "user-input" ? "INCOMING QUESTION" : "INCOMING REQUEST"}</div>
        <div className="event-meta">
          {env.summary.label} · {project?.title ?? "?"}
          {pending.length > 1 && ` · 1 of ${pending.length}`}
        </div>
        <div className="event-body">
          {!request ? (
            <p className="event-text muted">Receiving transmission…</p>
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
              <QuestionForm key={request.requestId} request={request} envId={envId} threadId={threadId} />
            </>
          )}
          {request?.kind === "user-input" ? (
            <button className="btn" onClick={openLog}>Open the crew log</button>
          ) : <ol className="event-choices">
            {choices.map((c, i) => (
              <li key={i}>
                <button className={`event-choice ${c.tone ?? ""}`} disabled={busy || (!request && i < choices.length - 1)} onClick={() => void choose(c)}>
                  <span className="choice-num">{i + 1}.</span> {c.label}
                </button>
              </li>
            ))}
          </ol>}
        </div>
        <div className="event-foot muted">{request?.kind === "user-input" ? "Select or type your answers · Esc to decide later" : "Press a number to choose · Esc to decide later"}</div>
      </div>
    </div>
  );
}
