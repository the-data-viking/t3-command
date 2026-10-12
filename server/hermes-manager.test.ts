import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireBot, botBusy, HermesManager } from './hermes/manager.ts';

test('bot ownership is shared across stations and cannot be released by stale owners', () => {
  const release = acquireBot('test-specialist', 'station-a');
  assert.equal(botBusy('test-specialist'), true);
  assert.throws(() => acquireBot('test-specialist', 'station-b'), /already working/);
  const other = acquireBot('other-specialist', 'station-b');
  release();
  const current = acquireBot('test-specialist', 'station-b');
  release();
  assert.equal(botBusy('test-specialist'), true);
  current(); other();
  assert.equal(botBusy('test-specialist'), false);
});

test('management uses trusted runtime bootstrap and stdin without shell interpolation', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't3c-management-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'runtime.mjs');
  const launcher = path.join(dir, 'hermes');
  const sentinel = path.join(dir, 'shell-executed');
  await fs.writeFile(fixture, `
    let text = ''; for await (const chunk of process.stdin) text += chunk;
    const req = JSON.parse(text);
    if (req.action === 'profiles.delete') { console.log(JSON.stringify({error:'Cannot delete default'})); process.exitCode=1; }
    else console.log(JSON.stringify({result:{...req, argv:process.argv.slice(2)}}));
  `);
  const runtime = [process.execPath, fixture, '-c', "import runpy; runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)"];
  await fs.writeFile(launcher, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(runtime))});\n`, { mode: 0o700 });
  const manager = new HermesManager(launcher);
  const prompt = `literal $(touch ${sentinel}) and \`touch ${sentinel}\`\nnext line`;
  const response = await manager.request<{ body: { prompt: string }; profile: string; argv: string[] }>('jobs.create', 'ci-watcher', { prompt });
  assert.equal(response.body.prompt, prompt);
  assert.equal(response.profile, 'ci-watcher');
  assert.ok(response.argv.some(arg => arg.includes('runpy.run_path(sys.argv[1]')));
  await assert.rejects(fs.stat(sentinel), { code: 'ENOENT' });
  await assert.rejects(manager.request('profiles.get', '../escape'), /Invalid Hermes profile/);
  await assert.rejects(manager.request('profiles.delete'), /Cannot delete default/);
  await assert.rejects(manager.request('unsafe' as never), /Unsupported/);
});

