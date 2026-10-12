import { createPortal } from 'react-dom';
import { useCallback, useEffect, useState } from 'react';
import type { HermesAction, HermesBot, HermesBotDetail, HermesJob, HermesJobs, HermesRun } from '../../shared/hermes';
import { hermesRequest } from '../t3/hermes';
import { setSelection, useGame } from '../store';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const date = (value?: string | null) => value ? new Date(value).toLocaleString() : '—';
type Tab = 'identity' | 'memory' | 'capabilities' | 'routines';

export function HermesPanel({ envId, onClose }: { envId: string; onClose: () => void }) {
  const env = useGame(s => s.envs[envId]);
  const [bots, setBots] = useState<HermesBot[]>([]);
  const [profile, setProfile] = useState('default');
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [warning, setWarning] = useState<string>();
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => {
    return hermesRequest<HermesBot[]>(envId, 'profiles.list').then(setBots).catch(e => setError(message(e)));
  }, [envId]);
  useEffect(() => { void reload(); }, [reload, revision]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  const refresh = () => setRevision(n => n + 1);
  return createPortal(<div className="modal-backdrop" onClick={onClose}>
    <section className="modal hermes-modal" role="dialog" aria-modal="true" aria-labelledby="hermes-heading" onClick={e => e.stopPropagation()}>
      <header className="panel-head"><div><h2 id="hermes-heading">Hermes bots & routines</h2><span className="muted small">{env?.summary.label}</span></div>
        <span className="spacer" /><button className="icon-btn" aria-label="Close Hermes management" onClick={onClose}>✕</button></header>
      {error && <p role="alert">{error}</p>}{warning && <p role="alert">{warning}</p>}
      <div className="hermes-layout">
        <nav className="hermes-roster" aria-label="Hermes bots">
          {bots.map(bot => <button key={bot.name} className={`btn wide ${profile === bot.name && !creating ? 'primary' : ''}`} onClick={() => { setProfile(bot.name); setCreating(false); }}>
            <strong>{bot.title}</strong><span className="muted small">{bot.name} · {bot.model || 'No model configured'}</span>
          </button>)}
          <button className="btn wide" onClick={() => setCreating(true)}>+ New bot</button>
          <button className="btn wide" onClick={refresh}>Refresh</button>
          <p className="muted small">Existing Hermes profiles appear automatically. Each bot owns its memory and configuration.</p>
        </nav>
        <div className="hermes-content">
          {creating ? <NewBot envId={envId} bots={bots} onCreated={name => { setProfile(name); setCreating(false); refresh(); }} />
            : <BotEditor key={`${envId}:${profile}:${revision}`} envId={envId} profile={profile} onSaved={() => void reload()} onDeleted={warning => { setWarning(warning); setProfile('default'); refresh(); }} onClose={onClose} />}
        </div>
      </div>
    </section>
  </div>, document.body);
}

function NewBot({ envId, bots, onCreated }: { envId: string; bots: HermesBot[]; onCreated: (name: string) => void }) {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [cloneFrom, setCloneFrom] = useState('default');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return <form onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError(undefined);
    try { await hermesRequest(envId, 'profiles.create', name, { title: title || name, description, cloneFrom }); onCreated(name); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }}>
    <h3>Create a bot</h3>
    <label className="hermes-field">Profile name<input autoFocus required pattern="[a-z0-9][a-z0-9_-]{0,63}" value={name} onChange={e => setName(e.target.value)} placeholder="ci-watcher" /></label>
    <label className="hermes-field">Display name<input value={title} onChange={e => setTitle(e.target.value)} placeholder="CI Watcher" /></label>
    <label className="hermes-field">Role<textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} placeholder="Checks failed builds and keeps track of recurring failures." /></label>
    <label className="hermes-field">Start from<select value={cloneFrom} onChange={e => setCloneFrom(e.target.value)}>
      <option value="">Fresh profile</option>{bots.map(b => <option key={b.name} value={b.name}>Clone {b.title}</option>)}
    </select></label>
    <p className="muted small">Cloning copies configuration, skills, personality, and current memories. Sessions and routines start empty. OAuth providers may require a separate login for the new bot.</p>
    {error && <p role="alert">{error}</p>}<button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create bot'}</button>
  </form>;
}

