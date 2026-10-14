// Buttons for a failed turn's next step (see failed.ts): on the work board and in the crew panel.

import { useState } from "react";
import { unitKey, useGame } from "../store";
import type { ThreadShell } from "../t3/types";
import { answerFailure, fixOrder, lastOrder } from "./failed";

/** A failed card's next step: ask it to fix the cause, or send its last order again. */
export function FailedActions({ envId, thread, className = "btn small board-card-act" }: { envId: string; thread: ThreadShell; className?: string }) {
  const detail = useGame((s) => s.details[unitKey(envId, thread.id)]);
  const [busy, setBusy] = useState(false);
  const live = useGame((s) => s.envs[envId]?.connection === "live");
  const again = lastOrder(detail);
  const act = (text: string, what: string) => { setBusy(true); void answerFailure(envId, thread, text, what).finally(() => setBusy(false)); };
  return (
    <span className="failed-actions">
      <button className={className} disabled={busy || !live} title={`Sends: "${fixOrder(thread)}"`} onClick={() => act(fixOrder(thread), "fix order")}>Fix it</button>
      <button className={className} disabled={busy || !live || !again} title={again ? `Sends its last order again: "${again.slice(0, 200)}"` : "Its last order isn't loaded yet"}
        onClick={() => again && act(again, "retry")}>Retry</button>
    </span>
  );
}
