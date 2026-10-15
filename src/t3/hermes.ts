import { HERMES_READ_ACTIONS, hermesReadTtl, type HermesAction, type HermesBot } from '../../shared/hermes';
import { fetchJson } from './environment';
import { useGame } from '../store';
import { ReadCache } from '../../shared/read-cache';

const reads = new ReadCache();
let generation = 0;
const keyOf = (envId: string, action: string, profile: string, body?: Record<string, unknown>) => JSON.stringify([envId, action, profile, body ?? {}]);

export function cachedHermes<T>(envId: string, action: HermesAction, profile = 'default'): T | undefined {
  return reads.peek<T>(keyOf(envId, action, profile));
}

export function invalidateHermesReads(): void {
  generation++; reads.clear(); refreshing = undefined;
}

/** Unmounting one subscriber must not abort another panel's shared read. */
function subscribe<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(value => { signal.removeEventListener('abort', abort); if (!signal.aborted) resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

export function hermesRequest<T>(envId: string, action: HermesAction | 'chat.open', profile = 'default', body?: Record<string, unknown>, signal?: AbortSignal, fresh = false): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  const load = () => fetchJson<T>(`/api/envs/${encodeURIComponent(envId)}/hermes`, {
    method: 'POST', body: JSON.stringify({ action, profile, body, ...(fresh ? { fresh: true } : {}) }),
  });
  if (HERMES_READ_ACTIONS.has(action)) return subscribe(reads.read(keyOf(envId, action, profile, body), load, hermesReadTtl(action), fresh), signal);
  invalidateHermesReads();
  return load().finally(invalidateHermesReads);
}

let refreshing: Promise<void> | undefined;
/** Profiles belong to the local installation, shared by all Hermes connections. */
export function refreshHermesBots(fresh = false): Promise<void> {
  if (refreshing) return refreshing;
  const envs = Object.values(useGame.getState().envs).filter(e => e.summary.kind === 'hermes');
  const env = envs.find(e => e.connection === 'live') ?? envs[0];
  if (!env) { setCatalog(undefined); return Promise.resolve(); }
  const envId = env.summary.id;
  const version = generation;
  const operation = hermesRequest<HermesBot[]>(envId, 'profiles.list', 'default', undefined, undefined, fresh).then(bots => {
    if (version !== generation) return;
    if (useGame.getState().envs[envId]) setCatalog({ envId, bots, loaded: true });
  }).catch(error => {
    if (version !== generation || !useGame.getState().envs[envId]) return;
    const previous = useGame.getState().hermesCatalog;
    setCatalog({ envId, bots: previous?.bots ?? [], loaded: previous?.loaded ?? false,
      error: error instanceof Error ? error.message : String(error) });
  }).finally(() => { if (refreshing === operation) refreshing = undefined; });
  refreshing = operation;
  return operation;
}

/** Periodic refreshes usually return the same profiles; keep the catalog identity so nothing redraws. */
function setCatalog(catalog: ReturnType<typeof useGame.getState>['hermesCatalog']): void {
  if (JSON.stringify(catalog) === JSON.stringify(useGame.getState().hermesCatalog)) return;
  useGame.setState({ hermesCatalog: catalog });
}
