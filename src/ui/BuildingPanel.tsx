import { useMemo, useState } from "react";
import { sfx } from "../game/sfx";
import { worldRef } from "../game/world";
import { addLog, setSelection, useGame } from "../store";
import { unitState } from "../t3/derive";
import { envClient, logError } from "../t3/environment";
import type { ModelSelection, Provider, RuntimeMode } from "../t3/types";
import { STATE_LABELS, timeAgo } from "./util";

const RUNTIME_MODES: Array<{ id: RuntimeMode; label: string }> = [
  { id: "full-access", label: "Full access" },
  { id: "auto", label: "Auto" },
  { id: "auto-accept-edits", label: "Auto-accept edits" },
  { id: "approval-required", label: "Ask before acting" },
];

interface RecruitPrefs {
  modelSelection?: ModelSelection;
  runtimeMode?: RuntimeMode;
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

function usable(providers: Provider[]): Provider[] {
  return providers.filter((p) => p.enabled && p.installed && p.models.length > 0);
}

function defaultSelection(providers: Provider[], preferred: Array<ModelSelection | null | undefined>): ModelSelection | undefined {
  for (const sel of preferred) {
    if (!sel) continue;
    const provider = providers.find((p) => p.instanceId === sel.instanceId);
    if (provider?.models.some((m) => m.slug === sel.model)) return sel;
  }
  const provider = providers[0];
  if (!provider) return undefined;
  const model = provider.models.find((m) => m.isDefault) ?? provider.models[0];
  return { instanceId: provider.instanceId, model: model.slug };
}

export function BuildingPanel({ envId, projectId }: { envId: string; projectId: string }) {
  const env = useGame((s) => s.envs[envId]);
  const project = env?.projects[projectId];

  const roster = useMemo(() => {
    if (!env) return [];
    return Object.values(env.threads)
      .filter((t) => t.projectId === projectId)
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

  const awake = roster.filter((r) => r.state !== "sleeping");
  const asleep = roster.filter((r) => r.state === "sleeping");

  return (
    <aside className="panel building-panel">
      <header className="panel-head">
        <div className="portrait building" />
        <div className="panel-title">
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

      <RecruitForm envId={envId} projectId={projectId} />

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
      </div>
    </aside>
  );
}

function RecruitForm({ envId, projectId }: { envId: string; projectId: string }) {
  const env = useGame((s) => s.envs[envId]);
  const project = env?.projects[projectId];
  const providers = usable(env?.providers ?? []);
  const prefs = useMemo(() => loadPrefs(envId), [envId]);

  const [text, setText] = useState("");
  const [selection, setSelectionState] = useState<ModelSelection | undefined>(() =>
    defaultSelection(providers, [prefs.modelSelection, project?.defaultModelSelection]),
  );
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(prefs.runtimeMode ?? "full-access");
  const [sending, setSending] = useState(false);

  // Providers arrive after connecting; pick a default once they do.
  const current = selection ?? defaultSelection(providers, [prefs.modelSelection, project?.defaultModelSelection]);
  const provider = providers.find((p) => p.instanceId === current?.instanceId);
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
    try {
      const threadId = await envClient(envId)!.recruit({ projectId, text: task, modelSelection: current, runtimeMode });
      savePrefs(envId, { modelSelection: current, runtimeMode });
      sfx.recruit();
      addLog({ tone: "good", text: `New worker recruited at ${project?.title ?? "base"}`, envId, threadId });
      setText("");
      setSelection({ kind: "unit", envId, threadId });
    } catch (err) {
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
            const p = providers.find((x) => x.instanceId === e.target.value)!;
            const m = p.models.find((x) => x.isDefault) ?? p.models[0];
            setSelectionState({ instanceId: p.instanceId, model: m.slug });
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
        <select value={runtimeMode} onChange={(e) => setRuntimeMode(e.target.value as RuntimeMode)} title="Permissions">
          {RUNTIME_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <button className="btn primary wide" disabled={sending || !text.trim() || !current || env?.connection !== "live"} onClick={() => void recruit()}>
        {sending ? "Recruiting…" : "⚒ Recruit"}
      </button>
    </div>
  );
}
