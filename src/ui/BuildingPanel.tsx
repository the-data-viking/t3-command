import { useDraft } from "./drafts";
import { useMemo, useState } from "react";
import { RUNTIME_MODES } from "./posture";
import { sfx } from "../game/sfx";
import { worldRef } from "../game/world";
import { groupFor, stationColor } from "../game/layout";
import { css, hudAccent } from "../game/theme";
import { addLog, setSelection, useGame } from "../store";
import { isHistory, unitState } from "../t3/derive";
import { envClient, logError } from "../t3/environment";
import type { ModelSelection, RuntimeMode } from "../t3/types";
import { isMyDefault, providerDefault, startingSelection, usableProviders } from "../t3/model-defaults";
import { makeDefault } from "../t3/prefs";
import { STATE_LABELS, timeAgo } from "./util";
import { HermesBotPicker } from "./HermesBotPicker";
import { HermesPanel } from "./HermesPanel";
import type { RecruitWorkspace } from "../t3/workspace";
import { WorkspacePicker } from "./WorkspacePicker";
import { GitStatus } from "./GitStatus";
import { PixelIcon, PixelLabel } from "./PixelArt";
import { isScratch } from "../t3/scratch";


/** This browser's last recruit settings on a machine. The model isn't one: that's your Command default. */
interface RecruitPrefs {
  runtimeMode?: RuntimeMode;
  hermesProfile?: string;
  /** Recruits start in plan mode: they propose a plan, and build only once you approve it. */
  planFirst?: boolean;
}

function loadPrefs(envId: string): RecruitPrefs {
  try {
    return JSON.parse(localStorage.getItem(`t3c:recruit:${envId}`) ?? "{}") as RecruitPrefs;
  } catch {
    return {};
  }
}

function savePrefs(envId: string, prefs: RecruitPrefs): void {
  try {
    localStorage.setItem(`t3c:recruit:${envId}`, JSON.stringify(prefs));
  } catch {
    // Per-browser convenience only.
  }
}

export function BuildingPanel({ envId, projectId }: { envId: string; projectId: string }) {
  useGame((s) => s.artStyle); // Re-render on theme change: team and bot colours deepen on light HUDs.
  const env = useGame((s) => s.envs[envId]);
  const project = env?.projects[projectId];
  const [showHermes, setShowHermes] = useState(false);

  const roster = useMemo(() => {
    if (!env) return [];
    return Object.values(env.threads)
      .filter((t) => t.projectId === projectId && !isHistory(t))
      .map((t) => ({ thread: t, state: unitState(t) }))
      .sort((a, b) => (b.thread.latestUserMessageAt ?? b.thread.createdAt).localeCompare(a.thread.latestUserMessageAt ?? a.thread.createdAt));
  }, [env, projectId]);

  if (!env || !project) {
    return (
      <aside className="panel">
        <p className="muted">This building is gone.</p>
      </aside>
    );
  }

  const archived = Object.values(env.threads).filter((t) => t.projectId === projectId && isHistory(t)).length;
  const awake = roster.filter((r) => r.state !== "sleeping");
  const asleep = roster.filter((r) => r.state === "sleeping");

  return (
    <aside className="panel building-panel">
      <header className="panel-head">
        <div className="portrait building" />
        <div className="panel-title">
          <span className="title-tab panel-kind"><PixelLabel text="Station" /></span>
          <h2 title={project.title}>{project.title}</h2>
          <div className="muted small" title={project.workspaceRoot}>
            {project.workspaceRoot}
          </div>
          <div className="muted small">{env.summary.label}</div>
        </div>
        <button className="icon-btn" onClick={() => setSelection(null)} title="Close (Esc)">
          ✕
        </button>
      </header>

      {env.summary.kind === "hermes" && <button className="btn wide" onClick={() => setShowHermes(true)}>Hermes bots & routines</button>}
      {showHermes && <HermesPanel envId={envId} onClose={() => setShowHermes(false)} />}
      <MachineTabs envId={envId} projectId={projectId} />
      <GitStatus key={`git:${envId}:${projectId}`} envId={envId} projectId={projectId} />
      <RecruitForm key={`recruit:${envId}:${projectId}`} envId={envId} projectId={projectId} />

      <div className="roster">
        <h3>
          Workers <span className="muted">({awake.length} active, {asleep.length} in camp)</span>
        </h3>
        {[...awake, ...asleep].map(({ thread, state }) => (
          <button
            key={thread.id}
            className="roster-row"
            onClick={() => {
              sfx.select();
              const sel = { kind: "unit" as const, envId, threadId: thread.id };
              setSelection(sel);
              worldRef.current?.focus(sel);
            }}
          >
            <span className={`dot state-${state}`} title={STATE_LABELS[state]} />
            <span className="roster-name">{thread.title || "Untitled"}</span>
            <span className="muted small">{timeAgo(thread.latestUserMessageAt ?? thread.updatedAt)}</span>
          </button>
        ))}
        {roster.length === 0 && <p className="muted">No workers yet. Recruit one above.</p>}
        {archived > 0 && (
          <button className="btn wide archive-link" onClick={() => (sfx.building(), setSelection({ kind: "library", envId, projectId }))}>
            <PixelIcon name="archive" /> Archive: {archived} imported conversation{archived === 1 ? "" : "s"}
          </button>
        )}
      </div>
      {env.summary.kind !== "hermes" && <RetireProject key={`retire:${envId}:${projectId}`} envId={envId} projectId={projectId} />}
    </aside>
  );
}

