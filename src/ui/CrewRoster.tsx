import { useMemo, useState } from "react";
import { stationColor } from "../game/layout";
import { sfx } from "../game/sfx";
import { css, modelTier, PROVIDER_VISOR, providerSilhouette, TIER_LABEL } from "../game/theme";
import { worldRef } from "../game/world";
import { openEvent, setSelection, unitKey, useGame } from "../store";
import type { UnitState } from "../t3/derive";
import { telemetry } from "../t3/telemetry";
import { allUnits, STATE_LABELS, type UnitRef } from "./util";

const NEEDS_YOU: UnitState[] = ["alert", "question", "error", "done"];
const ON_DUTY: UnitState[] = ["working", "monitoring", "idle"];
const ORDER: UnitState[] = [...NEEDS_YOU, ...ON_DUTY];

/** FTL-style crew list: who needs you first, then who's on duty. Settled crew stay in quarters. */
export function CrewRoster() {
  const envs = useGame((s) => s.envs);
  const details = useGame((s) => s.details);
  const selection = useGame((s) => s.selection);
  const [collapsed, setCollapsed] = useState(false);

  const crew = useMemo(
    () =>
      allUnits(envs)
        .filter((u) => u.state !== "sleeping")
        .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || b.thread.updatedAt.localeCompare(a.thread.updatedAt)),
    [envs],
  );
  const needsYou = crew.filter((u) => NEEDS_YOU.includes(u.state));
  const onDuty = crew.filter((u) => ON_DUTY.includes(u.state));
  const urgent = crew.filter((u) => u.state === "alert" || u.state === "question").length;

  const open = (u: UnitRef) => {
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
    const team = css(stationColor(useGame.getState(), u.envId));
    const visor = css(PROVIDER_VISOR[u.thread.modelSelection.instanceId] ?? 0x9fb3d1);
    const shape = providerSilhouette(u.thread.modelSelection.instanceId);
    const tier = modelTier(u.thread.modelSelection.model);
    const active = selection?.kind === "unit" && selection.envId === u.envId && selection.threadId === u.thread.id;
    return (
      <li key={key}>
        <button className={`crew-row ${active ? "active" : ""} row-${u.state}`} onClick={() => open(u)}>
          <span className={`mini-portrait ${shape} tier-${tier}`} style={{ ["--team" as string]: team, ["--visor" as string]: visor }} title={TIER_LABEL[tier]} />
          <span className="crew-text">
            <span className="crew-name">{u.thread.title || "Untitled"}</span>
            <span className="crew-sub">
              <span className={`crew-state st-${u.state}`}>{STATE_LABELS[u.state]}</span>
              <span className="muted"> · {envs[u.envId]?.summary.label}</span>
            </span>
            {ctx !== undefined && (
              <span className="crew-hp" title={`${Math.round((1 - ctx) * 100)}% context left`}>
                {Array.from({ length: 10 }, (_, i) => (
                  <i key={i} className={i / 10 < 1 - ctx ? (ctx < 0.6 ? "ok" : ctx < 0.85 ? "warn" : "bad") : ""} />
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
      <button className="ftl-tab roster-tab" onClick={() => setCollapsed(!collapsed)}>
        CREW <span className={urgent ? "count hot" : "count"}>{crew.length}</span> {collapsed ? "▸" : "▾"}
      </button>
      {!collapsed && (
        <div className="roster-body">
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
