import { useEffect, useMemo, useRef, useState } from "react";
import { sortedEnvs } from "../game/layout";
import { sfx } from "../game/sfx";
import { worldRef } from "../game/world";
import { ART_STYLES, markReportsRead, openEvent, openHost, setArtStyle, setMuted, setNotify, setSelection, useGame, type GameState } from "../store";
import { isSettled } from "../t3/derive";
import { fuzzyFilter } from "./fuzzy";
import { jumpTo } from "./hotkeys";
import { batchSettle, currentPick } from "./squad";
import { THEME_NAMES } from "./themes";
import { allUnits, reportRead, STATE_LABELS } from "./util";

interface Item {
  id: string;
  group: "Crew" | "Station" | "Machine" | "Go to" | "Action" | "Theme";
  label: string;
  detail?: string;
  run: () => void;
}

/** Everything the palette can find or do, built fresh each time it opens. */
function buildItems(state: GameState): Item[] {
  const items: Item[] = [];
  const close = () => useGame.setState({ showPalette: false });
  const focusUnit = (envId: string, threadId: string) => {
    const sel = { kind: "unit" as const, envId, threadId };
    setSelection(sel);
    worldRef.current?.focus(sel);
  };
  // Crew: waiting on you first, then by recent activity.
  const urgent = new Set(["alert", "question"]);
  // Threads sharing a title are told apart by branch (or a short id).
  const titles = new Map<string, number>();
  for (const u of allUnits(state.envs)) titles.set(u.thread.title, (titles.get(u.thread.title) ?? 0) + 1);
  for (const u of allUnits(state.envs).sort((a, b) => Number(urgent.has(b.state)) - Number(urgent.has(a.state)) || b.thread.updatedAt.localeCompare(a.thread.updatedAt))) {
    const env = state.envs[u.envId];
    items.push({ id: `crew:${u.envId}:${u.thread.id}`, group: "Crew", label: u.thread.title || "Untitled",
      detail: `${STATE_LABELS[u.state]} · ${env?.summary.label ?? ""}${(titles.get(u.thread.title) ?? 0) > 1 ? ` · ${u.thread.branch ?? u.thread.id.slice(0, 8)}` : ""}`,
      run: () => { focusUnit(u.envId, u.thread.id); if (urgent.has(u.state)) openEvent({ envId: u.envId, threadId: u.thread.id }); } });
  }
  for (const env of sortedEnvs(state)) {
    for (const project of Object.values(env.projects)) {
      items.push({ id: `station:${env.summary.id}:${project.id}`, group: "Station", label: project.title, detail: env.summary.label,
        run: () => { const sel = { kind: "building" as const, envId: env.summary.id, projectId: project.id }; setSelection(sel); worldRef.current?.focus(sel); } });
    }
    if (env.summary.kind === "hermes") {
      items.push({ id: `hermes:${env.summary.id}`, group: "Go to", label: "Hermes control center", detail: env.summary.label,
        run: () => { setSelection({ kind: "hermes", envId: env.summary.id }); worldRef.current?.focusStation(env.summary.id); } });
    } else {
      items.push({ id: `machine:${env.summary.id}`, group: "Machine", label: env.summary.label, detail: `Engineering · ${env.connection}`,
        run: () => { openHost(env.summary.id); worldRef.current?.focusEngineering(env.summary.id); } });
    }
  }
  items.push(
    { id: "go:log", group: "Go to", label: "Comms log", detail: "L", run: () => useGame.setState({ showLog: true }) },
    { id: "go:history", group: "Go to", label: "Turn history", detail: "H", run: () => useGame.setState({ showHistory: true }) },
    { id: "go:stations", group: "Go to", label: "Stations (manage machines)", run: () => useGame.setState({ showEnvManager: true }) },
    { id: "go:help", group: "Go to", label: "Keyboard and map help", detail: "?", run: () => useGame.setState({ showHelp: true }) },
    { id: "act:fit", group: "Action", label: "Fit fleet", detail: "F", run: () => worldRef.current?.fitAll() },
    { id: "act:alert", group: "Action", label: "Next crew waiting on you", detail: "Space", run: () => jumpTo("attention") },
    { id: "act:report", group: "Action", label: "Next report ready", detail: ".", run: () => jumpTo("done") },
    { id: "act:sound", group: "Action", label: state.muted ? "Turn sound on" : "Mute sound", run: () => setMuted(!state.muted) },
    { id: "act:notify", group: "Action", label: state.notify ? "Turn off desktop alerts" : "Turn on desktop alerts", run: () => void setNotify(!state.notify) },
  );
  // Safe crew actions apply to the squad, or else the selected crew member.
  const picked = currentPick();
  if (picked.length) {
    const who = picked.length === 1 ? `"${state.envs[picked[0].envId]?.threads[picked[0].threadId]?.title || "Untitled"}"` : `${picked.length} picked crew`;
    const anySettled = picked.some((m) => { const t = state.envs[m.envId]?.threads[m.threadId]; return !!t && isSettled(t); });
    items.push({ id: "act:camp", group: "Action", label: `Send ${who} to camp`, run: () => void batchSettle(true, picked) });
    if (anySettled) items.push({ id: "act:wake", group: "Action", label: `Wake ${who}`, run: () => void batchSettle(false, picked) });
  }
  const unread = allUnits(state.envs).filter((u) => u.state === "done" && u.thread.latestTurn && !reportRead(state.readReports, u.envId, u.thread));
  if (unread.length) items.push({ id: "act:read-all", group: "Action", label: `Mark all ${unread.length} reports read`,
    run: () => markReportsRead(unread.map((u) => ({ envId: u.envId, threadId: u.thread.id, turnId: u.thread.latestTurn!.turnId }))) });
  for (const id of ART_STYLES) {
    if (id !== state.artStyle) items.push({ id: `theme:${id}`, group: "Theme", label: `Theme: ${THEME_NAMES[id]}`, run: () => setArtStyle(id) });
  }
  return items.map((item) => ({ ...item, run: () => { close(); sfx.select(); item.run(); } }));
}

/** Ctrl/Cmd-K: find any crew, station, machine or panel, or run a safe action. */
export function CommandPalette() {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const items = useMemo(() => buildItems(useGame.getState()), []);
  const shown = useMemo(() => fuzzyFilter(items, query, (i) => `${i.label} ${i.detail ?? ""} ${i.group}`), [items, query]);
  const close = () => useGame.setState({ showPalette: false });

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(shown.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); shown[active]?.run(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  };

  return (
    <div className="modal-backdrop palette-backdrop" onClick={close}>
      <div className="palette hud-frame" role="dialog" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <input ref={input} className="palette-input" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
          placeholder="Find crew, stations, machines, actions…" role="combobox" aria-expanded aria-controls="palette-list"
          aria-activedescendant={shown[active] ? `palette-${shown[active].id}` : undefined} />
        <ul id="palette-list" ref={list} className="palette-list" role="listbox">
          {shown.length === 0 && <li className="muted small palette-empty">Nothing matches.</li>}
          {shown.map((item, i) => (
            <li key={item.id} id={`palette-${item.id}`} data-index={i} role="option" aria-selected={i === active}
              className={`palette-item ${i === active ? "active" : ""}`} onPointerMove={() => setActive(i)} onClick={() => item.run()}>
              <span className="palette-group">{item.group}</span>
              <span className="palette-label">{item.label}</span>
              {item.detail && <span className="palette-detail muted small">{item.detail}</span>}
            </li>
          ))}
        </ul>
        <div className="palette-foot muted small">↑↓ choose · Enter run · Esc close</div>
      </div>
    </div>
  );
}
