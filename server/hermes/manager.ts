import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HERMES_READ_ACTIONS, hermesReadTtl, type HermesAction } from '../../shared/hermes.ts';
import { ReadCache } from '../../shared/read-cache.ts';

const helper = fileURLToPath(new URL('./manage.py', import.meta.url));
const actions: HermesAction[] = ['profiles.list', 'profiles.path', 'profiles.get', 'profiles.identity', 'profiles.capabilities', 'profiles.create', 'profiles.update', 'profiles.delete',
  'jobs.list', 'jobs.create', 'jobs.update', 'jobs.pause', 'jobs.resume', 'jobs.trigger', 'jobs.delete', 'jobs.runs', 'jobs.output', 'session.open', 'session.read'];
// Across stations: profiles belong to the installation, not a workspace.
const owners = new Map<string, string>();
export function acquireBot(profile: string, owner: string): () => void {
  if (owners.has(profile)) throw new Error(`Hermes bot ${profile} is already working in T3 Command. Wait for its turn or halt it first.`);
  owners.set(profile, owner);
  return () => { if (owners.get(profile) === owner) owners.delete(profile); };
}
export function botBusy(profile: string): boolean { return owners.has(profile); }

export class HermesManager {
  private runtime?: Promise<string[]>;
  private cache = new ReadCache();
  private queue: Array<{ read: boolean; start: () => void }> = [];
  private reading = 0;
  private writing = false;
  private pendingWrites = 0;
  constructor(privateCommand: string) { this.command = privateCommand; }
  private command: string;

  private runtimeCommand(): Promise<string[]> {
    if (!this.runtime) this.runtime = new Promise<string[]>((resolve, reject) => {
      execFile(this.command, ['--print-runtime-command'], { timeout: 15_000, maxBuffer: 128 * 1024 }, (err, stdout) => {
        if (err) { reject(new Error('Hermes management requires a launcher supporting --print-runtime-command. Update Hermes.')); return; }
        try {
          const args: unknown = JSON.parse(stdout);
          if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) throw new Error('Invalid Hermes runtime response');
          // Preserve the installation's own Python/bootstrap/secret scopes. Replace only CLI entrypoint.
          const entry = "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)";
          const index = args.findIndex(a => a.includes(entry));
          if (index < 0 || args[index - 1] !== '-c') throw new Error('Unsupported Hermes runtime launcher');
          args[index] = args[index].replace(entry, "runpy.run_path(sys.argv[1], run_name='__main__')");
          resolve([...args, helper]);
        } catch (error) { reject(error); }
      });
    }).catch(error => { this.runtime = undefined; throw error; });
    return this.runtime;
  }

  async acpLaunch(profile: string, botChat: boolean): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> {
    const runtime = await this.runtimeCommand();
    const { home } = await this.request<{ home: string }>('profiles.path', profile);
    return { command: runtime[0], args: [...runtime.slice(1, -1), fileURLToPath(new URL('./bot.py', import.meta.url)), ...(!botChat ? ['--task-session'] : [])],
      env: { ...process.env, HERMES_HOME: home } };
  }

  async request<T>(action: HermesAction, profile = 'default', body: Record<string, unknown> = {}, workspace = '', fresh = false): Promise<T> {
    if (!actions.includes(action)) throw new Error('Unsupported Hermes management action');
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)) throw new Error('Invalid Hermes profile name');
    const read = HERMES_READ_ACTIONS.has(action);
    const run = () => this.schedule(read, () => this.invoke<T>({ action, profile, body, workspace }));
    if (read) {
      // A read behind a mutation must never reuse a value or promise from before it.
      if (this.pendingWrites) return run();
      return this.cache.read(JSON.stringify([action, profile, body ?? {}, workspace]), run, hermesReadTtl(action), fresh);
    }
    this.pendingWrites++;
    this.cache.clear();
    try { return await run(); }
    finally { this.pendingWrites--; this.cache.clear(); }
  }

  private schedule<T>(read: boolean, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ read, start: () => {
        if (read) this.reading++; else this.writing = true;
        void Promise.resolve().then(run).then(resolve, reject).finally(() => {
          if (read) this.reading--; else this.writing = false;
          this.pump();
        });
      } });
      this.pump();
    });
  }

  private pump(): void {
    // Separate processes preserve native profile/credential isolation. At most three
    // readers run together; mutations fence both earlier and later reads, in FIFO order.
    while (!this.writing && this.queue.length) {
      const next = this.queue[0];
      if (next.read ? this.reading >= 3 : this.reading > 0) return;
      this.queue.shift()!.start();
    }
  }

  private async invoke<T>(request: Record<string, unknown>): Promise<T> {
    const [command, ...args] = await this.runtimeCommand();
    return new Promise<T>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Hermes management timed out')); }, 30_000);
      child.stderr.resume(); // Never relay logs/credential material to the browser.
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { child.kill('SIGKILL'); reject(new Error('Hermes management response too large')); }
        else chunks.push(chunk);
      });
      child.on('error', () => { clearTimeout(timer); reject(new Error('Could not start the Hermes management runtime')); });
      child.on('close', () => {
        clearTimeout(timer);
        try {
          const response = JSON.parse(Buffer.concat(chunks).toString()) as { error?: string; result: T };
          if (response.error) reject(new Error(response.error));
          else resolve(response.result);
        } catch { reject(new Error('Hermes management returned an invalid response')); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(request));
    });
  }
}
