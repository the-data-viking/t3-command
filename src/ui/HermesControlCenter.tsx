import { useDraft } from './drafts';
import { useEffect, useState } from 'react';
import { HERMES_EDIT_PERMISSIONS, type HermesJobs } from '../../shared/hermes';
import { worldRef } from '../game/world';
import { css, hudAccent } from '../game/theme';
import { setSelection, useGame } from '../store';
import { botColor, botOperators, BOT_STATE_LABELS } from '../t3/bots';
import { hermesRequest, refreshHermesBots } from '../t3/hermes';
import { HermesPanel } from './HermesPanel';
import { openHost } from '../store';
import { envClient } from '../t3/environment';
import type { RuntimeMode } from '../t3/types';
import { HermesPermissions } from './HermesPermissions';
import { PixelLabel } from "./PixelArt";

export function HermesMark({ className = '' }: { className?: string }) {
  return <span className={`hermes-mark ${className}`} aria-hidden="true"><svg viewBox="0 0 40 40" fill="none">
    <path d="M20 3 37 20 20 37 3 20Z" stroke="currentColor" strokeWidth="2" />
    <path d="M13 12v16m14-16v16M13 20h14" stroke="currentColor" strokeWidth="3" />
  </svg></span>;
}
export function BotPortrait({ profile }: { profile: string }) {
  return <span className="bot-portrait" style={{ '--bot': css(hudAccent(botColor(profile), useGame.getState().artStyle)) } as React.CSSProperties} aria-hidden="true">
    <span>{profile.slice(0, 2).toUpperCase()}</span>
  </span>;
}

export function HermesControlCenter({ envId, profile }: { envId: string; profile?: string }) {
  useGame((s) => s.artStyle); // Re-render on theme change: team and bot colours deepen on light HUDs.
  const envs = useGame(s => s.envs);
  const catalog = useGame(s => s.hermesCatalog);
  const operators = botOperators({ envs, hermesCatalog: catalog });
  const selected = operators.find(b => b.name === profile) ?? operators[0];
  const env = envs[envId];
  const targets = Object.values(envs).filter(e => e.summary.kind !== 'hermes');
  const [manage, setManage] = useState<{ profile: string; tab?: 'identity' | 'routines' }>();
  const [jobs, setJobs] = useState<HermesJobs>();
  const [error, setError] = useState<string>();
  const [opening, setOpening] = useState(false);
  const selectedProfile = selected?.name;
  const botChat = selected?.sessions.find(s => s.thread.hermesBotChat && envs[s.envId]?.connection === 'live');
  useEffect(() => { void refreshHermesBots(); }, []);
  useEffect(() => {
    if (!selectedProfile) return;
    const controller = new AbortController();
    const load = () => hermesRequest<HermesJobs>(envId, 'jobs.list', selectedProfile, undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) { setJobs(result); setError(undefined); } })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    setJobs(undefined); setError(undefined); void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [envId, selectedProfile]);

  const openChat = async () => {
    if (!selected) return;
    const existing = selected.sessions.find(s => s.thread.hermesBotChat && envs[s.envId]?.connection === 'live');
    if (existing) { setSelection({ kind: 'unit', envId: existing.envId, threadId: existing.thread.id }); return; }
    setOpening(true); setError(undefined);
    try {
      const { threadId } = await hermesRequest<{ threadId: string }>(envId, 'chat.open', selected.name);
      setSelection({ kind: 'unit', envId, threadId });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setOpening(false); }
  };

  return <aside className="panel hermes-control" aria-label="Hermes control center">
    <header className="panel-head"><HermesMark /><div className="panel-title"><span className="title-tab panel-kind"><PixelLabel text="Operations" /></span>
      <h2>Hermes control center</h2><div className="muted small">Persistent operators · memory · routines</div></div>
      <button className="icon-btn" aria-label="Close control center" onClick={() => setSelection(null)}>✕</button></header>
    <div className="ops-summary"><span><strong>{operators.length}</strong> operators</span>
      <span><strong>{operators.filter(b => b.observed && b.state === 'working').length}</strong> working</span>
      <span><strong>{targets.filter(e => e.connection === 'live').length}/{targets.length}</strong> environments online</span></div>
    <div className="ops-scroll">
      {catalog?.error && <p role="alert">Bot directory: {catalog.error}. Last known operators are shown.</p>}
      {env?.connection !== 'live' && <p role="status" className="muted">Hermes connection: {env?.connection ?? 'removed'}. Activity is last known.</p>}
      <div className="ops-section-head"><h3>Operators</h3><button className="btn" onClick={() => setManage({ profile: selectedProfile ?? 'default' })}>Manage bots</button></div>
      <div className="operator-list">{operators.map(bot => <button key={bot.name} className={`operator-card ${selected?.name === bot.name ? 'selected' : ''}`}
        aria-pressed={selected?.name === bot.name} onClick={() => setSelection({ kind: 'hermes', envId, profile: bot.name })}>
        <BotPortrait profile={bot.name} /><span><strong>{bot.title}</strong><span className="muted small">{bot.description || 'Persistent Hermes operator'}</span>
          <span className={`crew-state st-${bot.observed ? bot.state : 'idle'}`}>{bot.observed ? BOT_STATE_LABELS[bot.state] : 'Activity not observed'}</span></span>
      </button>)}</div>
      {!operators.length && <p className="muted">{catalog?.loaded ? 'No operators found.' : 'Loading the bot directory…'}</p>}
      {selected && <section className="operator-detail">
        <div className="ops-section-head"><h3>{selected.title}</h3><span className="muted small">{selected.name}</span></div>
        <p className="small">{selected.description || 'Give this operator a role and standing instructions in its identity settings.'}</p>
        <div className="hermes-actions"><button className="btn primary" disabled={opening || env?.connection !== 'live'} onClick={() => void openChat()}>{opening ? 'Opening…' : 'Talk to bot'}</button>
          <button className="btn" onClick={() => setManage({ profile: selected.name, tab: 'identity' })}>Identity & memory</button>
          <button className="btn" onClick={() => setManage({ profile: selected.name, tab: 'routines' })}>Routines{jobs ? ` (${jobs.jobs.length})` : ''}</button></div>
        <HermesPermissions key={selected.name} envId={botChat?.envId ?? envId} threadId={botChat?.thread.id} profile={selected.name} />
        {jobs && <p className="muted small" role="status">Scheduler: {jobs.scheduler.running === true ? 'running' : jobs.scheduler.running === false ? 'offline' : 'unknown'}
          {jobs.scheduler.heartbeatAge != null && ` · heartbeat ${Math.round(jobs.scheduler.heartbeatAge)}s ago`}{jobs.scheduler.error && ` · ${jobs.scheduler.error}`}</p>}
        {error && <p role="alert">{error}</p>}
        <h3>Conversations & task sessions</h3>
        <NewBotTask key={selected.name} envId={envId} profile={selected.name} disabled={selected.sessions.some(s => envs[s.envId]?.connection === 'live' && s.thread.latestTurn?.state === 'running')} />
        {selected.sessions.length ? <div className="ops-sessions">{selected.sessions.map(session => <button className="btn" key={`${session.envId}:${session.thread.id}`} onClick={() => setSelection({ kind: 'unit', envId: session.envId, threadId: session.thread.id })}>
          <span>{session.thread.hermesBotChat ? 'Bot Chat' : session.thread.title}</span><span className="muted small">{envs[session.envId]?.connection === 'live' ? BOT_STATE_LABELS[session.state] : 'Last known'}{session.thread.hermesBotChat ? ' · ongoing conversation' : ' · task session'}</span>
        </button>)}</div> : <p className="muted small">No conversations opened in Command yet.</p>}
      </section>}
      <h3>Connected environments</h3>
      <p className="muted small">Select an endpoint for its connection status and engineering details.</p>
      <div className="ops-endpoints">{targets.map(target => <button className="btn" key={target.summary.id} onClick={() => {
        openHost(target.summary.id); worldRef.current?.focusEngineering(target.summary.id);
      }}><span>{target.summary.label}</span><span className="muted small">{target.connection === 'live' ? 'Online' : target.connection} · engineering</span></button>)}</div>
      {!targets.length && <p className="muted small">Connect a T3 Code environment from Machines.</p>}
    </div>
    {manage && <HermesPanel envId={envId} initialProfile={manage.profile} initialTab={manage.tab} onClose={() => { setManage(undefined); void refreshHermesBots(); }} />}
  </aside>;
}

