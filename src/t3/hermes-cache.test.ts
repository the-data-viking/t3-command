import assert from 'node:assert/strict';
import test from 'node:test';
import { ReadCache } from '../../shared/read-cache';
import { cachedHermes, hermesRequest, invalidateHermesReads } from './hermes';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('read cache coalesces, expires, retries failures, and fences pre-mutation results', async t => {
  const cache = new ReadCache();
  const old = deferred<string>();
  let calls = 0;
  const read = () => { calls++; return old.promise; };
  const first = cache.read('bot', read, 100);
  const shared = cache.read('bot', read, 100);
  assert.equal(calls, 1);
  cache.clear();
  const current = cache.read('bot', async () => 'new', 100);
  assert.equal(await current, 'new');
  old.resolve('old');
  assert.equal(await first, 'old');
  assert.equal(await shared, 'old');
  assert.equal(cache.peek('bot'), 'new', 'an old response cannot repopulate invalidated cache');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(101);
  assert.equal(await cache.read('bot', async () => 'expired', 100), 'expired');
  assert.equal(await cache.read('bot', async () => 'forced', 100, true), 'forced');
  await assert.rejects(cache.read('failure', async () => { throw new Error('retry'); }, 100), /retry/);
  assert.equal(await cache.read('failure', async () => 'recovered', 100), 'recovered');
});

test('closing one Hermes subscriber preserves shared reads; edits invalidate and refresh bypasses caches', async t => {
  const previous = globalThis.fetch;
  const pending = deferred<Response>();
  const requests: Array<{ action: string; fresh?: boolean }> = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    if (requests.length === 1) return pending.promise;
    return new Response(JSON.stringify({ value: requests.length }), { status: 200 });
  };
  invalidateHermesReads();
  t.after(() => { globalThis.fetch = previous; invalidateHermesReads(); });
  const controller = new AbortController();
  const first = hermesRequest('station', 'profiles.get', 'bot', undefined, controller.signal);
  const second = hermesRequest('station', 'profiles.get', 'bot');
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  pending.resolve(new Response(JSON.stringify({ value: 1 }), { status: 200 }));
  assert.deepEqual(await second, { value: 1 });
  assert.equal(requests.length, 1);
  assert.deepEqual(cachedHermes('station', 'profiles.get', 'bot'), { value: 1 });
  await hermesRequest('station', 'profiles.get', 'bot');
  assert.equal(requests.length, 1, 'reopening uses the shared cache');
  await hermesRequest('station', 'profiles.get', 'bot', undefined, undefined, true);
  assert.equal(requests.at(-1)?.fresh, true);
  await hermesRequest('station', 'profiles.update', 'bot', { title: 'changed' });
  assert.equal(cachedHermes('station', 'profiles.get', 'bot'), undefined);
  await hermesRequest('station', 'profiles.get', 'bot');
  assert.equal(requests.length, 4);
});
