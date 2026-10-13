// The URL follows what's open (#crew/<env>/<thread>, #host/<env>, #station/<env>/<project>, …),
// so a link (or a desktop notification, or another device) opens the same thing. A link is applied
// once its machine has connected and the target exists.

import { worldRef } from "../game/world";
import { openHost, setSelection, useGame, type GameState, type Selection } from "../store";

export type Target = { kind: "host"; envId: string } | Exclude<Selection, null>;

const enc = encodeURIComponent;

export function formatHash(selection: Selection, hostPanel: string | null): string {
  if (hostPanel) return `#host/${enc(hostPanel)}`;
  if (!selection) return "";
  switch (selection.kind) {
    case "unit": return `#crew/${enc(selection.envId)}/${enc(selection.threadId)}`;
    case "building": return `#station/${enc(selection.envId)}/${enc(selection.projectId)}`;
    case "library": return `#archive/${enc(selection.envId)}/${enc(selection.projectId)}`;
    case "hermes": return `#hermes/${enc(selection.envId)}${selection.profile ? `/${enc(selection.profile)}` : ""}`;
  }
}

export function parseHash(hash: string): Target | undefined {
  const [kind, a, b] = hash.replace(/^#/, "").split("/").map((p) => { try { return decodeURIComponent(p); } catch { return ""; } });
  if (!a) return undefined;
  if (kind === "host") return { kind: "host", envId: a };
  if (kind === "crew" && b) return { kind: "unit", envId: a, threadId: b };
  if (kind === "station" && b) return { kind: "building", envId: a, projectId: b };
  if (kind === "archive" && b) return { kind: "library", envId: a, projectId: b };
  if (kind === "hermes") return { kind: "hermes", envId: a, ...(b ? { profile: b } : {}) };
  return undefined;
}

/** Whether a target can be opened yet (its machine has reported it). */
export function ready(target: Target, state: GameState): boolean {
  const env = state.envs[target.envId];
  if (!env) return false;
  if (target.kind === "unit") return !!env.threads[target.threadId];
  if (target.kind === "building" || target.kind === "library") return !!env.projects[target.projectId];
  return true;
}

function open(target: Target): void {
  if (target.kind === "host") { openHost(target.envId); worldRef.current?.focusEngineering(target.envId); return; }
  setSelection(target);
  worldRef.current?.focus(target);
}

export function installDeepLinks(): () => void {
  let pending: Target | undefined;
  const apply = () => {
    pending = parseHash(location.hash);
    if (pending && ready(pending, useGame.getState())) { open(pending); pending = undefined; }
  };
  apply();
  // Wait for the machine to connect; give up quietly after a minute.
  const giveUp = setTimeout(() => { pending = undefined; }, 60_000);
  let writing = false;
  const off = useGame.subscribe((s, prev) => {
    if (pending && s.envs !== prev.envs && ready(pending, s)) { const t = pending; pending = undefined; open(t); }
    if (s.selection === prev.selection && s.hostPanel === prev.hostPanel) return;
    const hash = formatHash(s.selection, s.hostPanel);
    if (hash === location.hash || (!hash && !location.hash)) return;
    writing = true;
    history.replaceState(null, "", hash || `${location.pathname}${location.search}`);
    writing = false;
  });
  const onHash = () => { if (!writing) apply(); };
  window.addEventListener("hashchange", onHash);
  return () => { off(); clearTimeout(giveUp); window.removeEventListener("hashchange", onHash); };
}
