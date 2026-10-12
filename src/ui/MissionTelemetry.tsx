// Mission telemetry in the crew panel: why a turn failed, linked pull requests, and what each turn
// changed on disk, with a diff viewer and a guarded rollback.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { EnvWorld } from "../store";
import type { UnitState } from "../t3/derive";
import { parseDiff, type ParsedDiff } from "../t3/diff";
import { envClient, logError } from "../t3/environment";
import type { Checkpoint, OrchestrationThread, ThreadShell } from "../t3/types";
import { timeAgo } from "./util";

/** The provider's own explanation when a turn fails. */
export function FailureNote({ thread }: { thread: ThreadShell }) {
  const error = thread.session?.lastError;
  const failed = thread.latestTurn?.state === "error" || thread.session?.status === "error";
  if (!error || !failed) return null;
  return (
    <div className="failure-note" role="alert">
      <span className="tele-key">TURN FAILED</span>
      <span>{error}</span>
    </div>
  );
}

const CHECKS: Record<string, string> = { passing: "✓ checks", failing: "✗ checks", pending: "… checks" };

export function PullRequestChips({ thread }: { thread: ThreadShell }) {
  const prs = thread.pullRequests ?? [];
  if (!prs.length) return null;
  return (
    <div className="pr-chips">
      {prs.map((pr) => {
        const s = pr.snapshot;
        const state = s?.isDraft && s.state === "open" ? "draft" : s?.state ?? "linked";
        return (
          <a key={`${pr.repository}#${pr.number}`} className={`pr-chip pr-${state}`} href={pr.url} target="_blank" rel="noreferrer"
            title={s ? `${s.title}\n${s.headBranch} → ${s.baseBranch}` : pr.url}>
            <span className="pr-number">#{pr.number}</span>
            <span className="pr-state">{state.toUpperCase()}</span>
            {s?.checksState && <span>{CHECKS[s.checksState] ?? `${s.checksState} checks`}</span>}
            {s?.reviewDecision && <span>{s.reviewDecision.replace(/_/g, " ").toLowerCase()}</span>}
            {s?.additions !== undefined && <span className="muted">+{s.additions} −{s.deletions ?? 0}</span>}
          </a>
        );
      })}
    </div>
  );
}

const sum = (c: Checkpoint, key: "additions" | "deletions") => c.files.reduce((n, f) => n + f[key], 0);

