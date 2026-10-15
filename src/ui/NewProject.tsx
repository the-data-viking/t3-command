import { useEffect, useMemo, useRef, useState } from "react";
import { sfx } from "../game/sfx";
import { sortedEnvs } from "../game/layout";
import { addLog, useGame } from "../store";
import { envClient, logError } from "../t3/environment";
import type { FolderListing, ProjectClone } from "../t3/types";
import { cleanFolderName, cloneStatus, defaultParent, folderName, joinPath, repoName, type NewProjectMode } from "./new-project";

const MODES: Array<{ id: NewProjectMode; label: string }> = [
  { id: "folder", label: "Existing folder" },
  { id: "clone", label: "Clone repo" },
  { id: "empty", label: "New folder" },
];

/**
 * Add a project to a machine's T3: a folder already there, a repository cloned there, or a new
 * empty folder. Calls `onCreated` once the project is ready for a first request (a clone, once it
 * has finished).
 */
export function NewProject({ envId: initialEnv, onCreated, onCancel }: {
  envId?: string;
  onCreated: (envId: string, projectId: string) => void;
  onCancel?: () => void;
}) {
  const envs = useGame((s) => s.envs);
  const machines = useMemo(() => sortedEnvs(useGame.getState()).filter((e) => e.summary.kind !== "hermes"), [envs]); // eslint-disable-line react-hooks/exhaustive-deps
  const [envId, setEnvId] = useState(() => machines.find((m) => m.summary.id === initialEnv)?.summary.id
    ?? machines.find((m) => m.connection === "live")?.summary.id ?? machines[0]?.summary.id);
  const env = envId ? envs[envId] : undefined;
  const live = env?.connection === "live";
  const [mode, setMode] = useState<NewProjectMode>("folder");
  const [path, setPath] = useState("");
  // The starting folder is where projects live, not a project: Add waits until one is picked.
  const [picked, setPicked] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [titleEdited, setTitleEdited] = useState(false);
  const [initGit, setInitGit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [cloning, setCloning] = useState<string>();
  // The picked folder as the machine resolved it (null: it doesn't exist there).
  const [resolved, setResolved] = useState<{ path: string; abs: string | null }>();

  // Each machine starts browsing where its projects already live.
  useEffect(() => { setPath(`${defaultParent(env)}/`); setPicked(false); }, [envId]); // eslint-disable-line react-hooks/exhaustive-deps

  const typed = path.trim().replace(/\/+$/, "");
  const abs = resolved && resolved.path === path ? resolved.abs : undefined;
  const folder = abs ?? typed;
  const newName = mode === "clone" ? (name || repoName(url)) : name;
  const target = mode === "folder" ? folder : newName ? joinPath(folder || "~", cleanFolderName(newName)) : "";
  const autoTitle = mode === "folder" ? folderName(folder) : newName.trim();
  const finalTitle = (titleEdited ? title : autoTitle).trim();
  const existing = env && Object.values(env.projects).find((p) => p.workspaceRoot.replace(/\/+$/, "") === target);
  const ready = live && !busy && !cloning && !!target && !!finalTitle && !existing && (mode !== "clone" || !!url.trim()) && (mode !== "folder" || (!!abs && picked));

  const create = async () => {
    if (!ready || !envId || !env) return;
    setBusy(true);
    setError(undefined);
    const client = envClient(envId)!;
    try {
      if (mode === "clone") {
        const projectId = await client.cloneProject({ title: finalTitle, remoteUrl: url.trim(), destinationPath: target });
        sfx.order();
        addLog({ tone: "info", text: `Cloning ${repoName(url)} into ${target} on ${env.summary.label}`, envId });
        setCloning(projectId);
      } else {
        const projectId = await client.addProject({ title: finalTitle, workspaceRoot: target, createIfMissing: mode === "empty", initGit: mode === "empty" && initGit });
        sfx.building();
        addLog({ tone: "good", text: `Project ${finalTitle} added on ${env.summary.label}`, envId });
        onCreated(envId, projectId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      sfx.error();
      logError(`Adding project on ${env.summary.label} failed`, err);
    } finally {
      setBusy(false);
    }
  };

  if (!machines.length) return <p className="muted">No machines yet: add one under Machines first, then add projects to it here.</p>;

  if (cloning && envId) {
    return <CloneProgress envId={envId} projectId={cloning} title={finalTitle}
      onDone={() => onCreated(envId, cloning)} onGone={() => setCloning(undefined)} />;
  }

  return (
    <div className="new-project">
      <label className="small new-project-field">Machine
        <select value={envId} onChange={(e) => { setEnvId(e.target.value); setError(undefined); }}>
          {machines.map((m) => <option key={m.summary.id} value={m.summary.id} disabled={m.connection !== "live"}>{m.summary.label}{m.connection !== "live" ? " (unreachable)" : ""}</option>)}
        </select>
      </label>
      <div className="tabs new-project-modes" role="tablist" aria-label="How to add it">
        {MODES.map((m) => <button key={m.id} type="button" role="tab" aria-selected={mode === m.id} className={`tab${mode === m.id ? " active" : ""}`}
          onClick={() => { setMode(m.id); setError(undefined); }}>{m.label}</button>)}
      </div>

      {mode === "clone" && <label className="small new-project-field">Repository
        <input value={url} autoFocus placeholder="https://github.com/owner/repo.git or git@github.com:owner/repo.git"
          onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
      </label>}

      <FolderField envId={envId!} label={mode === "folder" ? "Folder" : "Inside"} value={path} onChange={(p) => { setPath(p); setPicked(true); }} disabled={!live}
        missingNote={mode === "folder" ? undefined : "This folder doesn't exist yet; it will be created."} onResolve={(p, a) => setResolved({ path: p, abs: a })} />

      {mode !== "folder" && <label className="small new-project-field">Folder name
        <input value={mode === "clone" ? (name || repoName(url)) : name} placeholder={mode === "clone" ? "repo" : "my-project"} spellCheck={false}
          onChange={(e) => setName(e.target.value)} />
      </label>}
      {mode === "empty" && <label className="small new-project-check">
        <input type="checkbox" checked={initGit} onChange={(e) => setInitGit(e.target.checked)} /> Make it a git repository (crew can then work in worktrees)
      </label>}

      <label className="small new-project-field">Project name
        <input value={titleEdited ? title : autoTitle} onChange={(e) => { setTitle(e.target.value); setTitleEdited(true); }} />
      </label>

      {mode === "folder" && !picked && <p className="muted small">Pick the project's folder from the list, or type its path.</p>}
      {target && (mode !== "folder" || picked) && <p className="muted small">{existing ? <span className="orange">{target} is already the project “{existing.title}” on this machine.</span>
        : mode === "folder" ? <>Adds <code>{target}</code> as a T3 project on {env?.summary.label}. Nothing in the folder changes.</>
        : mode === "clone" ? <>Clones into <code>{target}</code> on {env?.summary.label}, which must not exist yet (or be empty).</>
        : <>Creates <code>{target}</code> on {env?.summary.label}.</>}</p>}
      {!live && env && <p className="orange small">{env.summary.label} is not connected.</p>}
      {error && <p className="orange small" role="alert">{error}</p>}
      <div className="new-project-actions">
        {onCancel && <button className="btn" type="button" onClick={onCancel}>Back</button>}
        <button className="btn primary" type="button" disabled={!ready} onClick={() => void create()}>
          {busy ? "Adding…" : mode === "clone" ? "Clone and add" : mode === "empty" ? "Create project" : "Add project"}
        </button>
      </div>
    </div>
  );
}

/**
 * A path box that browses the machine's folders as you type (T3's filesystem.browse): its
 * subfolders are listed below, and picking one opens it.
 */
function FolderField({ envId, label, value, onChange, onResolve, disabled, missingNote }: {
  envId: string; label: string; value: string; onChange: (path: string) => void;
  /** The typed path, and the absolute folder it names on the machine (null: no such folder). */
  onResolve: (path: string, abs: string | null) => void;
  disabled?: boolean;
  /** What a folder that can't be listed means here, if not a mistake. */
  missingNote?: string;
}) {
  const [listing, setListing] = useState<FolderListing>();
  const [error, setError] = useState<string>();
  // Always browse the folder itself, so the list shows what's inside the folder being picked.
  const browsePath = value.trim() ? (value.trim().endsWith("/") ? value.trim() : `${value.trim()}/`) : "~/";
  const latest = useRef(browsePath);
  latest.current = browsePath;

  useEffect(() => {
    if (disabled) return;
    const t = setTimeout(() => {
      envClient(envId)?.browseFolders(browsePath).then((result) => {
        if (latest.current !== browsePath) return;
        setListing(result);
        setError(undefined);
        onResolve(value, result.parentPath.replace(/(.)\/+$/, "$1"));
      }).catch((err: unknown) => {
        if (latest.current !== browsePath) return;
        setListing(undefined);
        setError(err instanceof Error ? err.message : String(err));
        onResolve(value, null);
      });
    }, 200);
    return () => clearTimeout(t);
  }, [envId, browsePath, disabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const parent = listing?.parentPath.replace(/\/[^/]+\/?$/, "") || "/";
  return (
    <div className="new-project-field folder-field">
      <label className="small">{label}
        <input value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} disabled={disabled} placeholder="~/code/project" />
      </label>
      <div className="folder-list" role="listbox" aria-label={`Folders in ${listing?.parentPath ?? browsePath}`}>
        {listing && listing.parentPath !== "/" && <button type="button" className="folder-row" onClick={() => onChange(`${parent}/`.replace(/^\/\/$/, "/"))}>↑ ..</button>}
        {listing?.entries.filter((e) => !e.name.startsWith(".")).map((e) => (
          <button type="button" key={e.fullPath} className="folder-row" onClick={() => onChange(`${e.fullPath}/`)}>▸ {e.name}</button>
        ))}
        {listing && !listing.entries.some((e) => !e.name.startsWith(".")) && <p className="muted small">No folders inside.</p>}
        {error && <p className={`small ${missingNote ? "muted" : "orange"}`} title={error}>{missingNote ?? "There is no such folder on this machine (or it can't be read)."}</p>}
      </div>
    </div>
  );
}

/** A clone underway: git's progress, with cancel, and retry if it fails. */
function CloneProgress({ envId, projectId, title, onDone, onGone }: { envId: string; projectId: string; title: string; onDone: () => void; onGone: () => void }) {
  const [clone, setClone] = useState<ProjectClone>();
  const [error, setError] = useState<string>();
  const done = useRef(false);
  const label = useGame((s) => s.envs[envId]?.summary.label);

  useEffect(() => envClient(envId)?.watchClones((clones) => {
    const mine = clones.find((c) => c.projectId === projectId);
    setClone(mine);
    if (mine?.phase === "done" && !done.current) {
      done.current = true;
      sfx.building();
      addLog({ tone: "good", text: `Project ${title} cloned on ${label}`, envId });
      onDone();
    }
  }, setError), [envId, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = (what: "cancel" | "retry") => {
    const client = envClient(envId)!;
    (what === "cancel" ? client.cancelClone(projectId) : client.retryClone(projectId)).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  const remove = () => {
    // A failed or cancelled clone leaves an empty project behind; take it away again.
    envClient(envId)!.retireProject(projectId, false).then(onGone, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  const ended = clone && (clone.phase === "failed" || clone.phase === "cancelled");
  return (
    <div className="new-project">
      <h3>Cloning {title}</h3>
      {clone && <p className="muted small"><code>{clone.remoteUrl}</code> → <code>{clone.destinationPath}</code></p>}
      <p className={`small${clone?.phase === "failed" ? " orange" : ""}`} role="status">{clone ? cloneStatus(clone) : "Starting…"}</p>
      {clone?.phase === "running" && clone.percent !== null && <progress className="clone-progress" max={100} value={clone.percent} />}
      {error && <p className="orange small" role="alert">{error}</p>}
      <div className="new-project-actions">
        {clone?.phase === "running" && <button className="btn" type="button" onClick={() => act("cancel")}>Cancel clone</button>}
        {ended && <button className="btn" type="button" onClick={remove}>Discard</button>}
        {ended && <button className="btn primary" type="button" onClick={() => act("retry")}>Retry</button>}
      </div>
    </div>
  );
}
