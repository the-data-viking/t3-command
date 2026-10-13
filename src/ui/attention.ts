// Getting your attention when you're not looking at the map: a waiting count in the tab title,
// and desktop notifications for new approvals and questions while the tab isn't in view.

import { worldRef } from "../game/world";
import { addLog, setSelection, useGame, type EnvWorld } from "../store";
import { isHistory, unitState } from "../t3/derive";
import { quietness } from "../t3/progress";
import { elapsed } from "../t3/timing";
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

/**
 * Once per turn, a comms entry (and a desktop notification, if enabled and the tab isn't in
 * view) when a followed crew member's running turn goes quiet. Returns a function to stop.
 */
export function installQuietWatch(): () => void {
  const announced = new Set<string>();
  const timer = setInterval(() => announceQuiet(announced, Date.now()), 30_000);
  return () => clearInterval(timer);
}

/** One pass of the quiet watch; `announced` remembers which turns were already called out. */
export function announceQuiet(announced: Set<string>, now: number): void {
  const state = useGame.getState();
  for (const [key, detail] of Object.entries(state.details)) {
    const thread = detail.thread;
    const env = Object.values(state.envs).find((e) => key === `${e.summary.id}:${thread.id}`);
    const shell = env?.threads[thread.id];
    if (!env || !shell || isHistory(shell) || env.connection !== "live") continue;
    const quiet = quietness(shell, thread, now);
    const mark = `${key}:${thread.latestTurn?.turnId}`;
    if (quiet?.kind !== "quiet" || announced.has(mark)) continue;
    announced.add(mark);
    const text = `${shell.title || "Untitled"} has had no activity for ${elapsed(quiet.ms)}`;
    addLog({ tone: "alert", text, envId: env.summary.id, threadId: thread.id });
    if (!state.notify || typeof Notification === "undefined" || Notification.permission !== "granted" || (!document.hidden && document.hasFocus())) continue;
    const notification = new Notification("Turn gone quiet", { body: `${text} · ${env.summary.label}`, tag: `quiet:${mark}` });
    notification.onclick = () => {
      window.focus();
      const sel = { kind: "unit" as const, envId: env.summary.id, threadId: thread.id };
      setSelection(sel);
      worldRef.current?.focus(sel);
      notification.close();
    };
  }
}
