import { useEffect, useState } from 'react';
import type { HermesBot } from '../../shared/hermes';
import { hermesRequest } from '../t3/hermes';
export function HermesBotPicker({ envId, value, onChange, disabled }: { envId: string; value: string; onChange: (name: string) => void; disabled?: boolean }) {
  const [bots, setBots] = useState<HermesBot[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    hermesRequest<HermesBot[]>(envId, 'profiles.list', 'default', undefined, controller.signal)
      .then(setBots).catch(error => { if (!controller.signal.aborted) setError(String(error.message)); });
    return () => controller.abort();
  }, [envId]);
  return <label className="hermes-field">Hermes bot
    <select value={value} disabled={disabled || !bots.length} onChange={e => onChange(e.target.value)}>
      {!bots.some(b => b.name === value) && <option value={value}>{value}</option>}
      {bots.map(b => <option key={b.name} value={b.name}>{b.title} · {b.model || 'configured model'}</option>)}
    </select>
    {error && <span role="alert" className="small">{error}</span>}
  </label>;
}
