import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { upstreamAssetUrl } from './assets.ts';

test('asset relay rejects paths outside the signed asset route', () => {
  assert.equal(upstreamAssetUrl('http://localhost:3773', '/api/assets/token/map.png').pathname, '/api/assets/token/map.png');
  for (const p of ['https://other/api/assets/token/map.png', '//other/api/assets/token/map.png', '/api/assets/../../oauth/token', '/api/assets/..\\..\\oauth/token']) {
    assert.throws(() => upstreamAssetUrl('http://localhost:3773', p));
  }
});

test('HTTP image relay authenticates, selects the environment, and preserves image bytes', async (t) => {
  const requests: Array<{ url?: string; auth?: string; range?: string }> = [];
  const bytes = Buffer.from('test image bytes');
  const upstream = http.createServer((req, res) => {
    // Background monitoring (the recorder's shell subscription and its descriptor/session checks)
    // also reaches the environment; only count asset requests.
    if (req.url?.startsWith('/ws') || req.url?.startsWith('/.well-known/') || req.url?.startsWith('/api/auth/')) { res.writeHead(404); res.end(); return; }
    requests.push({ url: req.url, auth: req.headers.authorization, range: req.headers.range });
    if (req.url?.endsWith('redirect.png')) { res.writeHead(302, { location: 'https://example.com/' }); res.end(); return; }
    if (req.url?.endsWith('missing.png')) { res.writeHead(404); res.end(); return; }
    if (req.url?.endsWith('html.png')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<script>bad</script>'); return; }
    res.writeHead(req.headers.range ? 206 : 200, { 'content-type': 'image/png', 'content-range': `bytes 0-15/16` });
    res.end(bytes);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't3c-images-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'environments.json'), JSON.stringify([{ id: 'remote', label: 'Remote', url: `http://127.0.0.1:${upstreamPort}`, token: 'test-secret' }]));
  const child = spawn(process.execPath, ['server/index.ts'], { env: { ...process.env, T3C_PORT: String(port), T3C_DATA_DIR: dir, T3C_DEV_NO_AUTH: '0', T3C_ALLOWED_USERS: 'test@example.com' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start')), 10_000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited before startup')); });
    child.stdout.on('data', (data: Buffer) => { if (data.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
  });
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'Tailscale-User-Login': 'test@example.com' };
  assert.equal((await fetch(`${base}/env/remote/assets/token/map.png`)).status, 403);
  assert.equal((await fetch(`${base}/env/remote/threads/th/bounded`)).status, 403);
  assert.equal((await fetch(`${base}/env/remote/threads/th/subagents`)).status, 403);
  assert.equal((await fetch(`${base}/env/remote/threads/th/history?cursor=test`)).status, 403);
  assert.equal(requests.length, 0);
  assert.equal((await fetch(`${base}/env/unknown/assets/token/map.png`, { headers })).status, 404);
  const image = await fetch(`${base}/env/remote/assets/token/map.png`, { headers: { ...headers, range: 'bytes=0-15' } });
  assert.equal(image.status, 206);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.match(image.headers.get('cache-control')!, /private/);
  assert.match(image.headers.get('content-security-policy')!, /sandbox/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  assert.deepEqual(requests[0], { url: '/api/assets/token/map.png', auth: 'Bearer test-secret', range: 'bytes=0-15' });
  assert.equal((await fetch(`${base}/env/remote/assets/token/missing.png`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/env/remote/assets/token/html.png`, { headers })).status, 415);
  assert.equal((await fetch(`${base}/env/remote/assets/token/redirect.png`, { headers })).status, 502);
  const head = await fetch(`${base}/env/remote/assets/token/map.png`, { headers, method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
