import { lastActivityAt } from "../t3/progress";
import type { OrchestrationThread, ThreadShell } from "../t3/types";
import { elapsed, threadTimes } from "../t3/timing";
import { unitState } from "../t3/derive";
import { isBackground } from "./util";
import { useClock } from "./useClock";

export function ThreadTiming({ thread, detail, compact = false }: { thread: ThreadShell; detail?: OrchestrationThread; compact?: boolean }) {
  const background = isBackground(thread, unitState(thread));
  const now = useClock(thread.latestTurn?.state === "running" || background || thread.hasPendingApprovals || thread.hasPendingUserInput, 1000);
  const times = threadTimes(thread, detail, now);
  const since = Date.parse(thread.latestTurn?.completedAt ?? "");
  // How long since anything happened: the "is it stuck?" signal, shown once it's over a minute.
  const last = detail && (times.running || background) ? lastActivityAt(detail) : undefined;
  const quiet = last !== undefined && now - last > 60_000 ? now - last : undefined;
  if (times.waitingMs === undefined && times.turnMs === undefined && !background) return null;
  return (
    <span className={`thread-timing small ${compact ? "compact" : ""}`}>
      {times.waitingMs !== undefined && <span className="orange" title="Time since the oldest unanswered request">Waiting {elapsed(times.waitingMs)}</span>}
      {background && Number.isFinite(since) && <span className="muted" title="The turn ended, but its session or background agents are still running">Background {elapsed(Math.max(0, now - since))}</span>}
      {!background && times.turnMs !== undefined && (!compact || times.running) && <span className="muted" title="Elapsed wall time, including waits">{times.running ? "Turn" : "Last turn"} {elapsed(times.turnMs)}</span>}
      {quiet !== undefined && <span className="muted" title={`Last activity ${new Date(last!).toLocaleTimeString()}`}>active {elapsed(quiet)} ago</span>}
    </span>
  );
}
