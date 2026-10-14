import { useState } from "react";
import { pulseOf, pulseText } from "./pulse";
import { compactions, latestPlan, quietness, quietText, tokenLabel, turnBreakdown } from "../t3/progress";
import { elapsed } from "../t3/timing";
import type { OrchestrationThread, ThreadShell } from "../t3/types";
import { useClock } from "./useClock";

/** Roster line: the current plan step (from the shell) and, if followed, a quiet turn. */
export function PlanLine({ thread, detail }: { thread: ThreadShell; detail?: OrchestrationThread }) {
  const running = thread.latestTurn?.state === "running";
  const now = useClock(running);
  const plan = running ? thread.planProgress : null;
  const quiet = running && detail ? quietness(thread, detail, now) : undefined;
  if (!plan && !quiet) return null;
  return (
    <span className="crew-plan small">
      {quiet && <span className={quiet.kind === "quiet" ? "orange" : "muted"} title={quietText(quiet)}>{quiet.kind === "quiet" ? `Quiet ${elapsed(quiet.ms)}` : quiet.kind === "tool" ? `Tool ${elapsed(quiet.ms)}` : `Tasks · quiet ${elapsed(quiet.ms)}`}</span>}
      {plan && <span className="muted" title={`Plan step ${plan.completedSteps + 1} of ${plan.totalSteps}: ${plan.step}`}>
        <span className="count-working">{Math.min(plan.completedSteps + 1, plan.totalSteps)}/{plan.totalSteps}</span> · {plan.step}
      </span>}
    </span>
  );
}

const STEP_MARK = { completed: "✓", inProgress: "▸", pending: "·" } as const;

/** Unit panel rows: plan, how the turn's time split, tokens, compactions, and quiet turns. */
export function TurnTelemetry({ shell, detail }: { shell: ThreadShell; detail: OrchestrationThread }) {
  const running = detail.latestTurn?.state === "running";
  const now = useClock(running, 1000);
  const [open, setOpen] = useState(false);
  const plan = latestPlan(detail);
  const turn = turnBreakdown(detail, now);
  const compacted = compactions(detail);
  const quiet = quietness(shell, detail, now);
  const pulse = running ? pulseOf(detail, now) : undefined;
  if (!plan && !turn && !compacted.last) return null;
  const showPlan = plan && (plan.current || !running);
  return (
    <div className="telemetry turn-telemetry">
      {quiet && (
        <div className={`tele-row ${quiet.kind === "quiet" ? "quiet-row" : ""}`}>
          <span className="tele-key">{quiet.kind === "quiet" ? "QUIET" : "LONG RUN"}</span>
          <span className="tele-val" title={quietText(quiet)}>{quietText(quiet)}</span>
        </div>
      )}
      {pulse && (pulse.lastChangeAt || pulse.tests.length > 0 || pulse.repeatFail || pulse.noChangeMs) && (
        <div className={`tele-row ${pulse.repeatFail || pulse.noChangeMs ? "quiet-row" : ""}`}>
          <span className="tele-key">PULSE</span>
          <span className="tele-val" title="Is the turn moving? From its own activity. A sign to look at, not a ruling that it's stuck.">{pulseText(pulse, now)}</span>
        </div>
      )}
      {showPlan && (
        <>
          <div className="tele-row">
            <span className="tele-key">PLAN</span>
            <span className="hp" title={`${plan.completed} of ${plan.steps.length} steps done`}>
              <span className="hp-fill" style={{ width: `${(plan.completed / plan.steps.length) * 100}%`, background: "var(--working)" }} />
            </span>
            <button className="tele-val plan-toggle" aria-expanded={open} onClick={() => setOpen(!open)}
              title={plan.current ? "Current plan" : "Last plan of the finished turn"}>
              {plan.completed}/{plan.steps.length}{plan.current ? "" : " · last turn"} {open ? "▾" : "▸"}
            </button>
          </div>
          {open && (
            <ol className="plan-steps">
              {plan.steps.map((s, i) => (
                <li key={i} className={`plan-${s.status}`}><span aria-hidden>{STEP_MARK[s.status]}</span> {s.step}</li>
              ))}
            </ol>
          )}
        </>
      )}
      {turn && (
        <div className="tele-row">
          <span className="tele-key">{turn.running ? "TURN" : "LAST TURN"}</span>
          <span className="tele-val" title="Agent time is the turn's wall time minus time spent waiting on your approvals and answers. Tokens are as the provider reports them, cached input included.">
            Agent {elapsed(turn.agentMs)}
            {turn.waitingMs > 0 && <span className="orange"> · waiting on you {elapsed(turn.waitingMs)}</span>}
            {turn.tokens !== undefined && <span className="muted"> · {tokenLabel(turn.tokens)} tokens</span>}
          </span>
        </div>
      )}
      {/* T3's thread snapshot doesn't keep a stable compaction history, so only the latest is shown. */}
      {compacted.last && (
        <div className="tele-row">
          <span className="tele-key">COMPACTED</span>
          <span className="tele-val" title={new Date(compacted.last.at).toLocaleString()}>
            {tokenLabel(compacted.last.beforeTokens)} → {tokenLabel(compacted.last.afterTokens)} <span className="muted">· {elapsed(Math.max(0, now - Date.parse(compacted.last.at)))} ago</span>
          </span>
        </div>
      )}
    </div>
  );
}
