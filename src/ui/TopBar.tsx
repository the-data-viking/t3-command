import { useMemo } from "react";
import { worldRef } from "../game/world";
import { setMuted, useGame } from "../store";
import { allUnits } from "./util";
import { jumpTo } from "./hotkeys";

export function TopBar() {
  const envs = useGame((s) => s.envs);
  const muted = useGame((s) => s.muted);
  const counts = useMemo(() => {
    const c = { working: 0, alerts: 0, done: 0, hurt: 0, total: 0, camp: 0 };
    for (const u of allUnits(envs)) {
      c.total++;
      if (u.state === "working") c.working++;
      else if (u.state === "alert" || u.state === "question") c.alerts++;
      else if (u.state === "done") c.done++;
      else if (u.state === "error") c.hurt++;
      else if (u.state === "sleeping") c.camp++;
    }
    return c;
  }, [envs]);

  return (
    <header className="topbar">
      <div className="logo">T3 COMMAND</div>
      <div className="resources">
        <button className="resource" title="Working (cycle with W)" onClick={() => jumpTo("working")}>
          <span className="res-icon">⛏</span> {counts.working}
        </button>
        <button className={`resource ${counts.alerts ? "hot" : ""}`} title="Waiting on you (cycle with Space)" onClick={() => jumpTo("attention")}>
          <span className="res-icon">!</span> {counts.alerts}
        </button>
        <button className="resource" title="Reports ready (cycle with .)" onClick={() => jumpTo("done")}>
          <span className="res-icon">✓</span> {counts.done}
        </button>
        {counts.hurt > 0 && (
          <button className="resource warn" title="Hurt — last turn failed" onClick={() => jumpTo("error")}>
            <span className="res-icon">✖</span> {counts.hurt}
          </button>
        )}
        <span className="resource dim" title="Total workers / in camp">
          <span className="res-icon">☺</span> {counts.total - counts.camp}/{counts.total}
        </span>
      </div>
      <div className="spacer" />
      <div className="bases">
        {Object.values(envs).map((env) => (
          <span key={env.summary.id} className={`base-chip conn-${env.connection}`} title={env.error ?? env.connection}>
            ● {env.summary.label}
          </span>
        ))}
      </div>
      <button className="btn" onClick={() => useGame.setState({ showEnvManager: true })}>
        Bases
      </button>
      <button className="icon-btn" title="Fit view (F)" onClick={() => worldRef.current?.fitAll()}>
        ⤢
      </button>
      <button className="icon-btn" title={muted ? "Unmute" : "Mute"} onClick={() => setMuted(!muted)}>
        {muted ? "🔇" : "🔊"}
      </button>
    </header>
  );
}
