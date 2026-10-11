import type { Activity } from "../t3/types";

export function ActivityView({ activity }: { activity: Activity }) {
  const failed = activity.tone === "error" || activity.payload?.status === "failed";
  const icon = failed ? "✖" : activity.tone === "approval" ? "⚑" : activity.kind.startsWith("task.") ? "◆" : "⚒";
  return (
    <div className={`activity tone-${failed ? "error" : activity.tone}`} title={activity.kind}>
      <span className="activity-icon">{icon}</span> {activity.summary}
    </div>
  );
}

export function ToolActivityGroup({ activities }: { activities: Activity[] }) {
  return (
    <details className="tool-activity">
      <summary>Tool activity <span className="tool-activity-count">· {activities.length} event{activities.length === 1 ? "" : "s"}</span></summary>
      <div className="tool-activity-events">
        {activities.map((activity) => <ActivityView key={activity.id} activity={activity} />)}
      </div>
    </details>
  );
}
