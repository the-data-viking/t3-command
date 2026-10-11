import { useEffect, useState } from "react";
import { sfx } from "../game/sfx";
import { worldRef } from "../game/world";
import { setSelection, useGame } from "../store";

const VISIBLE_MS = 12_000;

export function EventLog() {
  const log = useGame((s) => s.log);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const recent = log.filter((e) => now - e.at < VISIBLE_MS).slice(-6);
  return (
    <div className="event-log">
      {recent.map((e) => (
        <button
          key={e.id}
          className={`log-line tone-${e.tone}`}
          style={{ opacity: Math.min(1, (VISIBLE_MS - (now - e.at)) / 3000) }}
          disabled={!e.envId || !e.threadId}
          onClick={() => {
            if (!e.envId || !e.threadId) return;
            const sel = { kind: "unit" as const, envId: e.envId, threadId: e.threadId };
            sfx.select();
            setSelection(sel);
            worldRef.current?.focus(sel);
          }}
        >
          {e.text}
        </button>
      ))}
    </div>
  );
}
