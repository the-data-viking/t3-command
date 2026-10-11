import { useMemo, useState } from "react";
import { stationColor } from "../game/layout";
import { sfx } from "../game/sfx";
import { css } from "../game/theme";
import { worldRef } from "../game/world";
import { setSelection, useGame } from "../store";
import type { UnitState } from "../t3/derive";
import { allUnits, timeAgo, type UnitRef } from "./util";

const PRIORITY: Partial<Record<UnitState, number>> = { alert: 0, question: 1, error: 2, done: 3 };
const VERB: Partial<Record<UnitState, string>> = {
  alert: "NEEDS APPROVAL",
  question: "HAS A QUESTION",
  error: "TURN FAILED",
  done: "REPORT READY",
};

/** The queue of everything across the fleet that's waiting on the commander. */
export function NeedsYou() {
  const envs = useGame((s) => s.envs);
  const selection = useGame((s) => s.selection);
  const [collapsed, setCollapsed] = useState(false);

  const queue = useMemo(
    () =>
      allUnits(envs)
        .filter((u) => PRIORITY[u.state] !== undefined)
        .sort((a, b) => PRIORITY[a.state]! - PRIORITY[b.state]! || b.thread.updatedAt.localeCompare(a.thread.updatedAt)),
    [envs],
  );
  const urgent = queue.filter((u) => u.state === "alert" || u.state === "question").length;

  const open = (u: UnitRef) => {
    sfx.select();
    const sel = { kind: "unit" as const, envId: u.envId, threadId: u.thread.id };
    setSelection(sel);
    worldRef.current?.focus(sel);
  };

  return (
    <aside className={`needs-you hud-frame ${collapsed ? "collapsed" : ""}`}>
      <button className="hud-label needs-head" onClick={() => setCollapsed(!collapsed)}>
        INBOX <span className={urgent ? "count hot" : "count"}>{queue.length}</span>
        <span className="spacer" />
        <span className="muted">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <ol className="needs-list">
          {queue.length === 0 && <li className="muted small empty">All quiet. Nothing is waiting on you.</li>}
          {queue.map((u) => {
            const env = envs[u.envId];
            const active = selection?.kind === "unit" && selection.envId === u.envId && selection.threadId === u.thread.id;
            return (
              <li key={`${u.envId}:${u.thread.id}`}>
                <button className={`needs-row state-border-${u.state} ${active ? "active" : ""}`} onClick={() => open(u)}>
                  <span className="team-dot" style={{ background: css(stationColor(useGame.getState(), u.envId)) }} />
                  <span className="needs-text">
                    <span className={`needs-verb verb-${u.state}`}>{VERB[u.state]}</span>
                    <span className="needs-title">{u.thread.title || "Untitled"}</span>
                    <span className="muted small">
                      {env?.summary.label} · {env?.projects[u.thread.projectId]?.title ?? "?"} · {timeAgo(u.thread.updatedAt)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}
