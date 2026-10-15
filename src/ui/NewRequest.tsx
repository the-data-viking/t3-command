import { useEffect, useMemo, useState } from "react";
import { groupProjects, sortedEnvs } from "../game/layout";
import { useGame } from "../store";
import { RecruitForm } from "./BuildingPanel";
import { PixelLabel } from "./PixelArt";
import { machineChoices, projectOrder, rememberProject } from "./new-request";
import { NewProject } from "./NewProject";

const NEW_PROJECT = "\u0000new-project";
/** How long auto-routing waits for machines' load before choosing without it. */
const ROUTE_WAIT_MS = 1500;

/**
 * N (or New in the top bar): start a new request anywhere, without finding its station first.
 * The project you last used comes first; the machine is picked for you, with its reason shown,
 * and can be changed. Auto-routing picks once, when machines' load is in (or after a moment, or
 * as soon as you type), and then holds: the target never moves under you while you write.
 * The request text is one draft, kept whichever project or machine you pick.
 * "New project…" in the project list adds one to a machine first, then picks it.
 */
export function NewRequest() {
  const envs = useGame((s) => s.envs);
  const hosts = useGame((s) => s.hosts);
  const storage = useGame((s) => s.storage);
  const routing = useGame((s) => s.prefs.routing);
  const groups = useMemo(() => projectOrder(groupProjects(sortedEnvs(useGame.getState()))), [envs]); // eslint-disable-line react-hooks/exhaustive-deps
  const [adding, setAdding] = useState(() => useGame.getState().newProject ?? (groups.length ? null : {}));
  // A project just added: picked by machine and id, since its station key can change once T3
  // recognises the repository.
  const [added, setAdded] = useState<{ envId: string; projectId: string }>();
  const [projectKey, setProjectKey] = useState(() => groups[0]?.key);
  const addedGroup = added && groups.find((g) => g.members.some((m) => m.env.summary.id === added.envId && m.project.id === added.projectId));
  const group = addedGroup ?? groups.find((g) => g.key === projectKey) ?? groups[0];
  const choices = useMemo(() => (group ? machineChoices(group, hosts, storage, routing) : []), [group, hosts, storage, routing]);
  const best = choices.find((c) => c.auto) ?? choices[0];
  const [picked, setPicked] = useState<string>();
  // Auto-routing's one pick for this project, and when it started looking.
  const [routed, setRouted] = useState<string>();
  const [routeFrom, setRouteFrom] = useState(Date.now);
  const measured = choices.every((c) => !c.ok || c.measured);
  useEffect(() => {
    if (routed || !best) return;
    if (measured) { setRouted(best.envId); return; }
    const t = setTimeout(() => setRouted(best.envId), Math.max(0, routeFrom + ROUTE_WAIT_MS - Date.now()));
    return () => clearTimeout(t);
  }, [routed, best, measured, routeFrom]);
  useEffect(() => { if (useGame.getState().newProject) useGame.setState({ newProject: null }); }, []);
  const machine = choices.find((c) => c.envId === (picked ?? routed)) ?? best;
  const member = group?.members.find((m) => m.env.summary.id === machine?.envId);
  const close = () => useGame.setState({ showNewRequest: false, newProject: null });
  // Straight to typing the request (the machine's providers may arrive a moment later), the
  // caret after any draft already there.
  useEffect(() => {
    const t = setTimeout(() => {
      const box = document.querySelector<HTMLTextAreaElement>(".new-request textarea");
      if (!box || document.activeElement === box) return;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }, 50);
    return () => clearTimeout(t);
  }, [machine?.envId, adding]);

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal new-request" role="dialog" aria-label="New request" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}
        // Typing settles the route: whatever machine is showing now is the one it goes to.
        onInput={(e) => { if (!routed && machine && (e.target as HTMLElement).tagName === "TEXTAREA") setRouted(machine.envId); }}>
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
                  setProjectKey(e.target.value); setAdded(undefined); setPicked(undefined); setRouted(undefined); setRouteFrom(Date.now());
                }}>
                  {groups.map((g) => <option key={g.key} value={g.key}>{g.name}{g.members.length > 1 ? ` · ${g.members.length} machines` : ""}</option>)}
                  <option value={NEW_PROJECT}>+ New project…</option>
                </select>
              </label>
              <label className="small">Machine
                {/* Alphabetical, so the list holds still while machines' load changes. */}
                <select value={machine?.envId} onChange={(e) => setPicked(e.target.value)}>
                  {[...choices].sort((a, b) => a.label.localeCompare(b.label)).map((c) => <option key={c.envId} value={c.envId} disabled={!c.ok && c.reason === "unreachable"}>{c.label}{c.envId === routed && c.auto ? " (suggested)" : ""}</option>)}
                </select>
              </label>
            </div>
            {machine && <p className={`small ${machine.ok ? "muted" : "orange"}`}>{machine.label}: {machine.reason}
              {!machine.ok && best?.auto && best.envId !== machine.envId && <> <button className="btn small" onClick={() => setPicked(best.envId)}>Switch to {best.label}</button></>}</p>}
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
