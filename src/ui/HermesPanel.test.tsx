import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useGame } from '../store';
import { invalidateHermesReads } from '../t3/hermes';
import type { EnvSummary } from '../../shared/api';
import { HermesPanel } from './HermesPanel';

test('Hermes settings share roster reads, defer capabilities, retain tab edits, and render cached forms during revalidation', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const restore: Array<() => void> = [];
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    restore.push(() => { if (old) Object.defineProperty(globalThis, key, old); else Reflect.deleteProperty(globalThis, key); });
  }
  const before = useGame.getState();
  const summary = { id: 'menu-test', kind: 'hermes', label: 'Hermes' } as EnvSummary;
  useGame.setState({ hermesCatalog: undefined, envs: { [summary.id]: { summary, connection: 'live', synced: true, projects: {}, threads: {}, providers: [] } } });
  invalidateHermesReads();
  const bot = { name: 'default', title: 'Maintenance', description: '', model: 'model', provider: 'provider', skillCount: 1, isDefault: true,
    soul: 'Instructions', memory: 'Memory', userMemory: 'User', memoryProvider: 'local' };
  const capabilities = { skills: [{ name: 'research', enabled: true }], toolsets: [], availableToolsets: [], mcpServers: [] };
  const requests: Array<{ action: string; fresh?: boolean }> = [];
  let slow = false;
  const waiting = new Map<string, (response: Response) => void>();
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)); requests.push(req);
    if (slow && ['profiles.identity', 'profiles.capabilities'].includes(req.action)) return new Promise<Response>(resolve => waiting.set(req.action, resolve));
    return new Response(JSON.stringify(req.action === 'profiles.list' ? [bot] : req.action === 'profiles.identity' ? bot : capabilities));
  });
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(() => root.unmount()); invalidateHermesReads(); useGame.setState(before);
    dom.window.close(); restore.forEach(fn => fn());
  });
  const render = () => root.render(<HermesPanel envId={summary.id} onClose={() => {}} />);
  await act(render);
  assert.equal(requests.filter(r => r.action === 'profiles.list').length, 1);
  assert.equal(requests.filter(r => r.action === 'profiles.identity').length, 1);
  assert.equal(requests.filter(r => r.action === 'profiles.capabilities').length, 0);
  const tab = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(button => button.textContent === name)!;
  await act(() => tab('Capabilities').click());
  assert.equal(requests.filter(r => r.action === 'profiles.capabilities').length, 1);
  const checkbox = () => document.querySelector<HTMLInputElement>('.hermes-checklist input')!;
  await act(() => checkbox().click());
  assert.equal(checkbox().checked, false);
  await act(() => tab('Identity').click()); await act(() => tab('Capabilities').click());
  assert.equal(checkbox().checked, false, 'tab navigation preserves unsaved capability changes');
  await act(() => root.render(null));
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); t.mock.timers.tick(16_000);
  slow = true;
  await act(render);
  assert.match(document.querySelector('[role="dialog"]')!.textContent!, /Maintenance/);
  assert.doesNotMatch(document.querySelector('.hermes-content')!.textContent!, /Loading bot/);
  await act(() => tab('Capabilities').click());
  assert.ok(waiting.has('profiles.capabilities'));
  await act(() => checkbox().click());
  await act(() => {
    waiting.get('profiles.identity')!(new Response(JSON.stringify(bot)));
    waiting.get('profiles.capabilities')!(new Response(JSON.stringify(capabilities)));
  });
  assert.equal(checkbox().checked, false, 'late revalidation cannot overwrite an edited form');
  slow = false;
  await act(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent === 'Refresh')!.click());
  assert.ok(requests.some(r => r.action === 'profiles.list' && r.fresh));
  assert.ok(requests.some(r => r.action === 'profiles.identity' && r.fresh));
});
