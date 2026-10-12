import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sfx } from "../game/sfx";
import { setSelection, unitKey, useGame } from "../store";
import { isHistory, pendingRequests, unitState } from "../t3/derive";
import { telemetry } from "../t3/telemetry";
import { modelTier, TIER_LABEL } from "../game/theme";
import { envClient, logError } from "../t3/environment";
import type { ApprovalDecision, Message, PendingRequest } from "../t3/types";
import { modelName, providerName, STATE_LABELS, timeAgo } from "./util";
import { ThreadImage } from "./ThreadImage";

import { MessageMarkdown } from "./MessageMarkdown";
import { QuestionForm } from "./QuestionForm";
import { PanelResize } from "./PanelResize";
import { usePanelWidth } from "./usePanelWidth";
import { ThreadTiming } from "./ThreadTiming";

import { ActivityView, ToolActivityGroup } from "./TranscriptActivity";
import { transcriptEntries } from "./transcript";

export function UnitPanel({ envId, threadId }: { envId: string; threadId: string }) {
  const panelWidth = usePanelWidth();
  const env = useGame((s) => s.envs[envId]);
  const thread = env?.threads[threadId];
  const detail = useGame((s) => s.details[unitKey(envId, threadId)]);

  // Follow this thread's messages while the panel is open.
  useEffect(() => envClient(envId)?.watchThread(threadId), [envId, threadId]);

  const entries = useMemo(() => detail ? transcriptEntries(detail.thread) : [], [detail]);

  const pending = useMemo(() => (detail ? pendingRequests(detail.thread) : []), [detail]);

  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const onImageLoad = useCallback(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [entries, pending]);

  if (!env || !thread) {
    return (
      <aside className="panel">
        <p className="muted">This unit is gone.</p>
      </aside>
    );
  }

  const state = unitState(thread);
  const canHalt = state === "working" || (env.summary.kind === "hermes" && thread.latestTurn?.state === "running");
  const archived = isHistory(thread);
  const info = detail ? telemetry(detail.thread) : undefined;
  const project = env.projects[thread.projectId];
  const client = envClient(envId);
  const unitName = thread.title || "Untitled";

  const run = (what: string, fn: () => Promise<unknown> | undefined) => {
    fn()?.catch((err: unknown) => logError(what, err));
  };

  return (
    <aside className="panel unit-panel" style={{ width: panelWidth.width }}>
      <PanelResize {...panelWidth} />
      <header className="panel-head">
        <div className={`portrait provider-${thread.modelSelection.instanceId}`} />
        <div className="panel-title">
          <h2 title={unitName}>{unitName}</h2>
          {thread.hermesProfile && <div className="muted small">Hermes bot: {thread.hermesProfile}{thread.hermesBotChat ? " · Bot Chat" : " · Task session"}</div>}
          <div className="muted small">
            {TIER_LABEL[modelTier(thread.modelSelection.model)]} · {providerName(env, thread.modelSelection.instanceId)} · {modelName(env, thread)}
          </div>
          <div className="muted small">
            {project?.title ?? "?"} @ {env.summary.label}
            {thread.branch ? ` · ⎇ ${thread.branch}` : ""}
          </div>
        </div>
        <button className="icon-btn" onClick={() => setSelection(null)} title="Close (Esc)">
          ✕
        </button>
      </header>

      {archived ? (
        <div className="status-row">
          <span className="pill state-sleeping">Archived import</span>
          <span className="spacer" />
          <button className="btn" onClick={() => setSelection({ kind: "library", envId, projectId: thread.projectId })}>
            ← Archive
          </button>
        </div>
      ) : (
      <div className="status-row">
        <span className={`pill state-${state}`}>{STATE_LABELS[state]}</span>
        <span className="muted small">{thread.runtimeMode}</span>
        <ThreadTiming thread={thread} detail={detail?.thread} />
        <span className="spacer" />
        {canHalt && (
          <button className="btn danger" onClick={() => run("Interrupt", () => client?.interrupt(threadId))}>
            ■ Halt
          </button>
        )}
        {state === "sleeping" ? (
          <button className="btn" onClick={() => run("Wake", () => client?.unsettle(threadId))}>
            Wake
          </button>
        ) : (
          !canHalt && (
            <button className="btn" onClick={() => run("Send to camp", () => client?.settle(threadId))} title="Mark the thread settled">
              ⛺ To camp
            </button>
          )
        )}
      </div>
      )}

      {info && !archived && (info.context !== undefined || info.tasks > 0 || (state === "working" && info.doing)) && (
        <div className="telemetry">
          {state === "working" && (
            <div className="tele-row">
              <span className="tele-key">AT</span>
              <span className="tele-val">
                {info.workstation === "console" ? "console · thinking" : info.workstation}
                {info.doing && info.workstation !== "console" ? ` · ${info.doing.split("\n")[0].slice(0, 80)}` : ""}
              </span>
            </div>
          )}
          {info.context !== undefined && (
            <div className="tele-row">
              <span className="tele-key">CONTEXT</span>
              <span className="hp">
                <span
                  className="hp-fill"
                  style={{ width: `${Math.round((1 - info.context) * 100)}%`, background: info.context < 0.6 ? "var(--done)" : info.context < 0.85 ? "var(--question)" : "var(--alert)" }}
                />
              </span>
              <span className="tele-val">{Math.round((1 - info.context) * 100)}% left</span>
            </div>
          )}
          {info.tasks > 0 && (
            <div className="tele-row">
              <span className="tele-key">DRONES</span>
              <span className="tele-val">{info.tasks} background task{info.tasks === 1 ? "" : "s"} running</span>
            </div>
          )}
        </div>
      )}

      <div
        className="transcript"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!detail && <p className="muted">Loading reports…</p>}
        {detail && entries.length === 0 && <p className="muted">No reports yet.</p>}
        {entries.map((e) =>
          e.kind === "message" ? (
            <MessageView key={e.message.id} message={e.message} unitName={unitName} envId={envId} threadId={threadId}
              onImageLoad={onImageLoad} />
          ) : e.kind === "tools" ? (
            <ToolActivityGroup key={e.activities[0].id} activities={e.activities} />
          ) : (
            <ActivityView key={e.activity.id} activity={e.activity} />
          ),
        )}
        {pending.map((p) => (
          <PendingCard key={p.requestId} request={p} envId={envId} threadId={threadId} />
        ))}
      </div>

      {!archived && <OrderBox envId={envId} threadId={threadId} disabled={env.connection !== "live"} working={state === "working"} />}
    </aside>
  );
}

