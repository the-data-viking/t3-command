import { useMemo, useState } from "react";
import { sfx } from "../game/sfx";
import { worldRef } from "../game/world";
import { addLog, setSelection, useGame } from "../store";
import { isHistory, unitState } from "../t3/derive";
import { envClient, logError } from "../t3/environment";
import { SCRATCH_ROOT, SCRATCH_TITLE, scratchProject } from "../t3/scratch";
import { RecruitForm } from "./BuildingPanel";
import { STATE_LABELS, timeAgo } from "./util";

/** The machine's scratch bay: work not tied to a project, crewed from the engineering deck. */
export function ScratchBay({ envId }: { envId: string }) {
  const env = useGame((s) => s.envs[envId]);
  const project = scratchProject(env);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const roster = useMemo(() => {
    if (!env || !project) return [];
    return Object.values(env.threads)
      .filter((t) => t.projectId === project.id && !isHistory(t))
      .map((t) => ({ thread: t, state: unitState(t) }))
      .sort((a, b) => Number(a.state === "sleeping") - Number(b.state === "sleeping")
        || (b.thread.latestUserMessageAt ?? b.thread.createdAt).localeCompare(a.thread.latestUserMessageAt ?? a.thread.createdAt));
  }, [env, project]);

  if (!env || env.summary.kind === "hermes") return null;

  const setUp = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await envClient(envId)!.ensureScratch();
      sfx.building();
      addLog({ tone: "good", text: `Scratch bay ready on ${env.summary.label}`, envId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      sfx.error();
      logError(`Scratch setup on ${env.summary.label} failed`, err);
    } finally {
      setBusy(false);
    }
  };

  if (!project) {
    return <>
      <h3>Scratch bay</h3>
      <p className="muted small">Work on this machine that isn't part of a project: maintenance, storage cleanup, quick experiments. Setting it up adds T3's “{SCRATCH_TITLE}” project in <code>{SCRATCH_ROOT}</code>; each worker gets its own folder there.</p>
      {error && <p className="orange small" role="alert">{error}</p>}
      <button className="btn wide" disabled={busy || env.connection !== "live"} onClick={() => void setUp()}>
        {busy ? "Setting up…" : "Set up scratch bay"}
      </button>
    </>;
  }

  const awake = roster.filter((r) => r.state !== "sleeping").length;
  return <>
    <h3>Scratch bay <span className="muted">({awake} active, {roster.length - awake} in camp)</span></h3>
    <p className="muted small" title={project.workspaceRoot}>{project.workspaceRoot}</p>
    <div className="roster">
      {roster.map(({ thread, state }) => (
        <button key={thread.id} className="roster-row" onClick={() => {
          sfx.select();
          const sel = { kind: "unit" as const, envId, threadId: thread.id };
          setSelection(sel);
          worldRef.current?.focus(sel);
        }}>
          <span className={`dot state-${state}`} title={STATE_LABELS[state]} />
          <span className="roster-name">{thread.title || "Untitled"}</span>
          <span className="muted small">{timeAgo(thread.latestUserMessageAt ?? thread.updatedAt)}</span>
        </button>
      ))}
    </div>
    <RecruitForm key={`recruit:${envId}:${project.id}`} envId={envId} projectId={project.id} />
  </>;
}
