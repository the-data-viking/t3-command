// Agent CLI versions on one machine, and which of them T3 can update in place. Mirrors T3 Code's
// own provider settings: an update replaces the driver's CLI, so instances sharing a driver are
// one entry, and one-click updates are offered only when every outdated instance agrees on how.

import type { Provider, ProviderUpdateState } from "./types";

export interface ProviderVersion {
  driver: string;
  /** The instance to pass to `server.updateProvider`. */
  instanceId: string;
  label: string;
  version: string | null;
  /** Set when the installed CLI is behind the latest compatible release. */
  latestVersion?: string;
  /** T3 can run the update itself. */
  canUpdate: boolean;
  /** Shell command to run by hand when T3 can't update this CLI itself. */
  updateCommand?: string;
  updating: boolean;
  /** The last update run's outcome, kept until the provider reports a newer state. */
  lastUpdate?: ProviderUpdateState;
}

const DRIVER_LABELS: Record<string, string> = { codex: "Codex", claudeAgent: "Claude Code" };

function behind(p: Provider): boolean {
  const latest = p.compatibilityAdvisory?.latestVersionStatus;
  return p.enabled && latest !== "broken" && latest !== "unsupported"
    && p.versionAdvisory?.status === "behind_latest" && p.versionAdvisory.latestVersion !== null;
}

const inFlight = (p: Provider) => p.updateState?.status === "queued" || p.updateState?.status === "running";

export function providerVersions(providers: Provider[]): ProviderVersion[] {
  const byDriver = new Map<string, Provider[]>();
  for (const p of providers) {
    if (!p.installed || (!p.enabled && !inFlight(p))) continue;
    byDriver.set(p.driver, [...(byDriver.get(p.driver) ?? []), p]);
  }
  return [...byDriver.values()].map((group) => {
    const outdated = group.filter(behind);
    const lead = group.find(inFlight) ?? outdated[0] ?? group[0];
    const advisory = outdated[0]?.versionAdvisory;
    const commands = new Set(outdated.map((p) => p.versionAdvisory!.canUpdate ? p.versionAdvisory!.updateCommand : null));
    const finished = group.map((p) => p.updateState).filter((s) => s && s.status !== "idle" && s.finishedAt)
      .sort((a, b) => b!.finishedAt!.localeCompare(a!.finishedAt!))[0];
    return {
      driver: lead.driver,
      instanceId: lead.instanceId,
      label: DRIVER_LABELS[lead.driver] ?? (group.length === 1 ? lead.displayName : undefined) ?? lead.driver,
      version: lead.version ?? lead.versionAdvisory?.currentVersion ?? null,
      latestVersion: advisory?.latestVersion ?? undefined,
      canUpdate: outdated.length > 0 && commands.size === 1 && !commands.has(null),
      updateCommand: advisory?.updateCommand ?? undefined,
      updating: group.some(inFlight),
      lastUpdate: finished,
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
}
