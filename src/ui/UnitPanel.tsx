import { useDraft } from "./drafts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cancelFollowUp, followUpFor, followUpLabel, queueFollowUp } from "../t3/followups";
import { standingNote } from "../../shared/followups";
import { expandPlaybook } from "../../shared/playbooks";
import { RiskBanner } from "./RiskBanner";
import { PlanReady, PostureControl } from "./PostureControl";
import { openReview } from "./review";
import { allowedDecisions, assessRisk } from "./risk";
import { sfx } from "../game/sfx";
import { markReportsRead, setSelection, unitKey, useGame } from "../store";
import { FailedActions } from "./FailedActions";
import { isHistory, pendingRequests, turnBusy, unitState } from "../t3/derive";
import { telemetry } from "../t3/telemetry";
import { contextLevel, modelTier, TIER_LABEL } from "../game/theme";
import { envClient, logError } from "../t3/environment";
import type { ApprovalDecision, Message, PendingRequest } from "../t3/types";
import { modelName, providerName, reportRead, stateLabel, timeAgo } from "./util";
import { ThreadImage } from "./ThreadImage";

import { MessageMarkdown } from "./MessageMarkdown";
import { QuestionForm } from "./QuestionForm";
import { PanelResize } from "./PanelResize";
import { usePanelWidth } from "./usePanelWidth";
import { ThreadTiming } from "./ThreadTiming";
import { FailureNote, PullRequestChips, TurnChanges } from "./MissionTelemetry";
import { botOperators, BOT_STATE_LABELS } from '../t3/bots';
import { BotPortrait } from './HermesControlCenter';
import { worldRef } from '../game/world';

import { ActivityView, ToolActivityGroup } from "./TranscriptActivity";
import { transcriptEntries } from "./transcript";
import { CrewPortrait, PixelIcon, PixelLabel } from "./PixelArt";
import { stationColor } from "../game/layout";
import { HermesPermissions } from './HermesPermissions';
import { isPhone, usePhone } from './phone';
import { TurnTelemetry } from './TurnTelemetry';
import { contextWarning } from '../t3/progress';

