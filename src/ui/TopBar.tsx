import { useMemo } from "react";
import { sortedEnvs } from "../game/layout";
import { sfx } from "../game/sfx";
import { css, teamColor } from "../game/theme";
import { worldRef } from "../game/world";
import { setArtStyle, setMuted, useGame } from "../store";
import { isHistory, unitState } from "../t3/derive";
import { jumpTo } from "./hotkeys";
import { allUnits } from "./util";

export function TopBar() {
  const envs = useGame((s) => s.envs);
  const muted = useGame((s) => s.muted);
  const artStyle = useGame((s) => s.artStyle);
  const stations = useMemo(() => sortedEnvs(useGame.getState()), [envs]); // eslint-disable-line react-hooks/exhaustive-deps

  const totals = useMemo(() => {
    const c = { working: 0, monitoring: 0, attention: 0, done: 0, hurt: 0, crew: 0, awake: 0 };
    for (const u of allUnits(envs)) {
      c.crew++;
      if (u.state !== "sleeping") c.awake++;
      if (u.state === "working") c.working++;
      else if (u.state === "monitoring") c.monitoring++;
      else if (u.state === "alert" || u.state === "question") c.attention++;
      else if (u.state === "done") c.done++;
      else if (u.state === "error") c.hurt++;
    }
    return c;
  }, [envs]);

  return (
    <header className="topbar hud-frame">
      <div className="logo">
        T3<span className="logo-slash">//</span>COMMAND
      </div>
      <div className="resources">
        <button className="resource" title="Working now (W cycles)" onClick={() => jumpTo("working")}>
          <span className="res-key">ACTIVE</span> <span className="res-val cyan">{totals.working}</span>
        </button>
        <button className="resource" title="Monitoring background work (M cycles)" onClick={() => jumpTo("monitoring")}>
          <span className="res-key">MONITORING</span> <span className="res-val violet">{totals.monitoring}</span>
        </button>
        <button className={`resource ${totals.attention ? "hot" : ""}`} title="Waiting on you (Space cycles)" onClick={() => jumpTo("attention")}>
          <span className="res-key">ALERTS</span> <span className="res-val">{totals.attention}</span>
        </button>
        <button className="resource" title="Reports ready (. cycles)" onClick={() => jumpTo("done")}>
          <span className="res-key">REPORTS</span> <span className="res-val green">{totals.done}</span>
        </button>
        {totals.hurt > 0 && (
          <button className="resource" title="Last turn failed" onClick={() => jumpTo("error")}>
            <span className="res-key">FAILED</span> <span className="res-val orange">{totals.hurt}</span>
          </button>
        )}
        <span className="resource dim" title="Crew awake / total">
          <span className="res-key">CREW</span> <span className="res-val">
            {totals.awake}/{totals.crew}
          </span>
        </span>
      </div>
      <div className="spacer" />
      <nav className="stations">
        {stations.map((env, i) => {
          const units = Object.values(env.threads).filter((t) => !isHistory(t));
          const attention = units.filter((t) => ["alert", "question"].includes(unitState(t))).length;
          const working = units.filter((t) => unitState(t) === "working").length;
          return (
            <button
              key={env.summary.id}
              className={`station-chip conn-${env.connection} ${attention ? "hot" : ""}`}
              style={{ ["--team" as string]: css(teamColor(i)) }}
              title={`${env.summary.label} — ${env.connection}${env.error ? `: ${env.error}` : ""}`}
              onClick={() => {
                sfx.building();
                worldRef.current?.focusStation(env.summary.id);
              }}
            >
              <span className="chip-name">{env.summary.label}</span>
              {env.connection === "live" ? (
                <span className="chip-counts">
                  {working > 0 && <span className="cyan">{working}</span>}
                  {attention > 0 && <span className="red">!{attention}</span>}
                </span>
              ) : (
                <span className="chip-counts muted">{env.connection === "reconnecting" || env.connection === "connecting" ? "…" : "×"}</span>
              )}
            </button>
          );
        })}
      </nav>
      <button className="btn" onClick={() => useGame.setState({ showEnvManager: true })}>
        Stations
      </button>
      <button className="icon-btn" title="Fit fleet (F)" onClick={() => worldRef.current?.fitAll()}>
        ⤢
      </button>
      <button
        className="icon-btn style-toggle"
        title={artStyle === "kestrel" ? "Kestrel (light). Switch to Night Shift (dark)" : "Night Shift (dark). Switch to Kestrel (light)"}
        aria-label="Switch map style"
        onClick={() => setArtStyle(artStyle === "kestrel" ? "nightshift" : "kestrel")}
      >
        {artStyle === "kestrel" ? "☀" : "☾"}
      </button>
      <button className="icon-btn" title={muted ? "Unmute" : "Mute"} onClick={() => setMuted(!muted)}>
        {muted ? "🔇" : "🔊"}
      </button>
    </header>
  );
}