function NewBotTask({ envId, profile, disabled }: { envId: string; profile: string; disabled: boolean }) {
  const env = useGame(s => s.envs[envId]);
  const [text, setText, clearText] = useDraft(`hermes-task:${envId}:${profile}`);
  const [mode, setMode] = useState<RuntimeMode>('approval-required');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  return <details className="ops-new-task"><summary>New task session</summary><form onSubmit={async e => {
    e.preventDefault(); const project = Object.values(env?.projects ?? {})[0];
    if (!project || !text.trim()) return;
    setSending(true); setError(undefined);
    try {
      const client = envClient(envId); if (!client) throw new Error('Hermes is not connected');
      const threadId = await client.recruit({ projectId: project.id, text: text.trim(), hermesProfile: profile,
        modelSelection: { instanceId: 'hermes', model: 'default' }, runtimeMode: mode });
      clearText();
      setSelection({ kind: 'unit', envId, threadId });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSending(false); }
  }}>
    <label className="hermes-field">Task<textarea required rows={3} value={text} disabled={sending} onChange={e => setText(e.target.value)} placeholder="Give this operator a separate task using its existing memory." /></label>
    <label className="hermes-field">Edit permissions<select value={mode} disabled={sending} onChange={e => setMode(e.target.value as RuntimeMode)}>
      {HERMES_EDIT_PERMISSIONS.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
    </select></label>
    <p className="muted small">A separate conversation with the same bot. Its ongoing Bot Chat keeps its own history.</p>
    {disabled && <p className="muted small">This operator has a running turn. Wait or halt it before starting another.</p>}
    {error && <p role="alert">{error}</p>}
    <button className="btn primary" disabled={sending || disabled || env?.connection !== 'live' || !text.trim()}>{sending ? 'Starting…' : 'Start task'}</button>
  </form></details>;
}