// Opt-in: exercises the installed Hermes storage APIs in a temporary home, with no model calls.
test('native Hermes bot memory, canonical chats, and paused jobs remain profile scoped', { skip: !process.env.T3C_TEST_HERMES_COMMAND }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't3c-native-management-'));
  const previous = process.env.HERMES_HOME;
  process.env.HERMES_HOME = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dir, 'config.yaml'), 'model:\n  default: test-model\n  provider: openrouter\n');
  const manager = new HermesManager(process.env.T3C_TEST_HERMES_COMMAND!);
  await manager.request('profiles.create', 'validation-bot', { title: 'Validation Bot', cloneFrom: 'default' });
  await manager.request('profiles.update', 'validation-bot', { memory: 'ISOLATED BOT MEMORY', userMemory: 'ISOLATED USER MEMORY', soul: 'Test instructions' });
  const bot = await manager.request<{ memory: string; userMemory: string; soul: string }>('profiles.get', 'validation-bot');
  assert.equal(bot.memory, 'ISOLATED BOT MEMORY');
  assert.equal(bot.userMemory, 'ISOLATED USER MEMORY');
  assert.equal(bot.soul, 'Test instructions');
  const baseline = await manager.request<{ memory: string }>('profiles.get');
  assert.equal(baseline.memory, '');
  const metadataFile = path.join(dir, 'profiles', 'validation-bot', 'profile.yaml');
  await fs.appendFile(metadataFile, '\ncustom_metadata: KEEP_ME\n');
  const session = await manager.request<{ sessionId: string }>('session.open', 'validation-bot', {}, dir);
  const reopened = await manager.request<{ sessionId: string }>('session.open', 'validation-bot', {}, dir);
  assert.equal(reopened.sessionId, session.sessionId);
  assert.match(await fs.readFile(metadataFile, 'utf8'), /custom_metadata: KEEP_ME/);
  const job = await manager.request<{ id: string }>('jobs.create', 'validation-bot', { name: 'Paused validation', schedule: 'every 2h', prompt: 'Do not execute', paused: true });
  const defaultJobs = await manager.request<{ jobs: unknown[] }>('jobs.list');
  assert.equal(defaultJobs.jobs.length, 0);
  const botJobs = await manager.request<{ jobs: Array<{ id: string; enabled: boolean }> }>('jobs.list', 'validation-bot');
  assert.equal(botJobs.jobs[0].id, job.id);
  assert.equal(botJobs.jobs[0].enabled, false);
  await manager.request('jobs.update', 'validation-bot', { id: job.id, prompt: 'Updated task', schedule: 'every 3h', context_from: ['self'] });
  await assert.rejects(manager.request('jobs.trigger', 'validation-bot', { id: job.id }), /No scheduler/);
  assert.deepEqual(await manager.request('jobs.runs', 'validation-bot', { id: job.id }), []);
  await assert.rejects(manager.request('jobs.output', 'validation-bot', { id: '../escape' }), /Invalid job/);
  // Drive the real native scheduler once in this isolated home, using a script with no LLM.
  const scriptsDir = path.join(dir, 'profiles', 'validation-bot', 'scripts');
  await fs.mkdir(scriptsDir, { recursive: true });
  const script = path.join(scriptsDir, 'validation-script.sh');
  await fs.writeFile(script, '#!/bin/sh\nprintf "T3_COMMAND_ROUTINE_OK\\n"\n', { mode: 0o700 });
  const scripted = await manager.request<{ id: string }>('jobs.create', 'validation-bot', {
    name: 'Script validation', prompt: '', schedule: 'every 1h', script, no_agent: true, paused: true, deliver: 'local',
  });
  const botAdapter = fileURLToPath(new URL('./hermes/bot.py', import.meta.url));
  const tickScript = path.join(dir, 'tick.py');
  await fs.writeFile(tickScript, `
from hermes_cli.web_server_profiles import _config_profile_scope
with _config_profile_scope('validation-bot'):
    from cron.jobs import trigger_job
    from cron.scheduler_tick import tick
    trigger_job('${scripted.id}')
    tick(verbose=False, sync=True)
    # The adapter admits a native canonical CLI chat while preserving its provenance.
    from hermes_state import SessionDB
    from unittest.mock import MagicMock
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location('t3c_bot_adapter', ${JSON.stringify(botAdapter)})
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    db = SessionDB(Path(${JSON.stringify(dir)}) / 'profiles' / 'validation-bot' / 'state.db')
    existing = db.get_session_by_title('Bot Chat')
    db.set_session_title(existing['id'], '')
    db.create_session('legacy-chat', 'cli', model='test-model', cwd=${JSON.stringify(dir)})
    db.set_session_title('legacy-chat', 'Bot Chat')
    agent = MagicMock()
    agent.model = 'test-model'
    manager = module.BotSessionManager(agent_factory=lambda: agent, db=db)
    assert manager.get_session('legacy-chat') is not None
    assert db.get_session('legacy-chat')['source'] == 'cli'
    other = module.BotSessionManager(agent_factory=lambda: agent, db=db)
    try:
        other.get_session('legacy-chat')
    except ValueError as exc:
        assert 'open in another' in str(exc), str(exc)
    else:
        raise AssertionError('A second client stole the live Bot Chat')
    manager.end_all_sessions()
    db.close()
`);
  const exec = promisify(execFile);
  const command = JSON.parse((await exec(process.env.T3C_TEST_HERMES_COMMAND!, ['--print-runtime-command'])).stdout) as string[];
  const codeIndex = command.indexOf('-c') + 1;
  command[codeIndex] = command[codeIndex].replace("runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)", "runpy.run_path(sys.argv[1], run_name='__main__')");
  const tickResult = await exec(command[0], [...command.slice(1), tickScript], { timeout: 40_000, maxBuffer: 256 * 1024 });
  const runs = await manager.request<Array<{ status: string }>>('jobs.runs', 'validation-bot', { id: scripted.id });
  assert.ok(runs.some(run => run.status === 'completed' || run.status === 'succeeded' || run.status === 'success'), JSON.stringify({runs,stdout:tickResult.stdout,stderr:tickResult.stderr}));
  const outputs = await manager.request<Array<{ text: string }>>('jobs.output', 'validation-bot', { id: scripted.id });
  assert.ok(outputs.some(output => output.text.includes('T3_COMMAND_ROUTINE_OK')));
  await manager.request('jobs.delete', 'validation-bot', { id: scripted.id });
  await manager.request('jobs.delete', 'validation-bot', { id: job.id });
  await assert.rejects(manager.request('profiles.delete'), /default.*cannot be deleted/);
  const deleted = await manager.request<{ deleted: boolean; warning?: string }>('profiles.delete', 'validation-bot');
  assert.equal(deleted.deleted, true);
  const list = await manager.request<Array<{ name: string }>>('profiles.list');
  assert.ok(!list.some(bot => bot.name === 'validation-bot'));
});
