// RTS-style hotkeys: jump between units that want attention, like "find idle worker".

import { sfx } from "../game/sfx";
import { worldRef } from "../game/world";
import { setSelection, useGame } from "../store";
import type { UnitState } from "../t3/derive";
import { allUnits } from "./util";

export type JumpGroup = "attention" | "done" | "working" | "error";

const GROUPS: Record<JumpGroup, UnitState[]> = {
  attention: ["alert", "question"],
  done: ["done", "idle"],
  working: ["working"],
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
}

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

export function installHotkeys(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (useGame.getState().showEnvManager) useGame.setState({ showEnvManager: false });
      else setSelection(null);
      (document.activeElement as HTMLElement | null)?.blur?.();
      return;
    }
    if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const actions: Record<string, () => void> = {
      " ": () => jumpTo("attention"),
      ".": () => jumpTo("done"),
      w: () => jumpTo("working"),
      f: () => worldRef.current?.fitAll(),
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
