import { useEffect, useMemo } from "react";
import { useGame } from "../store";
import { PixelLabel } from "./PixelArt";
import { queueLength, startQueue } from "./queue-run";

/** The top bar's way into a run through the queue, with how much is waiting. Hidden when there's nothing. */
export function QueueButton() {
  const envs = useGame((s) => s.envs);
  const details = useGame((s) => s.details);
  const read = useGame((s) => s.readReports);
  const running = useGame((s) => !!s.queueRun);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recount when what the queue reads changes
  const waiting = useMemo(() => queueLength(), [envs, details, read]);
  if (!waiting || running) return null;
  return (
    <button className="btn queue-btn" title="Work through everything waiting on you, one card at a time (Q)" onClick={() => startQueue()}>
      ▶ Queue <strong>{waiting}</strong>
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
      <p>{clear.handled ? `${clear.handled} card${clear.handled === 1 ? "" : "s"} handled. Nothing else is waiting on you.` : "Nothing was waiting on you."}</p>
    </div>
  );
}
