// Keeps live thread subscriptions open for crew who are working or waiting on you, so the map
// can show what they're actually doing (telemetry), and for crew with a standing order queued, so
// their reply can be read: one that says NOTHING LEFT stops the repeats. Everyone else only needs
// the shell.

import { NOTHING_LEFT } from "../../shared/followups";
import { addLog, unitKey, useGame, type GameState } from "../store";
import { envClient, logError } from "../t3/environment";
import { cancelFollowUp } from "../t3/followups";
import { isHistory, unitState } from "../t3/derive";

const ACTIVE = new Set(["working", "monitoring", "alert", "question"]);
/** Upper bound on automatic subscriptions, so a huge fleet can't open hundreds of streams. */
const MAX_WATCHED = 40;

/** The agent's reply ends with NOTHING LEFT on its own line (quoting the instruction mid-reply doesn't count). */
export function saysNothingLeft(text: string): boolean {
  const lines = text.trim().split("\n").map((l) => l.replace(/[*_`.!"'\s]/g, "").toUpperCase()).filter(Boolean);
  return lines[lines.length - 1] === NOTHING_LEFT.replace(/\s/g, "");
}

export function installActiveWatches(): () => void {
  const watching = new Map<string, () => void>();

  const sync = (state: GameState) => {
    const wanted = new Map<string, { envId: string; threadId: string }>();
    // Standing orders first: their replies decide whether they go again.
    for (const f of state.followUps.queued) {
      if (f.total && state.envs[f.envId]?.connection === "live") wanted.set(unitKey(f.envId, f.threadId), { envId: f.envId, threadId: f.threadId });
    }
    for (const env of Object.values(state.envs)) {
      if (env.connection !== "live") continue;
      for (const t of Object.values(env.threads)) {
        if (wanted.size >= MAX_WATCHED) break;
        if (!isHistory(t) && ACTIVE.has(unitState(t))) wanted.set(unitKey(env.summary.id, t.id), { envId: env.summary.id, threadId: t.id });
      }
    }
    for (const [key, stop] of watching) {
      if (wanted.has(key)) continue;
      stop();
      watching.delete(key);
    }
    for (const [key, { envId, threadId }] of wanted) {
      if (watching.has(key)) continue;
      const stop = envClient(envId)?.watchThread(threadId);
      if (stop) watching.set(key, stop);
    }
  };

  // A standing order whose last turn ended with the agent saying NOTHING LEFT: cancel the rest
  // (the server waits a moment after each clean turn before repeating, for exactly this).
  const stopped = new Set<string>();
  const checkStanding = (state: GameState) => {
    for (const f of state.followUps.queued) {
      if (!f.total || stopped.has(f.id)) continue;
      const thread = state.envs[f.envId]?.threads[f.threadId];
      const turn = thread?.latestTurn;
      if (!turn || turn.state !== "completed" || turn.turnId !== f.afterTurnId) continue;
      const last = [...(state.details[unitKey(f.envId, f.threadId)]?.thread.messages ?? [])].reverse().find((m) => m.role === "assistant" && m.turnId === turn.turnId && m.text.trim());
      if (!last || !saysNothingLeft(last.text)) continue;
      stopped.add(f.id);
      void cancelFollowUp(f.id)
        .then(() => addLog({ tone: "info", text: `Standing order for "${thread!.title || "Untitled"}" stopped: it said there's nothing left to do`, envId: f.envId, threadId: f.threadId }))
        .catch((err) => { stopped.delete(f.id); logError("Couldn't stop the standing order", err); });
    }
  };

  sync(useGame.getState());
  const unsubscribe = useGame.subscribe((s, prev) => {
    if (s.envs !== prev.envs || s.followUps !== prev.followUps) sync(s);
    if (s.details !== prev.details || s.followUps !== prev.followUps || s.envs !== prev.envs) checkStanding(s);
  });
  return () => {
    unsubscribe();
    for (const stop of watching.values()) stop();
    watching.clear();
  };
}
