import type { OrchestrationThread, ThreadShell } from "../t3/types";
import { elapsed, threadTimes } from "../t3/timing";
import { useClock } from "./useClock";

export function ThreadTiming({ thread, detail, compact = false }: { thread: ThreadShell; detail?: OrchestrationThread; compact?: boolean }) {
  const now = useClock(thread.latestTurn?.state === "running" || thread.hasPendingApprovals || thread.hasPendingUserInput);
  const times = threadTimes(thread, detail, now);
  if (times.waitingMs === undefined && times.turnMs === undefined) return null;
  return (
    <span className={`thread-timing small ${compact ? "compact" : ""}`}>
      {times.waitingMs !== undefined && <span className="orange" title="Time since the oldest unanswered request">Waiting {elapsed(times.waitingMs)}</span>}
      {times.turnMs !== undefined && (!compact || times.running) && <span className="muted" title="Elapsed wall time, including waits">{times.running ? "Turn" : "Last turn"} {elapsed(times.turnMs)}</span>}
    </span>
  );
}