/**
 * Retire a project: remove it from T3 on this machine (the folder stays on disk). Its threads go
 * with it, so it says how many and asks first; never while crew are mid-turn there.
 */
function RetireProject({ envId, projectId }: { envId: string; projectId: string }) {
  const env = useGame((s) => s.envs[envId]);
  const elsewhere = useGame((s) => groupFor(s, envId, projectId)?.members.filter((m) => m.env.summary.id !== envId).map((m) => m.env.summary.label).join(", ") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const project = env?.projects[projectId];
  if (!env || !project) return null;
  const threads = Object.values(env.threads).filter((t) => t.projectId === projectId);
  const running = threads.filter((t) => t.latestTurn?.state === "running").length;
  const machine = env.summary.label;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const retire = async () => {
    const lines = [
      `Retire “${project.title}” on ${machine}?`,
      `T3 there stops listing it. The folder ${project.workspaceRoot} stays on disk.`,
      threads.length ? `Its ${plural(threads.length, "conversation")} (archived ones included) will be deleted from T3 too.` : "It has no conversations.",
      elsewhere ? `It stays on ${elsewhere}.` : "",
    ].filter(Boolean);
    if (!window.confirm(lines.join("\n\n"))) return;
    setBusy(true);
    setError(undefined);
    try {
      await envClient(envId)!.retireProject(projectId, threads.length > 0);
      sfx.building();
      addLog({ tone: "info", text: `Project ${project.title} retired on ${machine}`, envId });
      setSelection(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      sfx.error();
      logError(`Retiring ${project.title} on ${machine} failed`, err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="retire-project">
      <summary className="small muted">Retire project</summary>
      <p className="muted small">Removes it from T3 on {machine}{elsewhere ? ` (it stays on ${elsewhere})` : ""}. The folder stays on disk{threads.length ? `; its ${plural(threads.length, "conversation")} are deleted from T3` : ""}.</p>
      {running > 0 && <p className="orange small">{plural(running, "crew member")} {running === 1 ? "is" : "are"} mid-turn here. Wait for them or stop them first.</p>}
      {error && <p className="orange small" role="alert">{error}</p>}
      <button className="btn wide danger" disabled={busy || running > 0 || env.connection !== "live"} onClick={() => void retire()}>
        {busy ? "Retiring…" : `Retire on ${machine}`}
      </button>
    </details>
  );
}

/**
 * The recruit form: a new crew member on this project and machine. `draftKey` shares one typed
 * order across forms (the New request sheet keeps it whichever project you pick); `onRecruited`
 * runs once the thread exists.
 */
export function RecruitForm({ envId, projectId, draftKey, onRecruited }: { envId: string; projectId: string; draftKey?: string; onRecruited?: () => void }) {
  const env = useGame((s) => s.envs[envId]);
  const project = env?.projects[projectId];
  const providers = usableProviders(env?.providers ?? []);
  const prefs = useMemo(() => loadPrefs(envId), [envId]);
  const commandPrefs = useGame((s) => s.prefs);
  const sources = { prefs: commandPrefs, t3: env?.t3Defaults, projectId, projectDefault: project?.defaultModelSelection };

  const [hermesProfile, setHermesProfile] = useState(prefs.hermesProfile ?? "default");
  const [text, setText, clearText] = useDraft(draftKey ?? `recruit:${envId}:${projectId}`);
  // Set once you change the model here; until then it follows your defaults (which may load late).
  const [selection, setSelectionState] = useState<ModelSelection>();
  const [savingDefault, setSavingDefault] = useState(false);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(prefs.runtimeMode ?? "full-access");
  const [planFirst, setPlanFirst] = useState(!!prefs.planFirst);
  const canPlan = env?.summary.kind !== "hermes";
  const [sending, setSending] = useState(false);
  const [workspace, setWorkspace] = useState<RecruitWorkspace>(() => ({
    mode: env?.summary.kind !== "hermes" && project?.defaultThreadEnvMode === "worktree" ? "worktree" : "local",
  }));
  const [recruitError, setRecruitError] = useState<string>();

  // Providers and defaults arrive after connecting; start from them once they do.
  const current = selection ?? startingSelection(providers, sources);
  const provider = providers.find((p) => p.instanceId === current?.instanceId);
  const runtimeModes = provider?.runtimeModes?.length ? provider.runtimeModes : RUNTIME_MODES;
  const currentRuntimeMode = runtimeModes.some((mode) => mode.id === runtimeMode) ? runtimeMode : runtimeModes[0].id;
  const model = provider?.models.find((m) => m.slug === current?.model);
  const descriptors = model?.capabilities?.optionDescriptors ?? [];

  const optionValue = (id: string): string | boolean | undefined => current?.options?.find((o) => o.id === id)?.value;
  const setOption = (id: string, value: string | boolean) => {
    if (!current) return;
    const options = (current.options ?? []).filter((o) => o.id !== id);
    setSelectionState({ ...current, options: [...options, { id, value }] });
  };

  const recruit = async () => {
    const task = text.trim();
    if (!task || !current || sending) return;
    setSending(true);
    setRecruitError(undefined);
    try {
      // Scratch isn't a repository: T3 gives the thread its own folder inside it instead.
      const threadId = await envClient(envId)!.recruit({ projectId, text: task, modelSelection: current, runtimeMode: currentRuntimeMode,
        interactionMode: canPlan && planFirst ? "plan" : "default", workspace: isScratch(project) ? undefined : workspace, hermesProfile });
      savePrefs(envId, { runtimeMode: currentRuntimeMode, hermesProfile, planFirst });
      sfx.recruit();
      addLog({ tone: "good", text: `New worker recruited at ${project?.title ?? "base"}`, envId, threadId });
      clearText();
      setSelection({ kind: "unit", envId, threadId });
      onRecruited?.();
    } catch (err) {
      setRecruitError(err instanceof Error ? err.message : String(err));
      sfx.error();
      logError("Recruit failed", err);
    } finally {
      setSending(false);
    }
  };

  if (providers.length === 0) {
    return <p className="muted">{env?.connection === "live" ? "No agent providers are ready on this base." : "Connecting…"}</p>;
  }

  return (
    <div className="recruit">
      <h3>Recruit worker</h3>
      {env?.summary.kind === "hermes" && <HermesBotPicker envId={envId} value={hermesProfile} onChange={setHermesProfile} disabled={sending} />}
      <textarea
        value={text}
        rows={3}
        placeholder="What should the new worker do? (Ctrl+Enter to recruit)"
        disabled={sending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void recruit();
          }
        }}
      />
      <div className="recruit-options">
        <select
          value={current?.instanceId}
          onChange={(e) => {
            setSelectionState(providerDefault(providers.find((x) => x.instanceId === e.target.value)!, sources));
          }}
        >
          {providers.map((p) => (
            <option key={p.instanceId} value={p.instanceId}>
              {p.displayName ?? p.instanceId}
            </option>
          ))}
        </select>
        <select value={current?.model} onChange={(e) => current && setSelectionState({ instanceId: current.instanceId, model: e.target.value })}>
          {provider?.models.map((m) => (
            <option key={m.slug} value={m.slug}>
              {m.name}
            </option>
          ))}
        </select>
        {descriptors
          .filter((d) => d.type === "select" && d.options?.length)
          .map((d) => (
            <select
              key={d.id}
              title={d.label}
              value={String(optionValue(d.id) ?? d.options!.find((o) => o.isDefault)?.id ?? d.options![0].id)}
              onChange={(e) => setOption(d.id, e.target.value)}
            >
              {d.options!.map((o) => (
                <option key={o.id} value={o.id}>
                  {d.label}: {o.label}
                </option>
              ))}
            </select>
          ))}
        <select value={currentRuntimeMode} onChange={(e) => setRuntimeMode(e.target.value as RuntimeMode)} title="Permissions">
          {runtimeModes.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        {current && env?.summary.kind !== "hermes" && (isMyDefault(commandPrefs, current)
          ? <span className="small muted default-mark" title="New requests start on this model on every machine that has it">★ Default</span>
          : <button className="btn small" disabled={savingDefault} title="Start new requests on this provider and model, on every machine and device"
            onClick={() => {
              setSavingDefault(true);
              makeDefault(current).catch((err) => { setRecruitError(`Couldn't save the default: ${err instanceof Error ? err.message : String(err)}`); sfx.error(); })
                .finally(() => setSavingDefault(false));
            }}>☆ Make default</button>)}
      </div>
      {canPlan && (
        <label className="plan-first small" title="The recruit proposes a plan first; it builds only after you approve the plan in its panel.">
          <input type="checkbox" checked={planFirst} onChange={(e) => setPlanFirst(e.target.checked)} /> Plan first: propose before building
        </label>
      )}
      <WorkspacePicker envId={envId} projectId={projectId} value={workspace} onChange={setWorkspace} disabled={sending} />
      {recruitError && <p className="small" role="alert">{recruitError}</p>}
      <button className="btn primary wide" disabled={sending || !text.trim() || !current || env?.connection !== "live"} onClick={() => void recruit()}>
        {sending ? "Recruiting…" : <><PixelIcon name="recruit" /> Recruit</>}
      </button>
    </div>
  );
}

/** One tab per machine working on this project; recruiting and the roster follow the tab. */
function MachineTabs({ envId, projectId }: { envId: string; projectId: string }) {
  const envs = useGame((s) => s.envs);
  const members = useMemo(() => groupFor(useGame.getState(), envId, projectId)?.members ?? [], [envs, envId, projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (members.length < 2) return null;
  return (
    <div className="machine-tabs" role="tablist">
      {members.map((m) => {
        const id = m.env.summary.id;
        const active = id === envId;
        return (
          <button
            key={id}
            role="tab"
            aria-selected={active}
            className={`machine-tab ${active ? "active" : ""}`}
            style={{ ["--team" as string]: css(hudAccent(stationColor(useGame.getState(), id), useGame.getState().artStyle)) }}
            onClick={() => {
              sfx.select();
              setSelection({ kind: "building", envId: id, projectId: m.project.id });
            }}
          >
            {m.env.summary.label}
          </button>
        );
      })}
    </div>
  );
}
