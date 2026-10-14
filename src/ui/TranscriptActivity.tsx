import type { Activity } from "../t3/types";

export function ActivityView({ activity }: { activity: Activity }) {
  const failed = activity.tone === "error" || activity.payload?.status === "failed";
  const icon = failed ? "✖" : activity.tone === "approval" ? "▲" : activity.kind.startsWith("task.") ? "▪" : "⚒";
  return (
    <div className={`activity tone-${failed ? "error" : activity.tone}`} title={activity.kind}>
      <span className="activity-icon">{icon}</span> {activity.summary}
    </div>
  );
}

export function ToolActivityGroup({ activities }: { activities: Activity[] }) {
  const failures = activities.filter((activity) => activity.tone === "error" || activity.payload?.status === "failed").length;
  return (
    <details className="tool-activity">
      <summary>
        Tool activity <span className="tool-activity-count">· {activities.length} event{activities.length === 1 ? "" : "s"}</span>
        {failures > 0 && <span className="tool-activity-failures" title="Failed tool events; expand to inspect"> · {failures} failed</span>}
      </summary>
      <div className="tool-activity-events">
        {activities.map((activity) => <ActivityView key={activity.id} activity={activity} />)}
      </div>
    </details>
  );
}
