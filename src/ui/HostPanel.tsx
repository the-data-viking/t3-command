import { useState } from "react";
import { addLog, useGame } from "../store";
import { envClient, logError } from "../t3/environment";
import { gib, hostView } from "../t3/host";
import { providerVersions, type ProviderVersion } from "../t3/providers";
import { sfx } from "../game/sfx";
import { HostHistoryChart } from "./HostHistoryChart";
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
        <div className="panel-title"><h2>{env?.summary.label ?? "Host"}</h2><div className="muted small">Engineering · whole-host resources{env?.summary.serverVersion && env.summary.kind !== "hermes" ? ` · T3 ${env.summary.serverVersion} (protocol v${env.summary.protocolVersion ?? 1})` : ""}</div></div>
        <button className="icon-btn" title="Close host details" aria-label="Close host details" onClick={() => useGame.setState({ hostPanel: null })}>✕</button>
      </header>
      <div className="host-body">
        {view.stale && <p className="orange">Last known sample · stale</p>}
        {!s && <p className="muted">{host?.error ?? "Loading host resources…"}</p>}
        {s && <>
          <div className="host-stat"><span>CPU load</span><strong>{view.cpuFraction === undefined ? "Unavailable" : `${Math.round(view.cpuFraction * 100)}%`}</strong></div>
          {view.cpuFraction !== undefined && <meter min={0} max={100} low={85} high={95} optimum={0} value={view.cpuFraction * 100} aria-label="Whole-host CPU utilization" />}
          <p className="muted small">Across {s.cpuCount} logical processors</p>
          <div className="host-stat"><span>RAM used</span><strong>{view.memoryFraction === undefined ? "Unavailable" : `${Math.round(view.memoryFraction * 100)}%`}</strong></div>
          {view.memoryFraction !== undefined && <meter min={0} max={100} low={85} high={95} optimum={0} value={view.memoryFraction * 100} aria-label="RAM used percentage" />}
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
        {env?.summary.kind !== "hermes" && <AgentClis envId={envId} />}
      </div>
    </aside>
  );
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