function BotEditor({ envId, profile, onSaved, onDeleted, onClose }: { envId: string; profile: string; onSaved: () => void; onDeleted: (warning?: string) => void; onClose: () => void }) {
  const [bot, setBot] = useState<HermesBotDetail>();
  const [tab, setTab] = useState<Tab>('identity');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    hermesRequest<HermesBotDetail>(envId, 'profiles.get', profile, undefined, controller.signal).then(setBot)
      .catch(e => { if (!controller.signal.aborted) setError(message(e)); });
    return () => controller.abort();
  }, [envId, profile]);
  const edit = (patch: Partial<HermesBotDetail>) => setBot(b => b ? { ...b, ...patch } : b);
  const perform = async (action: HermesAction | 'chat.open', body?: Record<string, unknown>) => {
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const result = await hermesRequest<{ threadId?: string; warning?: string }>(envId, action, profile, body);
      if (action === 'chat.open' && result.threadId) { useGame.setState({ showEnvManager: false }); setSelection({ kind: 'unit', envId, threadId: result.threadId }); onClose(); }
      else if (action === 'profiles.delete') onDeleted(result.warning);
      else { setNotice('Saved. Changes apply on the bot’s next turn.'); onSaved(); }
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  if (!bot) return <p role={error ? 'alert' : undefined}>{error || 'Loading bot…'}</p>;
  return <>
    <div className="hermes-actions"><h3>{bot.title}</h3><span className="spacer" />
      <button className="btn primary" disabled={busy} onClick={() => void perform('chat.open')}>Open Bot Chat</button>
      {!bot.isDefault && <button className="btn danger" disabled={busy} onClick={() => {
        if (confirm(`Delete Hermes bot "${profile}" and its memory, sessions, configuration, and routines?`)) void perform('profiles.delete');
      }}>Delete bot</button>}
    </div>
    <p className="muted small">Bot Chat keeps one ongoing conversation. You can ask this bot to message another bot by name; Hermes handles the handoff. Routine deliveries appear here as the native chat refreshes.</p>
    <div className="hermes-tabs" role="tablist" aria-label="Bot settings">
      {(['identity', 'memory', 'capabilities', 'routines'] as Tab[]).map(t => <button key={t} role="tab" aria-selected={tab === t} className={`btn ${tab === t ? 'primary' : ''}`} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
    </div>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {tab === 'identity' && <form onSubmit={e => { e.preventDefault(); void perform('profiles.update', { title: bot.title, description: bot.description, soul: bot.soul, ...(bot.model ? { model: bot.model, provider: bot.provider } : {}) }); }}>
      <label className="hermes-field">Display name<input value={bot.title} onChange={e => edit({ title: e.target.value })} /></label>
      <label className="hermes-field">Role<textarea rows={2} value={bot.description} onChange={e => edit({ description: e.target.value })} /></label>
      <div className="hermes-columns"><label className="hermes-field">Model<input value={bot.model || ''} onChange={e => edit({ model: e.target.value })} /></label>
        <label className="hermes-field">Provider<input value={bot.provider || ''} onChange={e => edit({ provider: e.target.value })} /></label></div>
      <label className="hermes-field">Personality & standing instructions (SOUL.md)<textarea rows={10} value={bot.soul} onChange={e => edit({ soul: e.target.value })} /></label>
      <button className="btn primary" disabled={busy}>Save identity</button>
    </form>}
    {tab === 'memory' && <form onSubmit={e => { e.preventDefault(); void perform('profiles.update', { memory: bot.memory, userMemory: bot.userMemory }); }}>
      <p className="muted small">Memory provider: {bot.memoryProvider}. These are the bot’s local curated memory files; external memory stores are managed by their provider.</p>
      <label className="hermes-field">Bot memory (MEMORY.md)<textarea rows={12} value={bot.memory} onChange={e => edit({ memory: e.target.value })} /></label>
      <label className="hermes-field">User preferences (USER.md)<textarea rows={7} value={bot.userMemory} onChange={e => edit({ userMemory: e.target.value })} /></label>
      <button className="btn primary" disabled={busy}>Save memory</button>
    </form>}
    {tab === 'capabilities' && <form onSubmit={e => { e.preventDefault(); void perform('profiles.update', { skills: bot.skills, toolsets: bot.toolsets, mcpServers: bot.mcpServers }); }}>
      <h3>Skills</h3><div className="hermes-checklist">{bot.skills.map(skill => <label key={skill.name}><input type="checkbox" checked={skill.enabled} onChange={e => edit({ skills: bot.skills.map(s => s.name === skill.name ? { ...s, enabled: e.target.checked } : s) })} />{skill.name}</label>)}</div>
      <h3>Tools for T3 Command sessions</h3><p className="muted small">Toolsets can overlap. “hermes-acp” provides the standard coding tools; add “cronjob” for scheduling through chat. A routine uses Hermes’s separate cron tool configuration.</p>
      <div className="hermes-checklist">{bot.availableToolsets.map(tool => <label key={tool.name} title={tool.description}><input type="checkbox" checked={bot.toolsets.includes(tool.name)} onChange={e => edit({ toolsets: e.target.checked ? [...bot.toolsets, tool.name] : bot.toolsets.filter(t => t !== tool.name) })} />{tool.name}</label>)}</div>
      <h3>MCP servers</h3><p className="muted small">Enable or disable servers already configured in Hermes. Credentials stay on the host.</p>
      {bot.mcpServers.length ? <div className="hermes-checklist">{bot.mcpServers.map(server => <label key={server.name}><input type="checkbox" checked={server.enabled} onChange={e => edit({ mcpServers: bot.mcpServers.map(s => s.name === server.name ? { ...s, enabled: e.target.checked } : s) })} />{server.name}</label>)}</div> : <p className="muted">No MCP servers configured.</p>}
      <button className="btn primary" disabled={busy}>Save capabilities</button>
    </form>}
    {tab === 'routines' && <Routines key={profile} envId={envId} profile={profile} />}
  </>;
}

function Routines({ envId, profile }: { envId: string; profile: string }) {
  const [data, setData] = useState<HermesJobs>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<HermesJob | 'new'>();
  const [history, setHistory] = useState<{ job: HermesJob; runs: HermesRun[]; outputs: Array<{ name: string; text: string }> }>();
  const reload = useCallback(async () => {
    const result = await hermesRequest<HermesJobs>(envId, 'jobs.list', profile); setData(result);
  }, [envId, profile]);
  useEffect(() => {
    let alive = true;
    const read = () => { if (alive) void reload().catch(e => { if (alive) setError(message(e)); }); };
    read(); const timer = setInterval(read, 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, [reload]);
  const act = async (job: HermesJob, action: HermesAction) => {
    setBusy(true); setError(undefined);
    try {
      if (action === 'jobs.runs') {
        const [runs, outputs] = await Promise.all([
          hermesRequest<HermesRun[]>(envId, 'jobs.runs', profile, { id: job.id }),
          hermesRequest<Array<{ name: string; text: string }>>(envId, 'jobs.output', profile, { id: job.id }),
        ]); setHistory({ job, runs, outputs });
      } else { await hermesRequest(envId, action, profile, { id: job.id }); await reload(); }
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  if (editing) return <RoutineForm key={editing === 'new' ? 'new' : editing.id} envId={envId} profile={profile} job={editing === 'new' ? undefined : editing} onCancel={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); void reload().catch(e => setError(message(e))); }} />;
  return <>
    <div className="hermes-actions"><h3>Routines</h3><span className="spacer" /><button className="btn" disabled={busy} onClick={() => setEditing('new')}>+ New routine</button></div>
    {data && <p role="status" className="muted small">Scheduler: {data.scheduler.running === true ? 'running' : data.scheduler.running === false ? 'offline — start a Hermes gateway or Serve backend for this bot' : 'status unknown'}
      {data.scheduler.heartbeatAge != null && ` · heartbeat ${Math.round(data.scheduler.heartbeatAge)}s ago`}{data.scheduler.error && ` · ${data.scheduler.error}`}</p>}
    {error && <p role="alert">{error}</p>}
    {data?.jobs.length === 0 && <p className="muted">No routines for this bot.</p>}
    {data?.jobs.map(job => <article className="hermes-job" key={job.id}>
      <strong>{job.name || job.id}</strong><span className="muted small"> · {job.state || (job.enabled ? 'scheduled' : 'paused')}</span>
      <p className="small">{job.schedule.display || JSON.stringify(job.schedule)} · Next: {date(job.next_run_at)}</p>
      <p className="muted small">Last: {date(job.last_run_at)} · {job.last_status || 'Never run'}</p>
      {[job.last_error, job.last_fire_error, job.last_delivery_error].filter(Boolean).map((err, i) => <p role="alert" className="small" key={i}>{typeof err === 'string' ? err : JSON.stringify(err)}</p>)}
      <div className="hermes-actions">
        <button className="btn" disabled={busy} onClick={() => setEditing(job)}>Edit</button>
        <button className="btn" disabled={busy} onClick={() => void act(job, job.enabled ? 'jobs.pause' : 'jobs.resume')}>{job.enabled ? 'Pause' : 'Resume'}</button>
        <button className="btn" disabled={busy || data.scheduler.running !== true} onClick={() => void act(job, 'jobs.trigger')}>Run now</button>
        <button className="btn" disabled={busy} onClick={() => void act(job, 'jobs.runs')}>History & results</button>
        <button className="btn danger" disabled={busy} onClick={() => { if (confirm(`Delete routine "${job.name || job.id}"?`)) void act(job, 'jobs.delete'); }}>Delete</button>
      </div>
    </article>)}
    {history && <div className="hermes-history"><div className="hermes-actions"><h3>{history.job.name} · Recent runs</h3><span className="spacer" /><button className="btn" onClick={() => setHistory(undefined)}>Close history</button></div>
      {!history.runs.length && <p className="muted">No recorded executions.</p>}
      {history.runs.map(run => <p className="small" key={run.id}>{date(run.started_at || run.claimed_at)} · {run.status}{run.error && ` · ${run.error}`}</p>)}
      {history.outputs.map(output => <details key={output.name}><summary>{output.name}</summary><pre>{output.text}</pre></details>)}
    </div>}
  </>;
}

function RoutineForm({ envId, profile, job, onCancel, onSaved }: { envId: string; profile: string; job?: HermesJob; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState(job?.name || '');
  const [schedule, setSchedule] = useState(job?.schedule.display || 'every 1h');
  const [prompt, setPrompt] = useState(job?.prompt || '');
  const [model, setModel] = useState(job?.model || '');
  const [provider, setProvider] = useState(job?.provider || '');
  const [workdir, setWorkdir] = useState(job?.workdir || '');
  const [skills, setSkills] = useState(job?.skills?.join(', ') || '');
  const [deliver, setDeliver] = useState(job?.deliver || 'local');
  const [mode, setMode] = useState(job?.no_agent ? 'script' : job?.monitor_url || job?.monitor_script ? 'monitor' : 'agent');
  const [script, setScript] = useState(job?.script || '');
  const [monitorUrl, setMonitorUrl] = useState(job?.monitor_url || '');
  const [monitorScript, setMonitorScript] = useState(job?.monitor_script || '');
  const [reasoning, setReasoning] = useState(job?.reasoning_effort || '');
  const [continuity, setContinuity] = useState(job?.context_from?.includes('self') || false);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return <form onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError(undefined);
    try {
      const body = { ...(job ? { id: job.id } : { paused }), name, schedule, prompt, model: model || null, provider: provider || null,
        workdir: workdir || null, skills: skills.split(',').map(s => s.trim()).filter(Boolean), deliver,
        script: script || null, no_agent: mode === 'script', monitor_url: mode === 'monitor' ? monitorUrl || null : null,
        monitor_script: mode === 'monitor' ? monitorScript || null : null, reasoning_effort: reasoning || null,
        context_from: [...(job?.context_from || []).filter(s => s !== 'self'), ...(continuity ? ['self'] : [])] };
      await hermesRequest(envId, job ? 'jobs.update' : 'jobs.create', profile, body); onSaved();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }}>
    <h3>{job ? 'Edit routine' : 'New routine'}</h3>
    <label className="hermes-field">Name<input required value={name} onChange={e => setName(e.target.value)} /></label>
    <label className="hermes-field">Schedule<input required value={schedule} onChange={e => setSchedule(e.target.value)} placeholder="every 2h, in 30m, or 0 9 * * *" /></label>
    <p className="muted small">Hermes interprets the schedule using its configured timezone.</p>
    <label className="hermes-field">Run type<select value={mode} onChange={e => setMode(e.target.value)}><option value="agent">Agent task</option><option value="script">Script only (no LLM)</option><option value="monitor">Change monitor</option></select></label>
    {mode !== 'script' && <label className="hermes-field">Task<textarea rows={5} required value={prompt} onChange={e => setPrompt(e.target.value)} /></label>}
    <label className="hermes-field">{mode === 'script' ? 'Script path' : 'Optional context script path'}<input required={mode === 'script'} value={script} onChange={e => setScript(e.target.value)} placeholder="Script name or path inside this bot’s scripts directory" /></label>
    {mode === 'monitor' && <><label className="hermes-field">Monitor URL<input type="url" value={monitorUrl} onChange={e => setMonitorUrl(e.target.value)} /></label>
      <label className="hermes-field">Or monitor script in this bot’s scripts directory<input value={monitorScript} onChange={e => setMonitorScript(e.target.value)} /></label></>}
    <label className="hermes-field">Working directory<input value={workdir} onChange={e => setWorkdir(e.target.value)} placeholder="Absolute project path" /></label>
    <label className="hermes-field">Result delivery<select value={deliver} onChange={e => setDeliver(e.target.value)}>
      <option value="local">Local output (view in History & results)</option><option value={`bot-chat:${profile}`}>This bot’s Bot Chat</option>
      {!['local', `bot-chat:${profile}`].includes(deliver) && <option value={deliver}>{deliver}</option>}
    </select></label>
    <details><summary>Model, skills & continuity</summary>
      <div className="hermes-columns"><label className="hermes-field">Model pin<input value={model} onChange={e => setModel(e.target.value)} placeholder="Follow Hermes configuration" /></label>
        <label className="hermes-field">Provider pin<input value={provider} onChange={e => setProvider(e.target.value)} /></label></div>
      <label className="hermes-field">Reasoning effort<select value={reasoning} onChange={e => setReasoning(e.target.value)}>{['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].map(r => <option key={r} value={r}>{r || 'Follow Hermes configuration'}</option>)}</select></label>
      <label className="hermes-field">Skills (comma separated)<input value={skills} onChange={e => setSkills(e.target.value)} /></label>
      <label><input type="checkbox" checked={continuity} onChange={e => setContinuity(e.target.checked)} />Remember the previous run’s output</label>
    </details>
    {!job && <label className="hermes-field"><span><input type="checkbox" checked={paused} onChange={e => setPaused(e.target.checked)} />Create paused</span></label>}
    {error && <p role="alert">{error}</p>}
    <div className="hermes-actions"><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save routine'}</button><button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>;
}
