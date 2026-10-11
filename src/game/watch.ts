// Keeps live thread subscriptions open for crew who are working or waiting on you, so the map
// can show what they're actually doing (telemetry). Everyone else only needs the shell.

import { unitKey, useGame, type GameState } from "../store";
import { envClient } from "../t3/environment";
import { isHistory, unitState } from "../t3/derive";

const ACTIVE = new Set(["working", "alert", "question"]);
/** Upper bound on automatic subscriptions, so a huge fleet can't open hundreds of streams. */
const MAX_WATCHED = 40;

export function installActiveWatches(): () => void {
  const watching = new Map<string, () => void>();

  const sync = (state: GameState) => {
    const wanted = new Map<string, { envId: string; threadId: string }>();
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

  sync(useGame.getState());
  const unsubscribe = useGame.subscribe((s, prev) => {
    if (s.envs !== prev.envs) sync(s);
  });
  return () => {
    unsubscribe();
    for (const stop of watching.values()) stop();
    watching.clear();
  };
}
