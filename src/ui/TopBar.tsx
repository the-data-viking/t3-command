import { useEffect, useMemo, useRef, useState } from "react";
import { DispatchChip } from "./Dispatches";
import { QueueButton } from "./QueueButton";
import { sortedEnvs } from "../game/layout";
import { sfx } from "../game/sfx";
import { css, hudAccent, teamColor } from "../game/theme";
import { worldRef } from "../game/world";
import { openHost, setSelection, useGame } from "../store";
import { hostView } from "../t3/host";
import { isHistory, unitState } from "../t3/derive";
import { jumpTo } from "./hotkeys";
import { fleetCounts } from "./util";
import { SpendTelemetry } from "./SpendTelemetry";
import { LimitsTelemetry } from "./LimitsTelemetry";
import { UpdatePanel } from "./UpdatePanel";
import { HermesMark } from './HermesControlCenter';
import { botOperators } from '../t3/bots';
import { PixelIcon } from "./PixelArt";
import { usePhone } from "./phone";
import { ThemePicker } from "./ThemePicker";
import { SoundMenu } from "./SoundMenu";
import { AlertsMenu } from "./AlertsMenu";
import { MoreMenu } from "./MoreMenu";

export function TopBar() {
  const bar = useRef<HTMLElement>(null);
  const artStyle = useGame((s) => s.artStyle);
  const envs = useGame((s) => s.envs);
  const hosts = useGame((s) => s.hosts);
  const showLog = useGame((s) => s.showLog);
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

  const readReports = useGame((s) => s.readReports);
  const counts = useMemo(() => fleetCounts(envs, readReports), [envs, readReports]);
  const totals = { working: counts.working + counts.background, monitoring: counts.monitoring, crew: counts.crew, awake: counts.awake };

  const views = (
    <>
      <button className="btn menu-closes" role={phone ? undefined : "menuitem"} title="Comms log (L)" aria-expanded={showLog} onClick={() => useGame.setState({ showLog: !showLog })}>
        Log
      </button>
      <button className="btn menu-closes" role={phone ? undefined : "menuitem"} title="Turn and spend history (H)" onClick={() => useGame.setState({ showHistory: true })}>
        History
      </button>
      <button className="btn menu-closes" role={phone ? undefined : "menuitem"} title="The T3 machines in the fleet: add, pair, remove" onClick={() => useGame.setState({ showEnvManager: true })}>
        Machines
      </button>
    </>
  );

  return (
    <header ref={bar} className={`topbar hud-frame ${menuOpen ? "menu-open" : ""}`}>
      <div className="logo">
        T3<span className="logo-slash">//</span>{phone ? "" : "COMMAND"}
      </div>
      <div className="resources">
        <button className="resource" title="Working now (W cycles)" onClick={() => jumpTo("working")}>
          <span className="res-key" data-short="ACT">ACTIVE</span> <span className="res-val count-working">{totals.working}</span>
        </button>
        <button className="resource optional" title="Monitoring background work (M cycles)" onClick={() => jumpTo("monitoring")}>
          <span className="res-key">MONITORING</span> <span className="res-val violet">{totals.monitoring}</span>
        </button>
        {/* Approvals, questions, reports and failures are one count: Needs you, beside these. */}
        <DispatchChip />
        <span className="resource dim optional" title="Crew awake / total">
          <span className="res-key">CREW</span> <span className="res-val">
            {totals.awake}/{totals.crew}
          </span>
        </span>
      </div>
      <QueueButton />
      {phone && <button className="icon-btn menu-btn" aria-expanded={menuOpen} aria-controls="topbar-more" aria-label={menuOpen ? "Close menu" : "Open menu"}
        title="Menu" onClick={() => setMenu(!menu)}><PixelIcon name="menu" /></button>}
      {/* Going somewhere from the phone menu closes it, so the map or panel it opens is in view;
          toggles and the spend, limits and update popovers keep it open. */}
      <div id="topbar-more" className="topbar-more" onClick={(e) => { if (phone && (e.target as HTMLElement).closest(".station-chip, .operations-chip, .menu-closes")) setMenu(false); }}>
      <SpendTelemetry />
      <LimitsTelemetry />
      <div className="spacer" />
      {/* Desktop keeps two rows: counters and tools, then machines and work views. */}
      <div className="topbar-break" aria-hidden />
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
              style={{ ["--team" as string]: css(hudAccent(teamColor(i), artStyle)) }}
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
                  {working > 0 && <span className="count-working">{working}</span>}
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
      <button className="btn menu-closes new-request-btn" title="New request: start a crew member on any project (N)" onClick={() => useGame.setState({ showNewRequest: true })}>
        + New
      </button>
      {/* The work views, in view rather than behind a key. */}
      <button className="btn menu-closes" title="Work board: every crew member's work, missions and orders (B)" onClick={() => useGame.setState({ showBoard: true })}>
        Board
      </button>
      <button className="btn menu-closes" title="Shipping dock: every open PR, by how ready it is to merge (D)" onClick={() => useGame.setState({ showDock: true })}>
        Dock
      </button>
      <button className="btn menu-closes" title="Fleet timeline: every crew member's turns (T)" onClick={() => useGame.setState({ showTimeline: true })}>
        Timeline
      </button>
      {phone ? views : <MoreMenu>{views}</MoreMenu>}
      <UpdatePanel />
      {phone && <button className="btn menu-closes" onClick={() => useGame.setState({ showPalette: true })}>Search</button>}
      {phone && <button className="btn menu-closes" onClick={() => useGame.setState({ showHelp: true })}>Help</button>}
      <button className="icon-btn menu-closes" title="Fit fleet (F)" aria-label="Fit fleet" onClick={() => worldRef.current?.fitAll()}>
        <PixelIcon name="fit" /><span className="phone-label">Fit fleet</span>
      </button>
      <ThemePicker />
      {/* Always shown: on an iPhone before Add to Home Screen it explains how to get push. */}
      <AlertsMenu />
      <SoundMenu />
      </div>
    </header>
  );
}
