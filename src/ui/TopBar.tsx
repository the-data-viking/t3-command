import { useEffect, useMemo, useRef, useState } from "react";
import { sortedEnvs } from "../game/layout";
import { sfx } from "../game/sfx";
import { css, teamColor } from "../game/theme";
import { worldRef } from "../game/world";
import { openHost, setSelection, setArtStyle, setMuted, useGame, setNotify } from "../store";
import { hostView } from "../t3/host";
import { isHistory, unitState } from "../t3/derive";
import { jumpTo } from "./hotkeys";
import { allUnits } from "./util";
import { SpendTelemetry } from "./SpendTelemetry";
import { LimitsTelemetry } from "./LimitsTelemetry";
import { UpdatePanel } from "./UpdatePanel";
import { HermesMark } from './HermesControlCenter';
import { botOperators } from '../t3/bots';
import { PixelIcon } from "./PixelArt";
import { usePhone } from "./phone";

export function TopBar() {
  const bar = useRef<HTMLElement>(null);
  const envs = useGame((s) => s.envs);
  const hosts = useGame((s) => s.hosts);
  const muted = useGame((s) => s.muted);
  const notify = useGame((s) => s.notify);
  const showLog = useGame((s) => s.showLog);
  const artStyle = useGame((s) => s.artStyle);
  const hermesCatalog = useGame(s => s.hermesCatalog);
  const hermes = Object.values(envs).filter(e => e.summary.kind === 'hermes');
  const operators = botOperators({ envs, hermesCatalog });
  const stations = useMemo(() => sortedEnvs(useGame.getState()), [envs]); // eslint-disable-line react-hooks/exhaustive-deps
  const phone = usePhone();
  // On phones everything past the counters lives in a menu under the bar.
  const [menu, setMenu] = useState(false);
  const menuOpen = phone && menu;

  useEffect(() => {
    const element = bar.current;
    if (!element) return;
    const measure = () => document.documentElement.style.setProperty("--topbar-bottom", `${Math.ceil(element.getBoundingClientRect().bottom) + 8}px`);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => { observer.disconnect(); document.documentElement.style.removeProperty("--topbar-bottom"); };
  }, []);

  const totals = useMemo(() => {
    const c = { working: 0, monitoring: 0, attention: 0, done: 0, hurt: 0, crew: 0, awake: 0 };
    for (const u of allUnits(envs)) {
      if (envs[u.envId]?.summary.kind !== 'hermes') {
        c.crew++;
        if (u.state !== "sleeping") c.awake++;
      }
      if (u.state === "working") c.working++;
      else if (u.state === "monitoring") c.monitoring++;
      else if (u.state === "alert" || u.state === "question") c.attention++;
      else if (u.state === "done") c.done++;
      else if (u.state === "error") c.hurt++;
    }
    return c;
  }, [envs]);

  return (
    <header ref={bar} className={`topbar hud-frame ${menuOpen ? "menu-open" : ""}`}>
      <div className="logo">
        T3<span className="logo-slash">//</span>{phone ? "C" : "COMMAND"}
      </div>
      <div className="resources">
        <button className="resource" title="Working now (W cycles)" onClick={() => jumpTo("working")}>
          <span className="res-key" data-short="ACT">ACTIVE</span> <span className="res-val cyan">{totals.working}</span>
        </button>
        <button className="resource optional" title="Monitoring background work (M cycles)" onClick={() => jumpTo("monitoring")}>
          <span className="res-key">MONITORING</span> <span className="res-val violet">{totals.monitoring}</span>
        </button>
        <button className={`resource ${totals.attention ? "hot" : ""}`} title="Waiting on you (Space cycles)" onClick={() => jumpTo("attention")}>
          <span className="res-key" data-short="ALERT">ALERTS</span> <span className="res-val">{totals.attention}</span>
        </button>
        <button className="resource" title="Reports ready (. cycles)" onClick={() => jumpTo("done")}>
          <span className="res-key" data-short="RPT">REPORTS</span> <span className="res-val green">{totals.done}</span>
        </button>
        {totals.hurt > 0 && (
          <button className="resource" title="Last turn failed" onClick={() => jumpTo("error")}>
            <span className="res-key" data-short="FAIL">FAILED</span> <span className="res-val orange">{totals.hurt}</span>
          </button>
        )}
        <span className="resource dim optional" title="Crew awake / total">
          <span className="res-key">CREW</span> <span className="res-val">
            {totals.awake}/{totals.crew}
          </span>
        </span>
      </div>
      {phone && <button className="icon-btn menu-btn" aria-expanded={menuOpen} aria-controls="topbar-more" aria-label={menuOpen ? "Close menu" : "Open menu"}
        title="Menu" onClick={() => setMenu(!menu)}><PixelIcon name="menu" /></button>}
      {/* Going somewhere from the phone menu closes it, so the map or panel it opens is in view;
          toggles and the spend, limits and update popovers keep it open. */}
      <div id="topbar-more" className="topbar-more" onClick={(e) => { if (phone && (e.target as HTMLElement).closest(".station-chip, .operations-chip, .menu-closes")) setMenu(false); }}>
      <SpendTelemetry />
      <LimitsTelemetry />
      <div className="spacer" />
      <nav className="stations">
        {stations.map((env, i) => {
          const units = Object.values(env.threads).filter((t) => !isHistory(t));
          const attention = units.filter((t) => ["alert", "question"].includes(unitState(t))).length;
          const working = units.filter((t) => unitState(t) === "working").length;
          if (env.summary.kind === 'hermes') return null;
          const resources = hostView(hosts[env.summary.id], env.connection);
          const description = `${env.summary.label} — ${env.connection}${env.error ? `: ${env.error}` : ""} · CPU ${resources.cpuFraction === undefined ? "unavailable" : `${Math.round(resources.cpuFraction * 100)}%`} · RAM ${resources.memoryFraction === undefined ? "unavailable" : `${Math.round(resources.memoryFraction * 100)}% used`}${resources.stale ? " · stale sample" : ""}`;
          return (
            <button
              key={env.summary.id}
              className={`station-chip conn-${env.connection} ${attention ? "hot" : ""}`}
              style={{ ["--team" as string]: css(teamColor(i)) }}
              title={description}
              aria-label={`${description}. Open engineering details`}
              onClick={() => {
                sfx.building();
                openHost(env.summary.id);
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
      {hermes.length > 0 && <button className={`btn operations-chip ${operators.some(b => b.state === 'alert' || b.state === 'question') ? 'hot' : ''}`}
        title="Hermes control center — persistent operators, memory and routines" onClick={() => {
          const envId = hermesCatalog?.envId ?? hermes[0].summary.id;
          setSelection({ kind: 'hermes', envId }); worldRef.current?.focusStation(envId);
        }}><HermesMark /><span>Hermes <span className="muted">{operators.length}</span></span></button>}
      <button className="btn menu-closes" onClick={() => useGame.setState({ showEnvManager: true })}>
        Stations
      </button>
      <button className="btn menu-closes" title="Comms log (L)" aria-expanded={showLog} onClick={() => useGame.setState({ showLog: !showLog })}>
        Log
      </button>
      <button className="btn menu-closes" title="Turn and spend history (H)" onClick={() => useGame.setState({ showHistory: true })}>
        History
      </button>
      <UpdatePanel />
      <button className="icon-btn menu-closes" title="Fit fleet (F)" aria-label="Fit fleet" onClick={() => worldRef.current?.fitAll()}>
        <PixelIcon name="fit" /><span className="phone-label">Fit fleet</span>
      </button>
      <button
        className="icon-btn style-toggle"
        title={artStyle === "flightdeck" ? "Flight Deck (warm). Switch to Night Shift" : "Flight Deck · Night Shift. Switch to warm plating"}
        aria-label="Switch map style"
        onClick={() => setArtStyle(artStyle === "flightdeck" ? "flightdeck-nightshift" : "flightdeck")}
      >
        <PixelIcon name={artStyle === "flightdeck" ? "sun" : "moon"} /><span className="phone-label">{artStyle === "flightdeck" ? "Warm" : "Night shift"}</span>
      </button>
      {typeof Notification !== "undefined" && (
        <button className="icon-btn" aria-pressed={notify} onClick={() => void setNotify(!notify)}
          title={notify ? "Desktop alerts on: approvals and questions notify you while this tab isn't in view" : "Turn on desktop alerts for approvals and questions"}
          aria-label={notify ? "Turn off desktop alerts" : "Turn on desktop alerts"}>
          <PixelIcon name={notify ? "bell" : "bellOff"} /><span className="phone-label">{notify ? "Alerts on" : "Alerts off"}</span>
        </button>
      )}
      <button className="icon-btn" title={muted ? "Unmute" : "Mute"} aria-label={muted ? "Unmute" : "Mute"} onClick={() => setMuted(!muted)}>
        <PixelIcon name={muted ? "muted" : "sound"} /><span className="phone-label">{muted ? "Muted" : "Sound"}</span>
      </button>
      </div>
    </header>
  );
}
