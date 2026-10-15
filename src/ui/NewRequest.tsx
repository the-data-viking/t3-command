import { useEffect, useMemo, useState } from "react";
import { groupProjects, sortedEnvs } from "../game/layout";
import { useGame } from "../store";
import { RecruitForm } from "./BuildingPanel";
import { PixelLabel } from "./PixelArt";
import { machineChoices, projectOrder, rememberProject } from "./new-request";
import { NewProject } from "./NewProject";

const NEW_PROJECT = "\u0000new-project";

/**
 * N (or New in the top bar): start a new request anywhere, without finding its station first.
 * The project you last used comes first; the machine is picked for you, with its reason shown,
 * and can be changed. The request text is one draft, kept whichever project or machine you pick.
 * "New project…" in the project list adds one to a machine first, then picks it.
 */
export function NewRequest() {
  const envs = useGame((s) => s.envs);
  const hosts = useGame((s) => s.hosts);
  const storage = useGame((s) => s.storage);
  const groups = useMemo(() => projectOrder(groupProjects(sortedEnvs(useGame.getState()))), [envs]); // eslint-disable-line react-hooks/exhaustive-deps
  const [adding, setAdding] = useState(() => useGame.getState().newProject ?? (groups.length ? null : {}));
  // A project just added: picked by machine and id, since its station key can change once T3
  // recognises the repository.
  const [added, setAdded] = useState<{ envId: string; projectId: string }>();
  const [projectKey, setProjectKey] = useState(() => groups[0]?.key);
  const addedGroup = added && groups.find((g) => g.members.some((m) => m.env.summary.id === added.envId && m.project.id === added.projectId));
  const group = addedGroup ?? groups.find((g) => g.key === projectKey) ?? groups[0];
  const choices = useMemo(() => (group ? machineChoices(group, hosts, storage) : []), [group, hosts, storage]);
  const [picked, setPicked] = useState<string>();
  useEffect(() => { if (useGame.getState().newProject) useGame.setState({ newProject: null }); }, []);
  const machine = choices.find((c) => c.envId === picked) ?? choices[0];
  const member = group?.members.find((m) => m.env.summary.id === machine?.envId);
  const close = () => useGame.setState({ showNewRequest: false, newProject: null });
  // Straight to typing the request (the machine's providers may arrive a moment later).
  useEffect(() => {
    const t = setTimeout(() => document.querySelector<HTMLTextAreaElement>(".new-request textarea")?.focus(), 50);
    return () => clearTimeout(t);
  }, [machine?.envId, adding]);

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal new-request" role="dialog" aria-label="New request" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
        <header className="panel-head">
          <h2 className="title-tab"><PixelLabel text={adding ? "New project" : "New request"} /></h2>
          <span className="spacer" />
          <button className="icon-btn" aria-label="Close" onClick={close}>✕</button>
        </header>
        {adding ? <>
          {!groups.length && <p className="muted small">No projects yet. Add one to a machine, then say what the first crew member should do.</p>}
          <NewProject envId={adding.envId} onCancel={groups.length ? () => setAdding(null) : undefined}
            onCreated={(envId, projectId) => { setAdded({ envId, projectId }); setPicked(envId); setAdding(null); }} />
        </> : added && !addedGroup ? <p className="muted">Waiting for the new project to appear…</p> : !group ? null : (
          <>
            <div className="new-request-where">
              <label className="small">Project
                <select value={group.key} onChange={(e) => {
                  if (e.target.value === NEW_PROJECT) { setAdding({}); return; }
                  setProjectKey(e.target.value); setAdded(undefined); setPicked(undefined);
                }}>
                  {groups.map((g) => <option key={g.key} value={g.key}>{g.name}{g.members.length > 1 ? ` · ${g.members.length} machines` : ""}</option>)}
                  <option value={NEW_PROJECT}>+ New project…</option>
                </select>
              </label>
              <label className="small">Machine
                <select value={machine?.envId} onChange={(e) => setPicked(e.target.value)}>
                  {choices.map((c) => <option key={c.envId} value={c.envId} disabled={!c.ok && c.reason === "unreachable"}>{c.label}{c === choices[0] ? " (suggested)" : ""}</option>)}
                </select>
              </label>
            </div>
            {machine && <p className={`small ${machine.ok ? "muted" : "orange"}`}>{machine.label}: {machine.reason}</p>}
            {member && machine && (
              <RecruitForm key={`${machine.envId}:${member.project.id}`} envId={machine.envId} projectId={member.project.id} draftKey="new-request"
                onRecruited={() => { rememberProject(group.key); close(); }} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
