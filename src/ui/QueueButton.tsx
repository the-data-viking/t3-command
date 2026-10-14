import { useEffect, useMemo } from "react";
import { useGame } from "../store";
import { PixelLabel } from "./PixelArt";
import { needsYou, needsYouCounts } from "./needs-you";
import { startQueue } from "./queue-run";

/** The top bar's way into a run through the queue, with how much is waiting. Hidden when there's nothing. */
export function QueueButton() {
  const envs = useGame((s) => s.envs);
  const details = useGame((s) => s.details);
  const read = useGame((s) => s.readReports);
  const running = useGame((s) => !!s.queueRun);
  const counts = useMemo(() => needsYouCounts(needsYou({ envs, details, readReports: read })), [envs, details, read]);
  if (!counts.total || running) return null;
  const parts = [
    counts.approval && `${counts.approval} approval${counts.approval === 1 ? "" : "s"}`,
    counts.question && `${counts.question} question${counts.question === 1 ? "" : "s"}`,
    counts.plan && `${counts.plan} plan${counts.plan === 1 ? "" : "s"}`,
    counts.failure && `${counts.failure} failed`,
    counts.report && `${counts.report} report${counts.report === 1 ? "" : "s"}`,
  ].filter(Boolean).join(", ");
  return (
    <button className="btn queue-btn" title={`Needs you: ${parts}. Work through it one card at a time (Q).`} aria-label={`Needs you: ${counts.total}. Work through it`} onClick={() => startQueue()}>
      ▶ <span className="queue-label">Needs you</span> <strong>{counts.total}</strong>
    </button>
  );
}

/** The end of a run: a short "queue clear" card that dismisses itself. */
export function QueueClear() {
  const clear = useGame((s) => s.queueClear);
  useEffect(() => {
    if (!clear) return;
    const timer = setTimeout(() => useGame.setState({ queueClear: null }), 4000);
    return () => clearTimeout(timer);
  }, [clear]);
  if (!clear) return null;
  return (
    <div className="queue-clear ftl-frame" role="status" onClick={() => useGame.setState({ queueClear: null })}>
      <div className="ftl-tab"><PixelLabel text="Queue clear" /></div>
      <p>{clear.handled + clear.skipped === 0 ? "Nothing was waiting on you."
        : `${clear.handled} card${clear.handled === 1 ? "" : "s"} handled.${clear.skipped ? ` ${clear.skipped} left for later, still waiting.` : " Nothing else is waiting on you."}`}</p>
    </div>
  );
}
