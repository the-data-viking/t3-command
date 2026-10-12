// Getting your attention when you're not looking at the map: a waiting count in the tab title,
// and desktop notifications for new approvals and questions while the tab isn't in view.

import { worldRef } from "../game/world";
import { setSelection, useGame, type EnvWorld } from "../store";
import { isHistory, unitState } from "../t3/derive";
import type { ThreadShell } from "../t3/types";

const TITLE = "T3 Command";

/** Crew waiting on you (approvals and questions) across the fleet. */
export function attentionCount(envs: Record<string, EnvWorld>): number {
  let count = 0;
  for (const env of Object.values(envs)) {
    for (const thread of Object.values(env.threads)) {
      if (isHistory(thread)) continue;
      const state = unitState(thread);
      if (state === "alert" || state === "question") count++;
    }
  }
  return count;
}

export function titleFor(count: number): string {
  return count ? `(${count}) ${TITLE}` : TITLE;
}

/** Keep the tab title showing how many crew are waiting. Returns a function to stop. */
export function installTitleBadge(): () => void {
  const update = () => { document.title = titleFor(attentionCount(useGame.getState().envs)); };
  update();
  return useGame.subscribe((s, prev) => { if (s.envs !== prev.envs) update(); });
}

/** A desktop notification for an approval or question, if enabled and the tab isn't in view. */
export function notifyAttention(envId: string, thread: ThreadShell, kind: "alert" | "question"): void {
  if (!useGame.getState().notify || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (!document.hidden && document.hasFocus()) return;
  const station = useGame.getState().envs[envId]?.summary.label ?? "";
  const notification = new Notification(kind === "alert" ? "Approval needed" : "Question waiting", {
    body: `${thread.title || "Untitled"}${station ? ` · ${station}` : ""}`,
    tag: `${envId}:${thread.id}`,
  });
  notification.onclick = () => {
    window.focus();
    const sel = { kind: "unit" as const, envId, threadId: thread.id };
    setSelection(sel);
    worldRef.current?.focus(sel);
    notification.close();
  };
}
