import { useEffect, useMemo, useRef, useState } from "react";
import { stationColor } from "../game/layout";
import { sfx } from "../game/sfx";
import { contextLevel, css, hudAccent, modelTier, TIER_LABEL } from "../game/theme";
import { worldRef } from "../game/world";
import { openEvent, setSelection, toggleSquad, unitKey, useGame } from "../store";
import { squadKeys } from "./squad";
import type { UnitState } from "../t3/derive";
import { telemetry } from "../t3/telemetry";
import { allUnits, fleetCounts, isBackground, reportRead, stateLabel, type UnitRef } from "./util";
import { ThreadTiming } from "./ThreadTiming";
import { PlanLine } from "./TurnTelemetry";
import { botOperators, BOT_STATE_LABELS } from '../t3/bots';
import { BotPortrait } from './HermesControlCenter';
import { CrewPortrait, PixelLabel } from "./PixelArt";
import { isPhone, usePhone } from "./phone";

const NEEDS_YOU: UnitState[] = ["alert", "question", "error", "done"];
const ON_DUTY: UnitState[] = ["working", "monitoring", "idle"];
const ORDER: UnitState[] = [...NEEDS_YOU, ...ON_DUTY];

/** FTL-style crew list: who needs you first, then who's on duty. Settled crew stay in quarters. */
export function CrewRoster() {
  useGame((s) => s.artStyle); // Re-render on theme change: team and bot colours deepen on light HUDs.
  const envs = useGame((s) => s.envs);
  const details = useGame((s) => s.details);
  const selection = useGame((s) => s.selection);
  const hermesCatalog = useGame(s => s.hermesCatalog);
  const operators = botOperators({ envs, hermesCatalog });
  const phone = usePhone();
  // On phones the roster is a dock along the bottom, closed until asked for so the map shows.
  const [collapsed, setCollapsed] = useState(isPhone);
  const pick = () => { if (phone) setCollapsed(true); };

  const crew = useMemo(
    () =>
      allUnits(envs)
        .filter((u) => u.state !== "sleeping" && envs[u.envId]?.summary.kind !== 'hermes')
        // Stable within each group (newest recruit first), so rows don't shuffle under the cursor
        // as crew report activity; a row only moves when its state group changes.
        .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || b.thread.createdAt.localeCompare(a.thread.createdAt) || a.thread.id.localeCompare(b.thread.id)),
    [envs],
  );
  // Rows that just changed group flash briefly, so the move is noticed rather than surprising.
  const groups = useRef(new Map<string, UnitState>());
  const [moved, setMoved] = useState<Set<string>>(new Set());
  useEffect(() => {
    const changed: string[] = [];
    for (const u of crew) {
      const key = unitKey(u.envId, u.thread.id);
      const before = groups.current.get(key);
      if (before !== undefined && before !== u.state) changed.push(key);
      groups.current.set(key, u.state);
    }
    if (!changed.length) return;
    setMoved((m) => new Set([...m, ...changed]));
    const timer = setTimeout(() => setMoved((m) => new Set([...m].filter((k) => !changed.includes(k)))), 1600);
    return () => clearTimeout(timer);
  }, [crew]);
  const waiting = fleetCounts(envs).waiting;
  const readReports = useGame((s) => s.readReports);
  // A report marked read waits with the crew on duty until its thread's next turn.
  const read = (u: UnitRef) => u.state === "done" && reportRead(readReports, u.envId, u.thread);
  const needsYou = crew.filter((u) => NEEDS_YOU.includes(u.state) && !read(u));
  const onDuty = crew.filter((u) => ON_DUTY.includes(u.state) || read(u));
  const urgent = crew.filter((u) => u.state === "alert" || u.state === "question").length
    + operators.filter(b => b.state === 'alert' || b.state === 'question').length;

  const squad = useGame((s) => s.squad);
  const picked = squadKeys(squad);

  const open = (u: UnitRef, e?: React.MouseEvent) => {
    // Shift-click builds a squad for batch actions instead of opening one crew member.
    if (e?.shiftKey) { sfx.select(); toggleSquad({ envId: u.envId, threadId: u.thread.id }); return; }
    pick();
    sfx.select();
    const sel = { kind: "unit" as const, envId: u.envId, threadId: u.thread.id };
    setSelection(sel);
    worldRef.current?.focus(sel);
    if (u.state === "alert" || u.state === "question") openEvent({ envId: u.envId, threadId: u.thread.id });
  };

  const row = (u: UnitRef) => {
    const key = unitKey(u.envId, u.thread.id);
    const detail = details[key];
    const ctx = detail ? telemetry(detail.thread).context : undefined;
    const team = css(hudAccent(stationColor(useGame.getState(), u.envId), useGame.getState().artStyle));
    const tier = modelTier(u.thread.modelSelection.model);
    const active = selection?.kind === "unit" && selection.envId === u.envId && selection.threadId === u.thread.id;
    return (
      <li key={key}>
        <button className={`crew-row ${active ? "active" : ""} ${picked.has(key) ? "in-squad" : ""} ${moved.has(key) ? "moved" : ""} row-${u.state}`} aria-pressed={picked.has(key) || undefined} onClick={(e) => open(u, e)}
          title={u.state === "error" && u.thread.session?.lastError ? `Turn failed: ${u.thread.session.lastError}` : undefined}>
          <span className="mini-portrait sprite" style={{ ["--team" as string]: team }} title={TIER_LABEL[tier]}>
            <CrewPortrait instanceId={u.thread.modelSelection.instanceId} model={u.thread.modelSelection.model} team={stationColor(useGame.getState(), u.envId)} scale={1} />
          </span>
          <span className="crew-text">
            <span className="crew-name">{u.thread.title || "Untitled"}</span>
            <span className="crew-sub">
              <span className={`crew-state st-${read(u) ? "idle" : isBackground(u.thread, u.state) ? "background" : u.state}`}>{read(u) ? "Report read" : stateLabel(u.thread, u.state)}</span>
              <span className="muted"> · {envs[u.envId]?.summary.label}</span>
            </span>
            <ThreadTiming thread={u.thread} detail={detail?.thread} compact />
            <PlanLine thread={u.thread} detail={detail?.thread} />
            {ctx !== undefined && (
              <span className="crew-hp" title={`${Math.round((1 - ctx) * 100)}% context left`}>
                {Array.from({ length: 10 }, (_, i) => (
                  <i key={i} className={i / 10 < 1 - ctx ? contextLevel(ctx) : ""} />
                ))}
              </span>
            )}
          </span>
        </button>
      </li>
    );
  };

  return (
    <aside className={`crew-roster ftl-frame ${collapsed ? "collapsed" : ""}`}>
      <button className="ftl-tab roster-tab" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
        {/* On the phone dock what needs you comes first, so it's never the part cut off. */}
        {phone && waiting > 0 && <span className="needs-count hot">{waiting} waiting · </span>}
        {/* The tab's name in the map's pixel font, like every other frame tab. */}
        <PixelLabel text="Crew" /> <span className={urgent ? "count hot" : "count"}>{crew.length}</span>{operators.length > 0 && <span className="operator-count"> · {operators.length} operators</span>}
        {" "}{phone ? (collapsed ? "▴" : "▾") : collapsed ? "▸" : "▾"}
      </button>
      {!collapsed && (
        <div className="roster-body">
          {operators.length > 0 && <><div className="roster-heading hermes-roster-heading">Hermes operators</div>
            <ol className="crew-list">{operators.map(bot => <li key={bot.name}><button className={`crew-row operator-row row-${bot.state} ${selection?.kind === 'hermes' && selection.profile === bot.name ? 'active' : ''}`} onClick={() => {
              const pending = bot.sessions.find(s => envs[s.envId]?.connection === 'live' && (s.state === 'alert' || s.state === 'question'));
              if (pending) { open(pending); return; }
              pick();
              const sel = { kind: 'hermes' as const, envId: bot.envId, profile: bot.name };
              setSelection(sel); worldRef.current?.focus(sel);
            }}><BotPortrait profile={bot.name} /><span className="crew-text"><span className="crew-name">{bot.title}</span>
              <span className="crew-sub"><span className={`crew-state st-${bot.observed ? bot.state : 'idle'}`}>{bot.observed ? BOT_STATE_LABELS[bot.state] : 'Unobserved'}</span><span className="muted"> · operator</span></span>
            </span></button></li>)}</ol></>}
          {needsYou.length > 0 && (
            <>
              <div className="roster-heading">Needs you</div>
              <ol className="crew-list">{needsYou.map(row)}</ol>
            </>
          )}
          <div className="roster-heading">On duty</div>
          <ol className="crew-list">{onDuty.length ? onDuty.map(row) : <li className="muted small empty">Nobody on duty.</li>}</ol>
        </div>
      )}
    </aside>
  );
}
