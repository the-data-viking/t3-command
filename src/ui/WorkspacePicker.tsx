import { useEffect, useState } from "react";
import { useGame } from "../store";
import { envClient } from "../t3/environment";
import { defaultBranch, latestWorktree, type ProjectRefs, type RecruitWorkspace } from "../t3/workspace";

export function WorkspacePicker({ envId, projectId, value, onChange, disabled }: {
  envId: string;
  projectId: string;
  value: RecruitWorkspace;
  onChange: (value: RecruitWorkspace) => void;
  disabled: boolean;
}) {
  const env = useGame((s) => s.envs[envId]);
  const project = env?.projects[projectId];
  const [data, setData] = useState<ProjectRefs>();
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const hermes = env?.summary.kind === "hermes";

  useEffect(() => {
    if (hermes || env?.connection !== "live") return;
    let active = true;
    setLoading(true);
    setError(undefined);
    const client = envClient(envId);
    if (!client) { setLoading(false); setError("Workspace connection unavailable"); return; }
    void client.projectRefs(projectId).then((refs) => {
      if (active) setData(refs);
    }).catch((err: unknown) => {
      if (active) { setData(undefined); setError(err instanceof Error ? err.message : String(err)); }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [envId, projectId, env?.connection, hermes, refresh]);

  if (!project || !env) return null;
  if (hermes) return <div className="muted small">Workspace: current checkout · {project.workspaceRoot}</div>;
  const refs = data?.refs ?? [];
  const current = refs.find((r) => r.current);
  const latest = latestWorktree(Object.values(env.threads), projectId, project.workspaceRoot);
  const worktrees = refs.filter((r) => !r.isRemote && r.worktreePath && r.worktreePath !== project.workspaceRoot);
  const latestRef = worktrees.find((r) => r.worktreePath === latest?.worktreePath);
  const selectedPath = value.mode === "existing" ? value.path : value.mode === "latest" ? latestRef?.worktreePath : project.workspaceRoot;
  const selectedBranch = (value.mode === "local" || value.mode === "worktree") ? value.branch ?? defaultBranch(refs) ?? "" : "";
  const branchRefs = value.mode === "worktree" ? refs : refs.filter((r) => !r.isRemote && (!r.worktreePath || r.worktreePath === project.workspaceRoot));
  const unavailable = value.mode === "latest" ? !latestRef : value.mode === "existing" ? !worktrees.some((r) => r.worktreePath === value.path) : false;

  return <div className="recruit-workspace">
    <div className="workspace-heading">
      <label htmlFor={`workspace-${envId}-${projectId}`}>Workspace</label>
      <button className="btn small" type="button" disabled={disabled || loading || env.connection !== "live"} onClick={() => setRefresh((n) => n + 1)}>Refresh</button>
    </div>
    <select id={`workspace-${envId}-${projectId}`} disabled={disabled || loading || env.connection !== "live"}
      value={value.mode === "existing" ? `path:${value.path}` : value.mode}
      onChange={(e) => {
        const mode = e.target.value;
        onChange(mode.startsWith("path:") ? { mode: "existing", path: mode.slice(5) } : mode === "worktree" ? { mode, startFromOrigin: true } : mode === "latest" ? { mode } : { mode: "local" });
      }}>
      <option value="local">Current checkout{current ? ` (${current.name})` : ""}</option>
      <option value="latest" disabled={!latestRef}>Latest worktree{latestRef ? ` (${latestRef.name})` : " — none available"}</option>
      <option value="worktree" disabled={!data?.isRepo || refs.length === 0}>New worktree</option>
      {worktrees.map((ref) => <option key={ref.worktreePath} value={`path:${ref.worktreePath}`}>Existing worktree: {ref.name}</option>)}
      {value.mode === "existing" && unavailable && <option value={`path:${value.path}`} disabled>Selected worktree unavailable</option>}
    </select>
    {(value.mode === "local" || value.mode === "worktree") && data?.isRepo && branchRefs.length > 0 && <label className="workspace-branch">
      {value.mode === "worktree" ? "Base branch" : "Checkout branch"}
      <select aria-label={value.mode === "worktree" ? "Base branch" : "Checkout branch"} value={selectedBranch} disabled={disabled || loading}
        onChange={(e) => onChange({ ...value, branch: e.target.value })}>
        {branchRefs.map((ref) => <option key={ref.name} value={ref.name}>{ref.name}{ref.isDefault ? " (default)" : ""}</option>)}
      </select>
    </label>}
    {value.mode === "worktree" ? <>
      <label className="workspace-origin"><input type="checkbox" checked={value.startFromOrigin ?? true} disabled={disabled || loading} onChange={(e) => onChange({ ...value, startFromOrigin: e.target.checked })} />Start from latest origin branch</label>
      <div className="muted small">Creates a separate worktree and runs the project’s setup script.</div>
    </> : <div className="muted small workspace-path" title={selectedPath ?? undefined}>{selectedPath ?? "Selected worktree unavailable"}</div>}
    {value.mode === "local" && value.branch && value.branch !== current?.name && <div className="muted small">Switches the project checkout to {value.branch}; workers sharing this checkout see the change.</div>}
    {loading && <div className="muted small" role="status">Loading branches and worktrees…</div>}
    {error && <div className="small" role="alert">Could not load workspace choices: {error}</div>}
    {unavailable && !loading && <div className="small" role="alert">Choose an available worktree or refresh the list.</div>}
  </div>;
}
