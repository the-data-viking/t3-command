import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { HermesBridge } from './hermes/bridge.ts';
import { botBusy } from './hermes/manager.ts';
import type { OrchestrationThread } from '../src/t3/types.ts';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('./hermes/background_test.py', import.meta.url));

async function nativeRuntime() {
  const runtime = JSON.parse((await exec(process.env.T3C_TEST_HERMES_COMMAND!, ['--print-runtime-command'])).stdout) as string[];
  const index = runtime.indexOf('-c') + 1;
  const entry = "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)";
  assert.ok(runtime[index]?.includes(entry), 'Hermes must provide the supported native runtime entrypoint');
  runtime[index] = runtime[index].replace(entry, "runpy.run_path(sys.argv[1], run_name='__main__')");
  return runtime;
}

async function until<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Hermes lifecycle condition timed out');
}

test('Hermes background lifecycle waits, delivers, scopes, deduplicates, cancels, and releases failed delivery', async () => {
  const result = await exec('python3', [script], { timeout: 15_000 });
  assert.match(result.stderr, /OK/);
});

test('installed Hermes worker and durable completion survive the parent reply', { skip: !process.env.T3C_TEST_HERMES_COMMAND }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't3c-native-background-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const runtime = await nativeRuntime();
  const result = await exec(runtime[0], [...runtime.slice(1), script, '--native'], {
    env: { ...process.env, HERMES_HOME: dir }, timeout: 30_000, maxBuffer: 256 * 1024,
  });
  assert.match(result.stderr, /OK/);
});

test('native delegated research survives closing its panel and browser, retaining ownership until the final reply', { skip: !process.env.T3C_TEST_HERMES_COMMAND }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't3c-background-bridge-'));
  const runtime = await nativeRuntime();
  const fixture = path.join(dir, 'agent.py');
  const adapter = fileURLToPath(new URL('./hermes/bot.py', import.meta.url));
  // Exercise the real adapter, ACP transport, delegation executor and ledger. Only
  // the model response is deterministic; no account/model calls are required.
  await fs.writeFile(fixture, `
import os
os.environ['HERMES_HOME'] = ${JSON.stringify(dir)}
import asyncio, importlib.util, threading, time
from pathlib import Path
from types import SimpleNamespace
import acp
from acp.schema import NewSessionResponse, PromptResponse, SessionMode, SessionModeState, SetSessionModeResponse
from tools.async_delegation import dispatch_async_delegation
spec = importlib.util.spec_from_file_location('command_bot', ${JSON.stringify(adapter)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
state = SimpleNamespace(cancel_event=threading.Event(), agent=SimpleNamespace(session_id='research'))
class Agent(module.CommandACPAgent):
    async def new_session(self, cwd, mcp_servers=None, **kwargs):
        return NewSessionResponse(session_id='research', modes=SessionModeState(current_mode_id='default', available_modes=[SessionMode(id='default',name='Ask'),SessionMode(id='accept_edits',name='Edit')]))
    async def set_session_mode(self, mode_id, session_id, **kwargs):
        return SetSessionModeResponse()
    async def _prompt_once(self, prompt, session_id, **kwargs):
        if prompt[0].text == 'research':
            def worker():
                time.sleep(1)
                Path(${JSON.stringify(path.join(dir, 'result'))}).write_text('RESEARCH_COMPLETE')
                return {'summary':'RESEARCH_COMPLETE','api_calls':0}
            await asyncio.to_thread(dispatch_async_delegation, goal='research',context=None,toolsets=None,role='general',model=None,session_key=session_id,parent_session_id=session_id,runner=worker)
            await self._conn.session_update(session_id, acp.update_agent_message_text('Research dispatched'))
        else:
            assert 'RESEARCH_COMPLETE' in prompt[0].text
            await self._conn.session_update(session_id, acp.update_agent_message_text('Research complete'))
        return PromptResponse(stop_reason='end_turn')
asyncio.run(acp.run_agent(Agent(session_manager=SimpleNamespace(get_session=lambda _: state)), use_unstable_protocol=True))
`);
  const bridge = new HermesBridge(dir, 'station', dir, { command: runtime[0], args: [...runtime.slice(1), fixture] });
  await bridge.load();
  t.after(() => bridge.close());
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let latest: OrchestrationThread | undefined;
  bridge.observe((_project, threads) => { latest = structuredClone(threads.find(thread => thread.id === 'worker')); });
  const server = http.createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', socket => bridge.attach(socket));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); server.close(); });
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  const connect = async () => {
    const socket = new WebSocket(url);
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message._tag === 'Chunk') socket.send(JSON.stringify({ _tag: 'Ack', requestId: message.requestId }));
    });
    await once(socket, 'open');
    return socket;
  };
  let socket = await connect();
  socket.send(JSON.stringify({ _tag: 'Request', id: 'start', tag: 'orchestration.dispatchCommand', payload: {
    commandId: 'start', type: 'thread.turn.start', threadId: 'worker', message: { text: 'research' },
    modelSelection: { instanceId: 'hermes', model: 'default' }, runtimeMode: 'auto-accept-edits', interactionMode: 'default',
    bootstrap: { createThread: { projectId: 'station', title: 'Research' } },
  } }));
  await until(() => latest?.messages.some(message => message.text === 'Research dispatched'));
  socket.send(JSON.stringify({ _tag: 'Request', id: 'panel', tag: 'orchestration.subscribeThread', payload: { threadId: 'worker' } }));
  await once(socket, 'message');
  socket.send(JSON.stringify({ _tag: 'Interrupt', requestId: 'panel' }));
  const closed = once(socket, 'close'); socket.close(); await closed;
  assert.equal(bridge.hasRunningTurns(), true);
  assert.equal(botBusy('default'), true, 'the profile remains locked while delegated work is running');
  await assert.rejects(fs.stat(path.join(dir, 'result')), { code: 'ENOENT' });
  await until(() => latest?.latestTurn?.state === 'completed');
  assert.equal(await fs.readFile(path.join(dir, 'result'), 'utf8'), 'RESEARCH_COMPLETE');
  assert.equal(botBusy('default'), false);
  socket = await connect();
  const snapshot = once(socket, 'message');
  socket.send(JSON.stringify({ _tag: 'Request', id: 'reopen', tag: 'orchestration.subscribeThread', payload: { threadId: 'worker' } }));
  const [data] = await snapshot;
  assert.match(String(data), /Research complete/);
  assert.match(String(data), /"state":"completed"/);
  socket.close();
});
