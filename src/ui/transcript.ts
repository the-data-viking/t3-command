import type { Activity, Message, OrchestrationThread } from "../t3/types";

type Entry =
  | { kind: "message"; at: string; message: Message }
  | { kind: "activity"; at: string; activity: Activity };

export type TranscriptEntry = Entry | { kind: "tools"; at: string; activities: Activity[] };

/** Collapse routine activity before limiting rows so tool-heavy turns retain their messages. */
export function transcriptEntries(thread: Pick<OrchestrationThread, "messages" | "activities">, limit = 120): TranscriptEntry[] {
  const entries: Entry[] = [
    ...thread.messages.map((message) => ({ kind: "message" as const, at: message.createdAt, message })),
    ...thread.activities
      .filter((activity) => activity.tone !== "info" || activity.kind.startsWith("task."))
      .map((activity) => ({ kind: "activity" as const, at: activity.createdAt, activity })),
  ];
  entries.sort((a, b) => a.at.localeCompare(b.at));

  const grouped: TranscriptEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "activity" &&
      (entry.activity.tone === "tool" || (entry.activity.tone === "info" && entry.activity.kind.startsWith("task."))) &&
      entry.activity.payload?.status !== "failed") {
      const previous = grouped[grouped.length - 1];
      if (previous?.kind === "tools" && previous.activities[0].turnId === entry.activity.turnId) {
        previous.activities.push(entry.activity);
      } else {
        grouped.push({ kind: "tools", at: entry.at, activities: [entry.activity] });
      }
    } else {
      grouped.push(entry);
    }
  }
  return grouped.slice(-limit);
}
