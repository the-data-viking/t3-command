// A single policy for thread interruptions, shared by the browser and Web Push.
import type { CommandPrefs } from "./prefs.ts";
import { isSubagent } from "../src/t3/derive.ts";
import type { ThreadShell } from "../src/t3/types.ts";

export function threadNotificationsEnabled(prefs: Pick<CommandPrefs, "mutedThreads"> | undefined, envId: string, thread: ThreadShell): boolean {
  return !isSubagent(thread) && !prefs?.mutedThreads?.[`${envId}:${thread.id}`];
}
