import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const exec = promisify(execFile);

test('maintenance watcher ignores progress churn but reports completed work and pending requests once', async () => {
  const result = await exec('python3', [fileURLToPath(new URL('../tools/hermes-maintenance-watch-test.py', import.meta.url))]);
  assert.match(result.stderr, /OK/);
});

test('native maintenance migration separates cron from direct chat and retains queued evidence', { skip: !process.env.T3C_TEST_HERMES_COMMAND }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 't3c-maintenance-isolation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'config.yaml'), 'model:\n  default: test-model\n  provider: openrouter\n');
  const runtime = JSON.parse((await exec(process.env.T3C_TEST_HERMES_COMMAND!, ['--print-runtime-command'])).stdout) as string[];
  const index = runtime.indexOf('-c') + 1;
  const entry = "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)";
  assert.ok(runtime[index]?.includes(entry));
  runtime[index] = runtime[index].replace(entry, "runpy.run_path(sys.argv.pop(1), run_name='__main__')");
  const result = await exec(runtime[0], [...runtime.slice(1), fileURLToPath(new URL('../tools/hermes-maintenance-isolation-test.py', import.meta.url))], {
    env: { ...process.env, HERMES_HOME: dir }, timeout: 45_000, maxBuffer: 256 * 1024,
  });
  assert.match(result.stderr, /OK/);
});
