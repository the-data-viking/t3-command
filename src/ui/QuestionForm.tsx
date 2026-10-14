import { useDraft } from "./drafts";
import { useEffect, useId, useState } from "react";
import { sfx } from "../game/sfx";
import { envClient, logError } from "../t3/environment";
import { questionAnswers, requestQuestions, type QuestionAnswer } from "../t3/questions";
import type { PendingRequest } from "../t3/types";
import { useGame } from "../store";

/** Shared by the incoming-question dialog and the crew log. Mount with the request ID as key. */
/**
 * With `keys` (the request card, once armed), 1–9 pick an option of the first question still
 * unanswered (toggle, for select-all) and Enter sends once every question has an answer; typing in
 * an answer box keeps its keys.
 */
export function QuestionForm({ request, envId, threadId, onAnswered, keys = false }: { request: PendingRequest; envId: string; threadId: string; onAnswered?: () => void; keys?: boolean }) {
  const prefix = useId();
  const connected = useGame((s) => s.envs[envId]?.connection === "live");
  const questions = requestQuestions(request.activity.payload ?? {});
  // Answers in progress are kept per request, so a reload doesn't lose a typed answer.
  const [saved, save, forget] = useDraft(`answer:${envId}:${threadId}:${request.requestId}`);
  const drafts = parseAnswers(saved);
  const setDrafts = (update: (d: Record<string, QuestionAnswer>) => Record<string, QuestionAnswer>) => save(JSON.stringify(update(parseAnswers(saved))));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const answers = questionAnswers(questions, drafts);
  const disabled = busy || !connected;

  const respond = async (dismiss: boolean) => {
    if (disabled || (!dismiss && !answers)) return;
    setBusy(true);
    setError(undefined);
    try {
      const client = envClient(envId);
      if (!client) throw new Error("This station is not connected.");
      if (dismiss) await client.dismissQuestion(threadId, request.requestId);
      else await client.respondToQuestion(threadId, request.requestId, answers!);
      sfx.order();
      forget();
      onAnswered?.();
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Response failed. Please try again.");
      logError("Question response failed", err);
      sfx.error();
    }
  };

  useEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || disabled) return;
      if ((e.target as HTMLElement | null)?.closest("input:not([type=radio]):not([type=checkbox]), textarea, select, [contenteditable]")) return;
      if (e.key === "Enter" && answers) { e.preventDefault(); e.stopImmediatePropagation(); void respond(false); return; }
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1) return;
      const q = questions.find((q) => !questionAnswers([q], drafts)) ?? questions[0];
      const option = q?.options[n - 1];
      if (!q || !option) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const value = option.value ?? option.label;
      const draft = drafts[q.id] ?? { selected: [], custom: "", useCustom: false };
      const selected = q.multiSelect
        ? draft.selected.includes(value) ? draft.selected.filter((s) => s !== value) : [...draft.selected, value]
        : [value];
      setDrafts((prev) => ({ ...prev, [q.id]: { ...draft, useCustom: false, selected } }));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <form className="question-form" onSubmit={(e) => { e.preventDefault(); void respond(false); }}>
      {questions.map((q, i) => {
        const draft = drafts[q.id] ?? { selected: [], custom: "", useCustom: q.options.length === 0 };
        const name = `${prefix}-${i}`;
        const update = (next: QuestionAnswer) => setDrafts((prev) => ({ ...prev, [q.id]: next }));
        return (
          <fieldset key={q.id} className="question-field" disabled={disabled}>
            <legend>{q.header && <span className="question-header">{q.header}</span>}{q.question}</legend>
            {q.multiSelect && <div className="muted small">Select all that apply.</div>}
            {q.options.map((option, j) => {
              const value = option.value ?? option.label;
              const checked = !draft.useCustom && draft.selected.includes(value);
              return (
                <label key={j} className={`question-option${checked ? " selected" : ""}`}>
                  <input type={q.multiSelect ? "checkbox" : "radio"} name={name} checked={checked}
                    onChange={() => update({ ...draft, useCustom: false, selected: q.multiSelect
                      ? checked ? draft.selected.filter((s) => s !== value) : [...draft.selected, value]
                      : [value] })} />
                  <span><strong>{option.label}</strong>{option.description && <span className="question-description">{option.description}</span>}</span>
                </label>
              );
            })}
            {q.allowCustomAnswer !== false && (
              <>
                {q.options.length > 0 && <label className={`question-option${draft.useCustom ? " selected" : ""}`}>
                  <input type="radio" name={name} checked={draft.useCustom}
                    onChange={() => update({ ...draft, useCustom: true, selected: [] })} />
                  <span>Other answer</span>
                </label>}
                <textarea aria-label={`Your answer: ${q.question}`} rows={2} placeholder="Type your answer…" value={draft.custom}
                  onChange={(e) => update({ ...draft, custom: e.target.value, useCustom: true, selected: [] })} />
              </>
            )}
          </fieldset>
        );
      })}
      {questions.length === 0 && <p className="muted">No supported question fields were received.</p>}
      {error && <p role="alert">{error}</p>}
      {!connected && <p className="muted small">Reconnect this station to answer.</p>}
      <div className="pending-actions">
        <button className="btn primary" type="submit" disabled={disabled || !answers}>{busy ? "Sending…" : "Send answers"}</button>
        <button className="btn" type="button" disabled={disabled} onClick={() => void respond(true)}>Dismiss</button>
      </div>
    </form>
  );
}

function parseAnswers(saved: string): Record<string, QuestionAnswer> {
  try { return saved ? JSON.parse(saved) as Record<string, QuestionAnswer> : {}; } catch { return {}; }
}
