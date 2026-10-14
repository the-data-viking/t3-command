import { useState } from "react";
import { addLog, useGame } from "../store";
import { envClient, logError } from "../t3/environment";
import { gib, hostView } from "../t3/host";
import { providerVersions, type ProviderVersion } from "../t3/providers";
import { methodText, t3UpdateOffer } from "../t3/t3-update";
import { sfx } from "../game/sfx";
import { HostHistoryChart } from "./HostHistoryChart";
import { PixelMeter, PixelLabel } from "./PixelArt";
import { loadLevel } from "../game/theme";
import { ScratchBay } from "./ScratchBay";
import { StorageSection } from "./StorageSection";
import { useClock } from "./useClock";

export function HostPanel({ envId }: { envId: string }) {
  const env = useGame((s) => s.envs[envId]);
  const host = useGame((s) => s.hosts[envId]);
  const now = useClock();
  const view = hostView(host, env?.connection ?? "offline", now);
  const s = view.snapshot;
  return (
    <aside className="panel host-panel" aria-label="Engineering host resources">
      <header className="panel-head">
        <div className="panel-title"><span className="title-tab panel-kind"><PixelLabel text="Machine" /></span><h2>{env?.summary.label ?? "Host"}</h2><div className="muted small">Engineering · whole-host resources{env?.summary.serverVersion && env.summary.kind !== "hermes" ? ` · T3 ${env.summary.serverVersion} (protocol v${env.summary.protocolVersion ?? 1})` : ""}</div></div>
        <button className="icon-btn" title="Close host details" aria-label="Close host details" onClick={() => useGame.setState({ hostPanel: null })}>✕</button>
      </header>
      <div className="host-body">
        {view.stale && <p className="orange">Last known sample · stale</p>}
        {!s && <p className="muted">{host?.error ?? "Loading host resources…"}</p>}
        {s && <>
          <div className="host-stat"><span>CPU load</span><strong>{view.cpuFraction === undefined ? "Unavailable" : `${Math.round(view.cpuFraction * 100)}%`}</strong></div>
          {view.cpuFraction !== undefined && <PixelMeter value={view.cpuFraction} level={loadLevel(view.cpuFraction)} label="Whole-host CPU utilization" />}
          <p className="muted small">Across {s.cpuCount} logical processors</p>
          <div className="host-stat"><span>RAM used</span><strong>{view.memoryFraction === undefined ? "Unavailable" : `${Math.round(view.memoryFraction * 100)}%`}</strong></div>
          {view.memoryFraction !== undefined && <PixelMeter value={view.memoryFraction} level={loadLevel(view.memoryFraction)} label="RAM used percentage" />}
          {view.memoryFraction !== undefined && <p className="muted small">{gib(s.totalMemoryBytes - s.availableMemoryBytes)} of {gib(s.totalMemoryBytes)} used · {gib(s.availableMemoryBytes)} available</p>}
          {env?.summary.kind !== "hermes" && <>
            <h3>CPU and RAM history</h3>
            <HostHistoryChart envId={envId} />
          </>}
          <p className="muted small">Sampled {new Date(s.sampledAt).toLocaleTimeString()} · refreshes every 10 seconds while visible.</p>
        </>}
        {host?.error && s && <p className="orange small">{host.error}</p>}
        <p className="muted small">Includes all applications on this machine. RAM used is total minus reported availability; it does not measure memory pressure.</p>
        <ScratchBay envId={envId} />
        <StorageSection envId={envId} now={now} />
        {env?.summary.kind !== "hermes" && <T3Version envId={envId} />}
        {env?.summary.kind !== "hermes" && <AgentClis envId={envId} />}
      </div>
    </aside>
  );
}

/**
 * This machine's T3 release, with a one-click update when it's behind npm's latest. The update
 * restarts T3 there, so it says what happens to crew mid-turn and asks first.
 */
