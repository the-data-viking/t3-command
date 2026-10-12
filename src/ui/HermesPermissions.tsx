import { useId, useState } from 'react';
import { HERMES_EDIT_PERMISSIONS } from '../../shared/hermes';
import { useGame } from '../store';
import { envClient } from '../t3/environment';
import { hermesRequest } from '../t3/hermes';
import type { RuntimeMode } from '../t3/types';

/** Saved per conversation in Command; changing it never starts a model turn. */
export function HermesPermissions({ envId, threadId, profile }: { envId: string; threadId?: string; profile?: string }) {
  const env = useGame(s => s.envs[envId]);
  const thread = threadId ? env?.threads[threadId] : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const helpId = useId();
  const starting = thread?.latestTurn?.state === 'running' && !thread.latestTurn.startedAt;
  const change = async (mode: RuntimeMode) => {
    setBusy(true); setError(undefined);
    try {
      const client = envClient(envId);
      if (!client) throw new Error('Hermes is not connected');
      const id = threadId ?? (await hermesRequest<{ threadId: string }>(envId, 'chat.open', profile)).threadId;
      await client.setRuntimeMode(id, mode);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <div className="hermes-permissions">
    <label className="hermes-field">{profile ? 'Bot Chat edit permissions' : 'Edit permissions'}
      <select value={thread?.runtimeMode ?? 'approval-required'} aria-describedby={helpId}
        disabled={busy || starting || env?.connection !== 'live'} onChange={e => void change(e.target.value as RuntimeMode)}>
        {HERMES_EDIT_PERMISSIONS.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
      </select>
    </label>
    <p id={helpId} className="muted small">Saved for {profile ? 'this bot’s Bot Chat' : 'this conversation'} in T3 Command. Command and sensitive-path approvals still follow Hermes.</p>
    {starting && <p className="muted small" role="status">Hermes is starting. Permissions will be available shortly.</p>}
    {thread?.hasPendingApprovals && <p className="muted small">Pending approval requests still need a response.</p>}
    {busy && <p className="muted small" role="status">Saving permissions…</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