/** Per-turn file changes from T3's checkpoints, newest first. */
export function TurnChanges({ env, thread, detail, state }: { env: EnvWorld; thread: ThreadShell; detail: OrchestrationThread; state: UnitState }) {
  const [diff, setDiff] = useState<Checkpoint>();
  const [confirm, setConfirm] = useState<number>();
  const [busy, setBusy] = useState(false);
  const turns = [...detail.checkpoints].sort((a, b) => b.checkpointTurnCount - a.checkpointTurnCount);
  if (!turns.length) return null;
  const latest = turns[0].checkpointTurnCount;
  const provider = env.providers.find((p) => p.instanceId === (thread.session?.providerInstanceId ?? thread.modelSelection.instanceId));
  // Like T3 Code: only an explicit false rules rollback out. Never while the agent is busy.
  const canRollBack = !!provider && provider.supportsConversationRollback !== false && env.connection === "live"
    && state !== "working" && state !== "alert" && state !== "question" && thread.latestTurn?.state !== "running";
  const added = turns.reduce((n, c) => n + sum(c, "additions"), 0);
  const removed = turns.reduce((n, c) => n + sum(c, "deletions"), 0);

  const rollBack = async (turnCount: number) => {
    setBusy(true);
    try {
      await envClient(env.summary.id)?.rollBackToTurn(thread.id, turnCount);
      setConfirm(undefined);
    } catch (err) {
      logError("Roll back", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="turn-changes">
      <summary>
        <span className="tele-key">CHANGES</span>
        <span className="muted small">last {turns.length} turn{turns.length === 1 ? "" : "s"} · <span className="diff-add">+{added}</span> <span className="diff-del">−{removed}</span></span>
      </summary>
      <ol className="turn-list">
        {turns.map((c) => {
          const n = c.checkpointTurnCount;
          const usable = (c.status ?? "ready") === "ready";
          const later = turns.filter((t) => t.checkpointTurnCount > n);
          const laterFiles = new Set(later.flatMap((t) => t.files.map((f) => f.path))).size;
          return (
            <li key={c.turnId} className="turn-row">
              <div className="turn-head">
                <span className="turn-name">Turn {n}</span>
                <span className="muted small">{c.files.length} file{c.files.length === 1 ? "" : "s"} · <span className="diff-add">+{sum(c, "additions")}</span> <span className="diff-del">−{sum(c, "deletions")}</span> · {timeAgo(c.completedAt)}</span>
                <span className="spacer" />
                {usable && c.files.length > 0 && <button className="btn small" onClick={() => setDiff(c)}>Diff</button>}
                {usable && canRollBack && n < latest && confirm !== n && (
                  <button className="btn small danger" onClick={() => setConfirm(n)} title="Restore files and conversation to after this turn">Roll back to here</button>
                )}
              </div>
              {!usable && <div className="muted small">Checkpoint {c.status}: no diff or rollback for this turn.</div>}
              {confirm === n && (
                <div className="rollback-confirm" role="alert">
                  <p>
                    Restore this agent's files and conversation to just after turn {n}? The {later.length} later turn{later.length === 1 ? "" : "s"} and
                    {" "}their changes to {laterFiles} file{laterFiles === 1 ? "" : "s"} will be discarded. This can't be undone from Command.
                  </p>
                  <button className="btn danger" disabled={busy} onClick={() => void rollBack(n)}>{busy ? "Rolling back…" : `Roll back to turn ${n}`}</button>
                  <button className="btn" disabled={busy} onClick={() => setConfirm(undefined)}>Cancel</button>
                </div>
              )}
              <ul className="turn-files">
                {c.files.slice(0, 8).map((f) => (
                  <li key={f.path}><span className="file-path" title={f.path}>{f.path}</span> <span className="diff-add">+{f.additions}</span> <span className="diff-del">−{f.deletions}</span></li>
                ))}
                {c.files.length > 8 && <li className="muted">+{c.files.length - 8} more</li>}
              </ul>
            </li>
          );
        })}
      </ol>
      {diff && <DiffViewer envId={env.summary.id} threadId={thread.id} turn={diff.checkpointTurnCount} onClose={() => setDiff(undefined)} />}
    </details>
  );
}

/** One turn's unified diff, fetched on open. Escape closes it without deselecting the crew member. */
function DiffViewer({ envId, threadId, turn, onClose }: { envId: string; threadId: string; turn: number; onClose: () => void }) {
  const [parsed, setParsed] = useState<ParsedDiff>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    const client = envClient(envId);
    if (!client) { setError("Station is not connected"); return; }
    client.turnDiff(threadId, turn - 1, turn).then((diff) => { if (live) setParsed(parseDiff(diff)); })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : String(err)); });
    return () => { live = false; };
  }, [envId, threadId, turn]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  // Portaled so it covers the whole view rather than the crew panel it was opened from.
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal diff-modal" role="dialog" aria-label={`Turn ${turn} diff`} onClick={(e) => e.stopPropagation()}>
        <header className="panel-head">
          <h2>Turn {turn} changes</h2>
          <span className="spacer" />
          <button className="icon-btn" aria-label="Close diff" onClick={onClose}>✕</button>
        </header>
        {!parsed && !error && <p className="muted">Loading diff…</p>}
        {error && <p className="small" role="alert">Could not load the diff: {error}</p>}
        {parsed && parsed.files.length === 0 && <p className="muted">No file changes in this turn.</p>}
        {parsed?.files.map((file, index) => (
          <details key={file.path} className="diff-file" open={index < 3}>
            <summary><span className="file-path">{file.path}</span> <span className="diff-add">+{file.additions}</span> <span className="diff-del">−{file.deletions}</span></summary>
            {file.binary ? <p className="muted small">Binary file</p> : (
              <pre className="diff-body">{file.lines.map((line, i) => (
                <span key={i} className={`diff-line diff-${line.kind}`}>{line.kind === "add" ? "+" : line.kind === "del" ? "−" : line.kind === "ctx" ? " " : ""}{line.text}{"\n"}</span>
              ))}</pre>
            )}
          </details>
        ))}
        {parsed?.truncated && <p className="muted small">Long diff: only the first lines are shown.</p>}
      </div>
    </div>,
    document.body,
  );
}
