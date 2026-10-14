import { useEffect, useMemo, useState } from "react";
import { groupProjects, sortedEnvs } from "../game/layout";
import { useGame } from "../store";
import { RecruitForm } from "./BuildingPanel";
import { PixelLabel } from "./PixelArt";
import { machineChoices, projectOrder, rememberProject } from "./new-request";

/**
 * N (or New in the top bar): start a new request anywhere, without finding its station first.
 * The project you last used comes first; the machine is picked for you, with its reason shown,
 * and can be changed. The request text is one draft, kept whichever project or machine you pick.
 */
export function NewRequest() {
  const envs = useGame((s) => s.envs);
  const hosts = useGame((s) => s.hosts);
  const storage = useGame((s) => s.storage);
  const groups = useMemo(() => projectOrder(groupProjects(sortedEnvs(useGame.getState()))), [envs]); // eslint-disable-line react-hooks/exhaustive-deps
  const [projectKey, setProjectKey] = useState(() => groups[0]?.key);
  const group = groups.find((g) => g.key === projectKey) ?? groups[0];
  const choices = useMemo(() => (group ? machineChoices(group, hosts, storage) : []), [group, hosts, storage]);
  const [picked, setPicked] = useState<string>();
  const machine = choices.find((c) => c.envId === picked) ?? choices[0];
  const member = group?.members.find((m) => m.env.summary.id === machine?.envId);
  const close = () => useGame.setState({ showNewRequest: false });
  // Straight to typing the request (the machine's providers may arrive a moment later).
  useEffect(() => {
    const t = setTimeout(() => document.querySelector<HTMLTextAreaElement>(".new-request textarea")?.focus(), 50);
    return () => clearTimeout(t);
  }, [machine?.envId]);

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal new-request" role="dialog" aria-label="New request" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
        <header className="panel-head">
          <h2 className="title-tab"><PixelLabel text="New request" /></h2>
          <span className="spacer" />
          <button className="icon-btn" aria-label="Close" onClick={close}>✕</button>
        </header>
        {!group ? <p className="muted">No projects yet: add a machine with a checkout first.</p> : (
          <>
            <div className="new-request-where">
              <label className="small">Project
                <select value={group.key} onChange={(e) => { setProjectKey(e.target.value); setPicked(undefined); }}>
                  {groups.map((g) => <option key={g.key} value={g.key}>{g.name}{g.members.length > 1 ? ` · ${g.members.length} machines` : ""}</option>)}
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
