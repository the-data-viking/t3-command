import type { HermesAction } from '../../shared/hermes';
import { fetchJson } from './environment';
export function hermesRequest<T>(envId: string, action: HermesAction | 'chat.open', profile = 'default', body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  return fetchJson<T>(`/api/envs/${encodeURIComponent(envId)}/hermes`, {
    method: 'POST', body: JSON.stringify({ action, profile, body }), signal,
  });
}