function MessageView({ message, unitName, envId, threadId, onImageLoad }: { message: Message; unitName: string; envId: string; threadId: string; onImageLoad: () => void }) {
  const content = <>
    <MessageMarkdown text={message.text} envId={envId} threadId={threadId} onImageLoad={onImageLoad} />
    {message.attachments?.filter((a) => a.type === "image" || (a.type === "file" && /^image\//i.test(a.mimeType))).map((a) => (
      <ThreadImage key={a.id} envId={envId} resource={{ _tag: "attachment", attachmentId: a.id,
        fileName: a.name, mimeType: a.mimeType, disposition: "inline" }} alt={a.name} onLoad={onImageLoad} />
    ))}
  </>;
  if (message.role === "reasoning") {
    return (
      <details className="msg reasoning">
        <summary>thinking…</summary>
        <div className="msg-text markdown">{content}</div>
      </details>
    );
  }
  const who = message.role === "user" ? "Commander" : message.role === "assistant" ? unitName : "System";
  return (
    <div className={`msg ${message.role}`}>
      <div className="msg-who">
        {who} <span className="muted">{timeAgo(message.createdAt)}</span>
      </div>
      <div className="msg-text markdown">
        {content}
        {message.streaming && <span className="cursor">▍</span>}
      </div>
    </div>
  );
}

const DEFAULT_APPROVAL_OPTIONS: Array<{ decision: ApprovalDecision; label: string; warning?: string }> = [
  { decision: "accept", label: "Approve" },
  { decision: "acceptForSession", label: "Approve for session" },
  { decision: "decline", label: "Deny" },
];

function PendingCard({ request, envId, threadId }: { request: PendingRequest; envId: string; threadId: string }) {
  const [busy, setBusy] = useState(false);
  const p = request.activity.payload ?? {};
  const client = envClient(envId);

  if (request.kind === "user-input") {
    return (
      <div className="pending question">
        <div className="pending-title">? The unit has a question</div>
        <QuestionForm key={request.requestId} request={request} envId={envId} threadId={threadId} />
      </div>
    );
  }

  const options = (p.options as Array<{ decision: ApprovalDecision; label: string; warning?: string }> | undefined) ?? DEFAULT_APPROVAL_OPTIONS;
  const detail = typeof p.detail === "string" ? p.detail : undefined;
  return (
    <div className="pending approval">
      <div className="pending-title">! Requesting permission: {String(p.requestKind ?? p.requestType ?? "action")}</div>
      <div className="pending-summary">{request.activity.summary}</div>
      {detail && <pre className="pending-detail">{detail}</pre>}
      <div className="pending-actions">
        {options.map((o) => (
          <button
            key={o.decision}
            className={`btn ${o.decision === "decline" || o.decision === "cancel" ? "danger" : "primary"}`}
            disabled={busy}
            title={o.warning}
            onClick={() => {
              setBusy(true);
              (o.decision === "decline" || o.decision === "cancel" ? sfx.deny : sfx.order)();
              client?.respondToApproval(threadId, request.requestId, o.decision).catch((err: unknown) => (setBusy(false), logError("Approval", err)));
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function OrderBox({ envId, threadId, disabled, working }: { envId: string; threadId: string; disabled: boolean; working: boolean }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setText("");
    input.current?.focus();
  }, [envId, threadId]);

  const send = async () => {
    const order = text.trim();
    if (!order || sending) return;
    setSending(true);
    try {
      await envClient(envId)?.order(threadId, order);
      sfx.order();
      setText("");
    } catch (err) {
      sfx.error();
      logError("Order failed", err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="order-box">
      <textarea
        ref={input}
        value={text}
        placeholder={working ? "Unit is busy — new orders will start a new turn when sent…" : "Give orders… (Enter to send, Shift+Enter for newline)"}
        disabled={disabled || sending}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <button className="btn primary" disabled={disabled || sending || !text.trim()} onClick={() => void send()}>
        {sending ? "…" : "Send ▶"}
      </button>
    </div>
  );
}
