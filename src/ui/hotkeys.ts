// RTS-style hotkeys: jump between units that want attention, like "find idle worker".

import { sfx } from "../game/sfx";
import { worldRef } from "../game/world";
import { openEvent, setSelection, setSquad, useGame } from "../store";
import { recallGroup, saveGroup } from "./squad";
import type { UnitState } from "../t3/derive";
import { allUnits } from "./util";

export type JumpGroup = "attention" | "done" | "working" | "monitoring" | "error";

const GROUPS: Record<JumpGroup, UnitState[]> = {
  attention: ["alert", "question"],
  done: ["done", "idle"],
  working: ["working"],
  monitoring: ["monitoring"],
  error: ["error"],
};

/** Select and center the next unit in a group, cycling from the current selection. */
export function jumpTo(group: JumpGroup): void {
  const { envs, selection } = useGame.getState();
  const units = allUnits(envs)
    .filter((u) => GROUPS[group].includes(u.state))
    .sort((a, b) => (a.thread.updatedAt < b.thread.updatedAt ? 1 : -1));
  if (units.length === 0) {
    sfx.deny();
    return;
  }
  const current = units.findIndex((u) => selection?.kind === "unit" && selection.envId === u.envId && selection.threadId === u.thread.id);
  const next = units[(current + 1) % units.length];
  const sel = { kind: "unit" as const, envId: next.envId, threadId: next.thread.id };
  sfx.select();
  setSelection(sel);
  worldRef.current?.focus(sel);
  if (group === "attention") openEvent({ envId: next.envId, threadId: next.thread.id });
}

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

export function installHotkeys(): () => void {
  const onKey = (e: KeyboardEvent) => {
    // The palette opens from anywhere, even while typing.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      useGame.setState((s) => ({ showPalette: !s.showPalette, showHelp: false }));
      return;
    }
    const state = useGame.getState();
    if (state.showPalette || state.showHelp) return; // They handle their own keys.
    if (e.key === "Escape") {
      if (state.event) openEvent(null);
      else if (state.showEnvManager) useGame.setState({ showEnvManager: false });
      else if (state.showLog) useGame.setState({ showLog: false });
      else if (state.squad.length) setSquad([]);
      else setSelection(null);
      (document.activeElement as HTMLElement | null)?.blur?.();
      return;
    }
    if (typing(e.target)) return;
    // Control groups by physical key: Alt+digit types symbols on a Mac, and Chrome keeps Ctrl+digit
    // for switching tabs on Windows and Linux, so saving takes either Ctrl or Alt.
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      if (e.ctrlKey || e.altKey) saveGroup(Number(digit[1]));
      else recallGroup(Number(digit[1]));
      return;
    }
    if (e.target instanceof Element && e.target.closest("button, summary, a")) return;
    if (e.key === "?") { e.preventDefault(); useGame.setState({ showHelp: true }); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const actions: Record<string, () => void> = {
      " ": () => jumpTo("attention"),
      ".": () => jumpTo("done"),
      w: () => jumpTo("working"),
      m: () => jumpTo("monitoring"),
      f: () => worldRef.current?.fitAll(),
      l: () => useGame.setState((s) => ({ showLog: !s.showLog })),
      h: () => useGame.setState((s) => ({ showHistory: !s.showHistory })),
    };
    const action = actions[e.key];
    if (!action) return;
    // Selecting a unit focuses its order box; don't let the hotkey's character land in it.
    e.preventDefault();
    action();
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
