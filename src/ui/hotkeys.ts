// RTS-style hotkeys: jump between units that want attention, like "find idle worker".

import { startQueue, stopQueue } from "./queue-run";
import { sfx } from "../game/sfx";
import { worldRef } from "../game/world";
import { openEvent, setSelection, setSquad, unitKey, useGame } from "../store";
import { recallGroup, saveGroup } from "./squad";
import type { UnitState } from "../t3/derive";
import { allUnits, reportRead } from "./util";
import { byWait, waitingSince } from "./queue";
import { openDebrief } from "./debrief";
import { openReview } from "./review";

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
  const { envs, selection, readReports, details } = useGame.getState();
  const found = allUnits(envs)
    .filter((u) => GROUPS[group].includes(u.state) && !(group === "done" && reportRead(readReports, u.envId, u.thread)));
  // Waiting on you: longest wait first, the same order as the roster. Reports: oldest finished
  // first, like the debrief queue. Others: most recent first.
  const units = group === "attention"
    ? found.map((u) => ({ u, key: unitKey(u.envId, u.thread.id), since: waitingSince(u.thread, details[unitKey(u.envId, u.thread.id)]?.thread) })).sort(byWait).map(({ u }) => u)
    : group === "done"
      ? found.sort((a, b) => (a.thread.latestTurn?.completedAt ?? "").localeCompare(b.thread.latestTurn?.completedAt ?? ""))
      : found.sort((a, b) => (a.thread.updatedAt < b.thread.updatedAt ? 1 : -1));
  if (units.length === 0) {
    sfx.deny();
    return;
  }
  const current = units.findIndex((u) => selection?.kind === "unit" && selection.envId === u.envId && selection.threadId === u.thread.id);
  const next = units[(current + 1) % units.length];
  const sel = { kind: "unit" as const, envId: next.envId, threadId: next.thread.id };
  sfx.select();
  // Keep the keyboard on the map, so the same key cycles on (O or Enter goes to the order box).
  useGame.setState({ jumpedAt: performance.now() });
  setSelection(sel);
  worldRef.current?.focus(sel);
  if (group === "attention") openEvent({ envId: next.envId, threadId: next.thread.id });
  // A report opens as its debrief card: what was done, what changed, then accept or follow up.
  // (Hermes operators acknowledge reports in their own panel.)
  if (group === "done" && envs[next.envId]?.summary.kind !== "hermes") openDebrief({ envId: next.envId, threadId: next.thread.id });
}

/** Put the cursor in the selected crew member's order box (after a hotkey jump left it on the map). */
function focusOrderBox(): void {
  document.querySelector<HTMLTextAreaElement>("textarea[data-order-box]")?.focus();
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
      if (state.photo) useGame.setState({ photo: false });
      else if (state.event) { stopQueue(); openEvent(null); }
      else if (state.review) openReview(null);
      else if (state.replies) useGame.setState({ replies: null });
      else if (state.planningMission) useGame.setState({ planningMission: false });
      // Dialogs, topmost first: Saved orders opens over a crew panel; the rest are full panels.
      else if (state.showPlaybooks) useGame.setState({ showPlaybooks: false });
      else if (state.showDock) useGame.setState({ showDock: false });
      else if (state.showBoard) useGame.setState({ showBoard: false });
      else if (state.showTimeline) useGame.setState({ showTimeline: false });
      else if (state.showHistory) useGame.setState({ showHistory: false });
      else if (state.showEnvManager) useGame.setState({ showEnvManager: false });
      else if (state.showLog) useGame.setState({ showLog: false });
      else if (state.squad.length) setSquad([]);
      else setSelection(null);
      (document.activeElement as HTMLElement | null)?.blur?.();
      return;
    }
    if (typing(e.target)) return;
    // Back to where you were before the last jump: Backspace, or Alt+← as in a browser.
    if ((e.key === "Backspace" && !e.ctrlKey && !e.metaKey && !e.altKey) || (e.altKey && e.key === "ArrowLeft")) {
      if (worldRef.current?.back()) { e.preventDefault(); sfx.select(); }
      return;
    }
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
      t: () => useGame.setState((s) => ({ showTimeline: !s.showTimeline })),
      x: () => jumpTo("error"),
      o: () => focusOrderBox(),
      Enter: () => focusOrderBox(),
      b: () => useGame.setState((s) => ({ showBoard: !s.showBoard })),
      d: () => useGame.setState((s) => ({ showDock: !s.showDock })),
      p: () => useGame.setState((s) => ({ photo: !s.photo })),
      q: () => startQueue(),
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
