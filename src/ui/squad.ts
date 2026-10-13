// Picking several crew at once: batch send-to-camp / wake, and RTS control groups (Ctrl+1–9 to
// save, 1–9 to recall, the same number again to frame them on the map).

import { sfx } from "../game/sfx";
import { worldRef } from "../game/world";
import { addLog, setSquad, unitKey, useGame, type EnvWorld, type SquadMember } from "../store";
import { isHistory, isSettled } from "../t3/derive";
import { envClient, logError } from "../t3/environment";

const GROUPS_KEY = "t3c:control-groups";

export type ControlGroups = Record<string, SquadMember[]>;

export function loadGroups(): ControlGroups {
  try {
    const raw = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "{}") as ControlGroups;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function saveGroups(groups: ControlGroups): void {
  try { localStorage.setItem(GROUPS_KEY, JSON.stringify(groups)); } catch { /* Per-browser convenience only. */ }
}

/** Members that still exist as crew (not removed or turned into history). */
export function liveMembers(members: SquadMember[], envs: Record<string, EnvWorld>): SquadMember[] {
  return members.filter((m) => {
    const t = envs[m.envId]?.threads[m.threadId];
    return !!t && !isHistory(t) && !t.archivedAt;
  });
}

/** The squad, or else the one selected crew member: what a batch action or group save applies to. */
export function currentPick(): SquadMember[] {
  const { squad, selection } = useGame.getState();
  if (squad.length) return squad;
  return selection?.kind === "unit" ? [{ envId: selection.envId, threadId: selection.threadId }] : [];
}

export function saveGroup(n: number): void {
  const members = currentPick();
  const groups = loadGroups();
  if (members.length) groups[n] = members; else delete groups[n];
  saveGroups(groups);
  sfx.select();
  addLog({ tone: "info", text: members.length ? `Control group ${n}: ${members.length} crew` : `Control group ${n} cleared` });
}

let lastRecall: { n: number; at: number } | undefined;

/** Recall a group as the squad; recalling the same group again within a second frames it. */
export function recallGroup(n: number, now = Date.now()): void {
  const { envs } = useGame.getState();
  const members = liveMembers(loadGroups()[n] ?? [], envs);
  if (!members.length) { sfx.deny(); return; }
  sfx.select();
  setSquad(members);
  if (lastRecall?.n === n && now - lastRecall.at < 1000) worldRef.current?.frameCrew(members);
  lastRecall = { n, at: now };
}

/** Send every picked crew member to camp, or wake them; skips those already there. */
export async function batchSettle(settle: boolean, members = currentPick()): Promise<void> {
  const { envs } = useGame.getState();
  const targets = liveMembers(members, envs).filter((m) => {
    const t = envs[m.envId].threads[m.threadId];
    return settle ? !isSettled(t) : isSettled(t);
  });
  if (!targets.length) { sfx.deny(); return; }
  sfx.select();
  const results = await Promise.allSettled(targets.map((m) => {
    const client = envClient(m.envId);
    if (!client) return Promise.reject(new Error("Machine not connected"));
    return settle ? client.settle(m.threadId) : client.unsettle(m.threadId);
  }));
  const failed = results.filter((r) => r.status === "rejected");
  const done = targets.length - failed.length;
  if (done) addLog({ tone: "good", text: `${settle ? "Sent" : "Woke"} ${done} crew ${settle ? "to camp" : "up"}` });
  if (failed.length) logError(`${failed.length} of ${targets.length} couldn't be ${settle ? "sent to camp" : "woken"}`, (failed[0] as PromiseRejectedResult).reason);
}

export const squadKeys = (squad: SquadMember[]) => new Set(squad.map((m) => unitKey(m.envId, m.threadId)));
