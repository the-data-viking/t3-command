import type { HermesAction, HermesBot } from '../../shared/hermes';
import { fetchJson } from './environment';
import { useGame } from '../store';
export function hermesRequest<T>(envId: string, action: HermesAction | 'chat.open', profile = 'default', body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  return fetchJson<T>(`/api/envs/${encodeURIComponent(envId)}/hermes`, {
    method: 'POST', body: JSON.stringify({ action, profile, body }), signal,
  });
}

let refreshing: Promise<void> | undefined;
/** Profiles belong to the local installation, shared by all Hermes connections. */
export function refreshHermesBots(): Promise<void> {
  if (refreshing) return refreshing;
  const envs = Object.values(useGame.getState().envs).filter(e => e.summary.kind === 'hermes');
  const env = envs.find(e => e.connection === 'live') ?? envs[0];
  if (!env) { useGame.setState({ hermesCatalog: undefined }); return Promise.resolve(); }
  const envId = env.summary.id;
  refreshing = hermesRequest<HermesBot[]>(envId, 'profiles.list').then(bots => {
    if (useGame.getState().envs[envId]) useGame.setState({ hermesCatalog: { envId, bots, loaded: true } });
  }).catch(error => {
    if (!useGame.getState().envs[envId]) return;
    const previous = useGame.getState().hermesCatalog;
    useGame.setState({ hermesCatalog: { envId, bots: previous?.bots ?? [], loaded: previous?.loaded ?? false,
      error: error instanceof Error ? error.message : String(error) } });
  }).finally(() => { refreshing = undefined; });
  return refreshing;
}
