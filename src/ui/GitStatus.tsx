// Git state of a module's checkout on the selected machine. Followed only while the module panel
// is open: T3 recomputes status (and may reach the remote) for each subscriber.

import { useEffect, useState } from "react";
import { useGame } from "../store";
import { envClient } from "../t3/environment";
import type { VcsLocalStatus, VcsRemoteStatus } from "../t3/types";

export function GitStatus({ envId, projectId }: { envId: string; projectId: string }) {
  const env = useGame((s) => s.envs[envId]);
  const cwd = env?.projects[projectId]?.workspaceRoot;
  const live = env?.connection === "live" && env.summary.kind !== "hermes";
  const [local, setLocal] = useState<VcsLocalStatus>();
  const [remote, setRemote] = useState<VcsRemoteStatus | null>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setLocal(undefined); setRemote(undefined); setError(undefined);
    if (!cwd || !live) return;
    return envClient(envId)?.watchVcs(cwd, (event) => {
      if (event._tag === "snapshot") { setLocal(event.local); setRemote(event.remote); }
      else if (event._tag === "localUpdated") setLocal(event.local);
      else if (event._tag === "remoteUpdated") setRemote(event.remote);
    }, setError);
  }, [envId, cwd, live]);

  if (!live) return null;
  if (error) return <div className="git-status muted small">Git status unavailable: {error}</div>;
  if (!local) return <div className="git-status muted small">Reading git status…</div>;
  if (!local.isRepo) return <div className="git-status muted small">Not a git repository.</div>;
  const tree = local.workingTree;
  return (
    <div className="git-status">
      <div className="tele-row">
        <span className="tele-key">BRANCH</span>
        <span className="tele-val">⎇ {local.refName ?? "detached"}{local.isDefaultRef ? " (default)" : ""}</span>
        {remote && (
          <span className="muted small">
            {remote.hasUpstream ? `↑${remote.aheadCount} ↓${remote.behindCount}` : "no upstream"}
          </span>
        )}
      </div>
      <div className="tele-row">
        <span className="tele-key">CHECKOUT</span>
        <span className="tele-val">
          {local.hasWorkingTreeChanges
            ? <>{tree.files.length} file{tree.files.length === 1 ? "" : "s"} changed · <span className="diff-add">+{tree.insertions}</span> <span className="diff-del">−{tree.deletions}</span></>
            : "clean"}
        </span>
      </div>
      {local.hasWorkingTreeChanges && (
        <ul className="turn-files">
          {tree.files.slice(0, 6).map((f) => (
            <li key={f.path}><span className="file-path" title={f.path}>{f.path}</span> <span className="diff-add">+{f.insertions}</span> <span className="diff-del">−{f.deletions}</span></li>
          ))}
          {tree.files.length > 6 && <li className="muted">+{tree.files.length - 6} more</li>}
        </ul>
      )}
      {remote?.pr && (
        <a className={`pr-chip pr-${remote.pr.state}`} href={remote.pr.url} target="_blank" rel="noreferrer" title={remote.pr.title}>
          <span className="pr-number">#{remote.pr.number}</span> <span className="pr-state">{remote.pr.state.toUpperCase()}</span> <span className="pr-title">{remote.pr.title}</span>
        </a>
      )}
    </div>
  );
}
