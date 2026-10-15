// Run the fixed migration helper through Hermes's trusted Python/bootstrap.
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Usage: node tools/configure-hermes-maintenance.mjs [--apply]');
const runtime = JSON.parse(execFileSync(process.env.T3C_HERMES_COMMAND || 'hermes', ['--print-runtime-command'], {
  encoding: 'utf8', timeout: 15_000, maxBuffer: 128 * 1024,
}));
if (!Array.isArray(runtime) || !runtime.every(arg => typeof arg === 'string')) throw new Error('Invalid Hermes runtime');
const entry = "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)";
const index = runtime.findIndex(arg => arg.includes(entry));
if (index < 0 || runtime[index - 1] !== '-c') throw new Error('Update Hermes: unsupported runtime bootstrap');
runtime[index] = runtime[index].replace(entry, "runpy.run_path(sys.argv.pop(1), run_name='__main__')");
const child = spawn(runtime[0], [...runtime.slice(1), fileURLToPath(new URL('./configure-hermes-maintenance.py', import.meta.url)), ...process.argv.slice(2)], { stdio: 'inherit', shell: false });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