function T3Version({ envId }: { envId: string }) {
  const envs = useGame((s) => s.envs);
  const latest = useGame((s) => s.t3Latest?.version);
  const [state, setState] = useState<{ busy?: boolean; error?: string; started?: string }>({});
  const offer = t3UpdateOffer(envId, envs, latest);
  if (!offer?.current) return null;
  const machine = envs[envId]?.summary.label ?? "this machine";

  const update = async () => {
    if (!offer.latest || state.busy) return;
    const lines = [
      `Update T3 on ${machine} from ${offer.current} to ${offer.latest}?`,
      methodText(offer.method),
      offer.running === 0 ? "No crew are mid-turn there."
        : offer.continues ? `${offer.running} crew mid-turn there will carry on after the restart.`
        : `${offer.running} crew mid-turn there will be interrupted by the restart.`,
      offer.proven ? `${offer.latest} already runs on another machine in this fleet.`
        : `Nothing in this fleet runs ${offer.latest} yet: if it speaks a newer orchestration protocol, Command won't be able to follow this machine until Command is updated too.`,
    ];
    if (!window.confirm(lines.join("\n\n"))) return;
    setState({ busy: true });
    try {
      await envClient(envId)!.updateT3(offer.latest, offer.continues);
      sfx.order();
      addLog({ tone: "info", text: `Updating T3 on ${machine} to ${offer.latest}: it will reconnect when the new version is up`, envId });
      setState({ started: offer.latest });
    } catch (err) {
      sfx.error();
      logError(`T3 update on ${machine} failed`, err);
      setState({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  return <>
    <h3>T3 Code</h3>
    <div className="host-stat"><span>Version</span><strong className={offer.behind ? "outdated" : undefined} title={offer.behind ? `${offer.latest} available` : undefined}>{offer.current}</strong></div>
    {state.busy && <p className="muted small">Updating to {offer.latest}… T3 downloads it, then restarts; this machine drops off briefly.</p>}
    {!state.busy && state.started && offer.behind && <p className="muted small">Update to {state.started} started. Waiting for {machine} to come back on the new version…</p>}
    {!state.busy && !state.started && offer.can && (
      <button className="btn wide" onClick={() => void update()}>Update T3 to {offer.latest}</button>
    )}
    {!state.busy && offer.behind && offer.reason && <p className="muted small">{offer.latest} is available. {offer.reason}</p>}
    {!state.busy && offer.behind && offer.can && offer.running > 0 && (
      <p className="small orange">{offer.running} crew mid-turn here {offer.continues ? "will carry on after the restart" : "would be interrupted"}.</p>
    )}
    {!offer.behind && offer.latest && <p className="muted small">Up to date (latest release {offer.latest}).</p>}
    {state.error && <p className="orange small">{state.error}</p>}
  </>;
}

/** Installed agent CLI versions, with T3's one-click update when one is behind. */
function AgentClis({ envId }: { envId: string }) {
  const env = useGame((s) => s.envs[envId]);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const versions = providerVersions(env?.providers ?? []);
  if (!versions.length) return null;
  const live = env?.connection === "live";

  const update = async (v: ProviderVersion) => {
    if (pending[v.driver]) return;
    setPending((p) => ({ ...p, [v.driver]: true }));
    setErrors((e) => ({ ...e, [v.driver]: "" }));
    const machine = env?.summary.label ?? "host";
    try {
      await envClient(envId)!.updateProvider(v.driver, v.instanceId);
      const after = providerVersions(useGame.getState().envs[envId]?.providers ?? []).find((x) => x.driver === v.driver);
      if (after?.lastUpdate?.status === "failed") throw new Error(after.lastUpdate.message ?? "Update failed");
      if (after?.lastUpdate?.status === "unchanged") addLog({ tone: "alert", text: `${v.label} on ${machine}: ${after.lastUpdate.message ?? "update did not change the version"}`, envId });
      else addLog({ tone: "good", text: `${v.label} updated to ${after?.version ?? v.latestVersion} on ${machine}`, envId });
    } catch (err) {
      setErrors((e) => ({ ...e, [v.driver]: err instanceof Error ? err.message : String(err) }));
      sfx.error();
      logError(`${v.label} update on ${machine} failed`, err);
    } finally {
      setPending((p) => ({ ...p, [v.driver]: false }));
    }
  };

  return <>
    <h3>Agent CLIs</h3>
    {versions.map((v) => {
      const busy = v.updating || pending[v.driver];
      const last = v.lastUpdate;
      return (
        <div className="host-cli" key={v.driver}>
          <div className="host-stat"><span>{v.label}</span><strong className={v.latestVersion ? "outdated" : undefined} title={v.latestVersion ? `${v.latestVersion} available` : undefined}>{v.version ?? "Version unknown"}</strong></div>
          {busy && <p className="muted small">Updating{v.latestVersion ? ` to ${v.latestVersion}` : ""}…</p>}
          {!busy && v.latestVersion && v.canUpdate && (
            <button className="btn wide" disabled={!live} onClick={() => void update(v)}>Update to {v.latestVersion}</button>
          )}
          {!busy && v.latestVersion && !v.canUpdate && (
            <p className="muted small">{v.latestVersion} is available.{v.updateCommand && <> Run <code>{v.updateCommand}</code> on this machine to update.</>}</p>
          )}
          {!busy && errors[v.driver] && <p className="orange small">{errors[v.driver]}</p>}
          {!busy && !errors[v.driver] && last && (last.status === "failed" || last.status === "unchanged") && <p className="orange small">{last.message ?? "Last update did not complete."}</p>}
          {!busy && !errors[v.driver] && last?.status === "succeeded" && !v.latestVersion && <p className="muted small">Updated {new Date(last.finishedAt!).toLocaleString()}</p>}
          {!busy && last?.output && last.status !== "succeeded" && <details className="host-cli-output"><summary className="small">Installer output</summary><pre>{last.output}</pre></details>}
        </div>
      );
    })}
    <p className="muted small">Versions as reported by T3. An update installs the CLI once on this machine for every instance of that provider.</p>
  </>;
}
