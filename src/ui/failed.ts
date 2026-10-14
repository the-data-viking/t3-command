// A failed turn always has a next step: ask the crew member to find and fix the cause, or send the
// order that started it again. Used by the report card, the work board and the crew panel.

import { sfx } from "../game/sfx";
import { markReportsRead, type ThreadDetail } from "../store";
import { envClient, logError } from "../t3/environment";
import type { ThreadShell } from "../t3/types";

/** The order that asks a crew member to find and fix why their last turn failed. */
export function fixOrder(thread: ThreadShell): string {
  const error = thread.session?.lastError?.trim();
  return `Your last turn failed${error ? `: ${error.split("\n")[0].slice(0, 300)}` : ""}. Find the cause, fix it, and tell me what you changed and how you verified it.`;
}

/** The last order the crew member was given (to send again), if its messages are loaded. */
export function lastOrder(detail: ThreadDetail | undefined): string | undefined {
  return [...(detail?.thread.messages ?? [])].reverse().find((m) => m.role === "user" && m.text.trim())?.text.trim();
}

/** Send `text` to a crew member whose turn failed; the failure leaves Needs you once it's answered. */
export async function answerFailure(envId: string, thread: ThreadShell, text: string, what: string): Promise<boolean> {
  try {
    await envClient(envId)?.order(thread.id, text);
    sfx.order();
    if (thread.latestTurn) markReportsRead([{ envId, threadId: thread.id, turnId: thread.latestTurn.turnId }]);
    return true;
  } catch (err) {
    sfx.error();
    logError(`Couldn't send the ${what}`, err);
    return false;
  }
}