export function UnitPanel({ envId, threadId }: { envId: string; threadId: string }) {
  const panelWidth = usePanelWidth();
  const env = useGame((s) => s.envs[envId]);
  const readReports = useGame((s) => s.readReports);
  const thread = env?.threads[threadId];
  const detail = useGame((s) => s.details[unitKey(envId, threadId)]);
  const hermesCatalog = useGame(s => s.hermesCatalog);

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
  // An unreachable machine's crew are last known: no live timer, and nothing to send them.
  const live = env.connection === "live";
  const canHalt = live && (state === "working" || (env.summary.kind === "hermes" && thread.latestTurn?.state === "running"));
  const archived = isHistory(thread);
  const info = detail ? telemetry(detail.thread) : undefined;
  const project = env.projects[thread.projectId];
  const client = envClient(envId);
  const bot = env.summary.kind === 'hermes' ? botOperators({ envs: useGame.getState().envs, hermesCatalog }).find(b => b.name === (thread.hermesProfile ?? 'default')) : undefined;
  const unitName = thread.hermesBotChat && bot ? bot.title : thread.title || "Untitled";

  const run = (what: string, fn: () => Promise<unknown> | undefined) => {
    fn()?.catch((err: unknown) => logError(what, err));
  };

  return (
    <aside className={`panel unit-panel ${bot ? 'hermes-chat' : ''}`} style={{ width: panelWidth.width }}>
      <PanelResize {...panelWidth} />
      <header className="panel-head">
        {bot ? <BotPortrait profile={bot.name} /> : <div className="portrait sprite-portrait"><CrewPortrait instanceId={thread.modelSelection.instanceId} model={thread.modelSelection.model} team={stationColor(useGame.getState(), envId)} /></div>}
        <div className="panel-title">
          <span className="title-tab panel-kind"><PixelLabel text={bot ? "Operator" : "Crew"} /></span>
          <h2 title={unitName}>{unitName}</h2>
          {bot && <div className="muted small">Hermes operator · {bot.name}{thread.hermesBotChat ? ' · ongoing conversation' : ' · task session'}</div>}
          <div className="muted small">
            {bot ? bot.model || 'Hermes configured model' : `${TIER_LABEL[modelTier(thread.modelSelection.model)]} · ${providerName(env, thread.modelSelection.instanceId)} · ${modelName(env, thread)}`}
          </div>
          <div className="muted small">
            {bot ? bot.description || 'Hermes control center' : `${project?.title ?? '?'} @ ${env.summary.label}`}
            {thread.branch ? ` · ⎇ ${thread.branch}` : ""}
          </div>
        </div>
        <button className="icon-btn" onClick={() => setSelection(null)} title="Close (Esc)">
          ✕
        </button>
      </header>
      {bot && <button className="btn ops-back" onClick={() => { const selection = { kind: 'hermes' as const, envId, profile: bot.name }; setSelection(selection); worldRef.current?.focus(selection); }}>← Control center</button>}

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
        <span className={`pill state-${live ? state : "sleeping"}`} title={live ? undefined : `${env.summary.label} is unreachable: this is how it was when Command last heard from it`}>
          {live ? "" : "Last known · "}{bot ? BOT_STATE_LABELS[state] : stateLabel(thread, state)}
        </span>
        {env.summary.kind !== 'hermes' && live && <PostureControl envId={envId} thread={thread} />}
        {live && <ThreadTiming thread={thread} detail={detail?.thread} />}
        <span className="spacer" />
        {!bot && (detail?.thread.checkpoints.length ?? 0) > 0 && (
          <button className="btn" title="Its report beside its checks, tests and the branch's changes" onClick={() => openReview({ envId, threadId })}>Review</button>
        )}
        {!bot && state === "done" && thread.latestTurn && !reportRead(readReports, envId, thread) && (
          <button className="btn" title="Take this report out of Needs you and the REPORTS count (this browser), until the thread's next turn"
            onClick={() => markReportsRead([{ envId, threadId, turnId: thread.latestTurn!.turnId }])}>✓ Mark read</button>
        )}
        {!bot && live && state === "error" && <FailedActions envId={envId} thread={thread} className="btn" />}
        {canHalt && (
          <button className="btn danger" onClick={() => run("Interrupt", () => client?.interrupt(threadId))}>
            ■ Halt
          </button>
        )}
        {!live ? null : state === "sleeping" ? (
          <button className="btn" onClick={() => run("Wake", () => client?.unsettle(threadId))}>
            {bot ? 'Reopen' : 'Wake'}
          </button>
        ) : (
          !canHalt && (
            <button className="btn" onClick={() => run("Send to camp", () => client?.settle(threadId))} title="Mark the thread settled">
              {bot ? 'Acknowledge' : <><PixelIcon name="camp" /> To camp</>}
            </button>
          )
        )}
      </div>
      )}

      {!archived && env.summary.kind === 'hermes' && <HermesPermissions key={`${envId}:${threadId}`} envId={envId} threadId={threadId} />}

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
                  style={{ width: `${Math.round((1 - info.context) * 100)}%`, background: `var(--gauge-${contextLevel(info.context)})` }}
                />
              </span>
              <span className="tele-val">{Math.round((1 - info.context) * 100)}% left</span>
            </div>
          )}
          {contextWarning(info.context, info.compactsAutomatically) && (
            <div className="tele-row context-warning">
              <span className="tele-key">WARNING</span>
              <span className="tele-val" title={contextWarning(info.context, info.compactsAutomatically)}>{contextWarning(info.context, info.compactsAutomatically)}</span>
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

      {!archived && detail && <TurnTelemetry shell={thread} detail={detail.thread} />}
      {!archived && <FailureNote thread={thread} />}
      {!archived && <PullRequestChips thread={thread} />}
      {!archived && detail && !bot && <TurnChanges env={env} thread={thread} detail={detail.thread} state={state} />}

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

      {!archived && env.summary.kind !== "hermes" && thread.interactionMode === "plan" && state === "done" && env.connection === "live" && <PlanReady envId={envId} thread={thread} />}
      {!archived && <OrderBox envId={envId} threadId={threadId} disabled={env.connection !== "live"} working={state === "working"} busy={turnBusy(thread)} />}
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
  // The request card is open for this crew member: one set of buttons, not two.
  const deciding = useGame((s) => s.event?.envId === envId && s.event?.threadId === threadId);
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

  const risk = assessRisk(request);
  const options = allowedDecisions((p.options as Array<{ decision: ApprovalDecision; label: string; warning?: string }> | undefined) ?? DEFAULT_APPROVAL_OPTIONS, risk);
  const detail = typeof p.detail === "string" ? p.detail : undefined;
  return (
    <div className="pending approval">
      <div className="pending-title">! Requesting permission: {String(p.requestKind ?? p.requestType ?? "action")}</div>
      <div className="pending-summary">{request.activity.summary}</div>
      {risk && <RiskBanner risk={risk} />}
      {detail && <pre className={`pending-detail ${risk ? `risk-${risk.level}` : ""}`}>{detail}</pre>}
      {deciding ? <p className="muted small">Deciding in the request card.</p> : <div className="pending-actions">
        {options.map((o) => (
          <button
            key={o.decision}
            className={`btn ${o.decision === "decline" || o.decision === "cancel" ? "danger" : "approve"}`}
            disabled={busy}
            title={o.warning}
            onClick={() => {
              setBusy(true);
              // The acknowledgement sounds once the answer has landed, as on the request card.
              client?.respondToApproval(threadId, request.requestId, o.decision)
                .then(() => (o.decision === "decline" || o.decision === "cancel" ? sfx.deny : sfx.order)())
                .catch((err: unknown) => (setBusy(false), sfx.error(), logError("Approval", err)));
            }}
          >
            {o.label}
          </button>
        ))}
      </div>}
    </div>
  );
}

function OrderBox({ envId, threadId, disabled, working, busy }: { envId: string; threadId: string; disabled: boolean; working: boolean; busy: boolean }) {
  // Kept as a draft per crew member, so a reload or a new release never loses it.
  const [text, setText, clearText] = useDraft(`order:${envId}:${threadId}`);
  const [sending, setSending] = useState(false);
  /** Standing order: how many times in all, counting this one (1 is a plain order). */
  const [times, setTimes] = useState(1);
  const followUps = useGame((s) => s.followUps);
  const queued = followUpFor(followUps, envId, threadId);
  // Saved orders: "/" at the start lists them; picking one puts its text in the box to edit or send.
  const playbooks = useGame((s) => s.playbooks);
  const slash = /^\/([a-z0-9-]*)$/.exec(text.trim());
  const matches = slash ? playbooks.filter((p) => p.name.startsWith(slash[1])).slice(0, 6) : [];
  const [pick, setPick] = useState(0);
  const applyPlaybook = (i: number) => { const book = matches[i]; if (book) { setText(book.text); setPick(0); } };
  const input = useRef<HTMLTextAreaElement>(null);
  // Phone keyboards have no Shift+Enter: Return adds a line and the Send button sends.
  const phone = usePhone();

  useEffect(() => {
    // Focusing on a phone would raise the keyboard over the reports; after a hotkey jump it would
    // swallow the next hotkey (O or Enter comes here instead).
    if (!isPhone() && performance.now() - useGame.getState().jumpedAt > 1000) input.current?.focus();
  }, [envId, threadId]);

  // A standing order tells the agent how to stop it.
  const withNote = (order: string) => (times > 1 ? `${order}\n\n${standingNote(times)}` : order);
  const send = async () => {
    const order = withNote(expandPlaybook(text.trim(), playbooks));
    if (!order || sending) return;
    setSending(true);
    // The turn before this order: the repeats wait on the turn the order starts, whichever it is.
    const before = useGame.getState().envs[envId]?.threads[threadId]?.latestTurn?.turnId ?? null;
    try {
      await envClient(envId)?.order(threadId, order);
      if (times > 1) {
        try { await queueFollowUp(envId, threadId, order, { times: times - 1, startedAfter: before }); }
        catch (err) { logError("Sent once; couldn't set it to repeat", err); }
      }
      sfx.order();
      clearText();
      setTimes(1);
    } catch (err) {
      sfx.error();
      logError("Order failed", err);
    } finally {
      setSending(false);
    }
  };

  // Busy: hold the order on the Command server and send it when this turn ends (Alt+Enter).
  const queue = async () => {
    const order = withNote(expandPlaybook(text.trim(), playbooks));
    if (!order || sending) return;
    setSending(true);
    try {
      await queueFollowUp(envId, threadId, order, times > 1 ? { times } : {});
      sfx.order();
      clearText();
      setTimes(1);
    } catch (err) {
      sfx.error();
      logError("Couldn't queue the follow-up", err);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
    {queued && (
      <div className="follow-up">
        <span className="follow-up-text" title={queued.total ? `Given again after each turn that ends cleanly; stops at a failure, an interruption, or your next order.\n\n${queued.text}` : queued.text}>
          <strong>{queued.total ? followUpLabel(queued) : "Queued for when this turn ends"}{followUps.paused ? " (follow-ups paused)" : ""}:</strong> {queued.text}</span>
        <button className="btn small" onClick={() => void cancelFollowUp(queued.id).catch((err) => logError("Couldn't cancel", err))}>Cancel</button>
      </div>
    )}
    {matches.length > 0 && (
      <ul className="playbook-list" role="listbox" aria-label="Saved orders">
        {matches.map((p, i) => (
          <li key={p.name} role="option" aria-selected={i === pick} className={i === pick ? "active" : ""} onPointerDown={(e) => { e.preventDefault(); applyPlaybook(i); }}>
            <strong>/{p.name}</strong> <span className="muted">{p.text}</span>
          </li>
        ))}
        <li className="playbook-edit"><button className="link-button" onPointerDown={(e) => { e.preventDefault(); useGame.setState({ showPlaybooks: true }); }}>Edit saved orders…</button></li>
      </ul>
    )}
    <div className="order-box">
      <textarea
        ref={input}
        data-order-box
        value={text}
        placeholder={working ? "Busy: an order sent now starts a new turn (After turn ↻ waits)…" : phone ? "Give orders…" : "Give orders… (Enter to send, Shift+Enter for newline)"}
        disabled={disabled || sending}
        rows={3}
        onChange={(e) => { setText(e.target.value); setPick(0); }}
        onKeyDown={(e) => {
          if (matches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setPick((p) => (p + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
            return;
          }
          if (matches.length && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.altKey))) {
            e.preventDefault();
            applyPlaybook(pick);
            return;
          }
          if (e.key === "Enter" && e.altKey && busy) {
            e.preventDefault();
            void queue();
          } else if (e.key === "Enter" && !e.shiftKey && !phone) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="order-actions">
        <button className="btn primary" disabled={disabled || sending || !text.trim()} onClick={() => void send()}>
          {sending ? "…" : "Send ▶"}
        </button>
        {busy && (
          <button className="btn" disabled={sending || !text.trim()} title="The Command server sends it when this turn ends cleanly (Alt+Enter)" onClick={() => void queue()}>
            After turn <PixelIcon name="repeat" />
          </button>
        )}
        <select className="order-times" value={times} disabled={disabled || sending} aria-label="Times to give this order"
          title="Standing order: the Command server gives it again after each turn that ends cleanly, and stops at a failure, an interruption, or your next order"
          onChange={(e) => setTimes(Number(e.target.value))}>
          {[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n === 1 ? "Once" : `×${n}`}</option>)}
        </select>
      </div>
    </div>
    </>
  );
}
