// Updating T3 itself on a machine: whether it's behind, whether it can update remotely, and what
// the update would do to the crew working there. Loads npm's latest release from the Command server.

import { SUPPORTED_PROTOCOL_VERSIONS, type T3Latest, type T3SelfUpdate } from "../../shared/api";
import type { EnvWorld } from "../store";
import { useGame } from "../store";
import { fetchJson } from "./environment";
import { DEMO } from "../demo";

export const T3_LATEST_REFRESH_MS = 60 * 60_000;

export async function loadT3Latest(): Promise<void> {
  try { useGame.setState({ t3Latest: await fetchJson<T3Latest>("/api/t3/latest") }); } catch { /* Offer nothing until it loads. */ }
}

/** Compare exact versions ("0.0.44" < "0.0.45" < "0.1.0"); non-numeric parts compare as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0), pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export interface T3UpdateOffer {
  current?: string;
  latest?: string;
  /** This machine runs an older T3 than the latest release. */
  behind: boolean;
  /** It can be updated from here; otherwise `reason` says how. */
  can: boolean;
  reason?: string;
  method?: T3SelfUpdate["method"];
  /** Another live machine already runs the latest on a protocol Command speaks. */
  proven: boolean;
  /** Crew mid-turn on this machine, and whether they carry on through the restart. */
  running: number;
  continues: boolean;
}

/** What updating T3 on `envId` to the latest release would mean. Hermes machines have no T3 to update. */
export function t3UpdateOffer(envId: string, envs: Record<string, EnvWorld>, latest: string | null | undefined): T3UpdateOffer | undefined {
  const env = envs[envId];
  if (!env || env.summary.kind === "hermes") return undefined;
  const current = env.summary.serverVersion;
  const behind = !!(latest && current && compareVersions(current, latest) < 0);
  const self = env.summary.selfUpdate;
  const running = Object.values(env.threads).filter((t) => t.latestTurn?.state === "running").length;
  const proven = !!latest && Object.values(envs).some((e) => e !== env && e.summary.kind !== "hermes" && e.connection === "live"
    && e.summary.serverVersion === latest && (SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(e.summary.protocolVersion ?? 1));
  let reason: string | undefined;
  if (!self) reason = "This machine's T3 can't update remotely (a dev checkout or a foreground run). Update and relaunch it there.";
  else if (self.method === "desktop-managed" && !self.desktopAppUpdate) reason = "The T3 desktop app on this machine doesn't accept remote updates yet. Update it there (it usually updates itself).";
  else if (env.connection !== "live") reason = "Not connected.";
  return { current, latest: latest ?? undefined, behind, can: !reason && behind, reason: behind ? reason : undefined, method: self?.method, proven, running, continues: !!self?.continuesThreads };
}

/** How the update happens, in words, for the confirmation. */
export function methodText(method: T3SelfUpdate["method"] | undefined): string {
  return method === "desktop-managed" ? "The T3 desktop app there will download the update, then close and relaunch."
    : method === "boot-service" ? "T3's background service there will install it and restart into it."
    : "T3 there will install it and restart itself.";
}

/** Machines that are behind the latest release, for the fleet-wide notice. */
export function behindMachines(envs: Record<string, EnvWorld>, latest: string | null | undefined): string[] {
  if (!latest) return [];
  return Object.keys(envs).filter((id) => t3UpdateOffer(id, envs, latest)?.behind);
}

export function scheduleT3Latest(): () => void {
  if (DEMO) { useGame.setState({ t3Latest: { version: "0.0.45", checkedAt: Date.now() } }); return () => {}; }
  void loadT3Latest();
  const timer = setInterval(() => void loadT3Latest(), T3_LATEST_REFRESH_MS);
  return () => clearInterval(timer);
}
