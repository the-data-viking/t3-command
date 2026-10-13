import { useEffect } from "react";
import { openEvent, useGame } from "../store";
import { STATE_LABELS } from "./util";
import { unitState } from "../t3/derive";

const SHOW_MS = 4000;

/**
 * A request that arrived just as you pressed a number key: a short notice instead of the event
 * card, which would otherwise have taken that keypress as a choice. Click it (or press Space) to
 * open the card.
 */
export function IncomingToast() {
  const incoming = useGame((s) => s.incoming);
  const thread = useGame((s) => (incoming ? s.envs[incoming.envId]?.threads[incoming.threadId] : undefined));

  useEffect(() => {
    if (!incoming) return;
    const timer = setTimeout(() => {
      if (useGame.getState().incoming === incoming) useGame.setState({ incoming: null });
    }, SHOW_MS);
    return () => clearTimeout(timer);
  }, [incoming]);

  if (!incoming || !thread) return null;
  const state = unitState(thread);
  return (
    <button className="incoming-toast hud-frame" onClick={() => openEvent({ envId: incoming.envId, threadId: incoming.threadId })}>
      <span className={`pill state-${state}`}>{STATE_LABELS[state]}</span>
      <span className="incoming-title">{thread.title || "A crew member"}</span>
      <span className="muted small">Space or click to open</span>
    </button>
  );
}
