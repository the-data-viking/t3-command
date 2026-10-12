import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { EnvSummary } from '../../shared/api';
import { updateEnv, useGame } from '../store';
import { EnvironmentClient, refreshEnvironments } from '../t3/environment';
import type { RuntimeMode, ThreadShell } from '../t3/types';
import { HermesPermissions } from './HermesPermissions';

test('edit permissions follow server state, show rejection, and wait for connection/startup', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const restore: Array<() => void> = [];
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    restore.push(() => { if (before) Object.defineProperty(globalThis, key, before); else Reflect.deleteProperty(globalThis, key); });
  }
  const summary = { id: 'permission-test', kind: 'hermes', label: 'Hermes' } as EnvSummary;
  let summaries = [summary];
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.body) {
      requests.push(String(init.body));
      return new Response(JSON.stringify({ threadId: 'chat' }));
    }
    return new Response(JSON.stringify(summaries));
  });
  t.mock.method(EnvironmentClient.prototype, 'start', function (this: EnvironmentClient) {
    useGame.setState({ envs: { [this.id]: { summary, connection: 'live', synced: true, projects: {}, providers: [],
      threads: { chat: { id: 'chat', runtimeMode: 'approval-required', hasPendingApprovals: true } as ThreadShell } } } });
  });
  let reject = false;
  const changes: Array<{ threadId: string; mode: RuntimeMode }> = [];
  t.mock.method(EnvironmentClient.prototype, 'setRuntimeMode', async (threadId: string, mode: RuntimeMode) => {
    changes.push({ threadId, mode });
    if (reject) throw new Error('Hermes refused the change');
    updateEnv(summary.id, env => ({ ...env, threads: { ...env.threads, [threadId]: { ...env.threads[threadId], runtimeMode: mode } } }));
  });
  await refreshEnvironments();
  const container = dom.window.document.getElementById('root')!;
  const root = createRoot(container);
  t.after(async () => {
    await act(() => root.unmount()); summaries = []; await refreshEnvironments();
    dom.window.close(); restore.forEach(fn => fn());
  });
  await act(() => root.render(<HermesPermissions envId={summary.id} threadId="chat" />));
  const select = () => container.querySelector('select')!;
  assert.equal(select().value, 'approval-required');
  assert.match(container.textContent!, /Pending approval requests still need a response/);
  const change = (mode: string) => act(async () => {
    select().value = mode; select().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await change('auto-accept-edits');
  assert.equal(select().value, 'auto-accept-edits');
  reject = true;
  await change('approval-required');
  assert.equal(select().value, 'auto-accept-edits', 'failed changes do not misrepresent saved policy');
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /refused/);
  await act(() => updateEnv(summary.id, env => ({ ...env, connection: 'reconnecting' })));
  assert.equal(select().disabled, true);
  await act(() => updateEnv(summary.id, env => ({ ...env, connection: 'live', threads: { chat: { ...env.threads.chat,
    latestTurn: { turnId: 'turn', state: 'running', requestedAt: '', startedAt: null, completedAt: null, assistantMessageId: null } } } })));
  assert.equal(select().disabled, true);
  // A bot without an opened Command chat creates only its canonical chat, then saves the policy.
  reject = false;
  await act(() => root.render(<HermesPermissions key="new-bot" envId={summary.id} profile="new-bot" />));
  await change('auto-accept-edits');
  assert.deepEqual(JSON.parse(requests[0]), { action: 'chat.open', profile: 'new-bot' });
  assert.deepEqual(changes.at(-1), { threadId: 'chat', mode: 'auto-accept-edits' });
});
