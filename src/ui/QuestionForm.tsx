import { useId, useState } from "react";
import { sfx } from "../game/sfx";
import { envClient, logError } from "../t3/environment";
import { questionAnswers, requestQuestions, type QuestionAnswer } from "../t3/questions";
import type { PendingRequest } from "../t3/types";
import { useGame } from "../store";

/** Shared by the incoming-question dialog and the crew log. Mount with the request ID as key. */
export function QuestionForm({ request, envId, threadId, onAnswered }: { request: PendingRequest; envId: string; threadId: string; onAnswered?: () => void }) {
  const prefix = useId();
  const connected = useGame((s) => s.envs[envId]?.connection === "live");
  const questions = requestQuestions(request.activity.payload ?? {});
  const [drafts, setDrafts] = useState<Record<string, QuestionAnswer>>({});
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
      onAnswered?.();
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Response failed. Please try again.");
      logError("Question response failed", err);
      sfx.error();
    }
  };

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
