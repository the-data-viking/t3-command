// SSH bases: T3 servers that only listen on a remote machine's localhost. We reach them the way
// T3 desktop does: find the server over SSH, then hold an `ssh -L` tunnel open to it.
//
// T3 desktop's SSH launcher leaves this layout on the remote machine, which we rely on:
//   ~/.t3/ssh-launch/<key>/{port,pid,managed,run-t3.sh}   servers it started (or adopted)
//   ~/.t3/userdata/server-runtime.json                     a T3 started some other way
// We never start or stop remote servers ourselves; T3 desktop owns their lifecycle.

import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

export interface SshTarget {
  /** Anything `ssh` accepts as a destination: an alias from ~/.ssh/config, host, or user@host. */
  target: string;
  port?: number;
}

const SSH = process.env.T3C_SSH ?? "ssh";
const COMMAND_TIMEOUT_MS = 30_000;
const TUNNEL_READY_TIMEOUT_MS = 15_000;

export class SshError extends Error {}

export function validateTarget(raw: string): string {
  const target = raw.trim();
  // Same rule as T3: no whitespace, and no leading "-" (which ssh would read as an option).
  if (!/^[^\s-][^\s]*$/.test(target)) throw new SshError(`Not a valid SSH destination: ${raw}`);
  return target;
}

function baseArgs(t: SshTarget): string[] {
  return [
    // Never prompt: t3-command runs unattended, so it needs key/agent auth that already works.
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    ...(t.port ? ["-p", String(t.port)] : []),
  ];
}

function lastLines(text: string, n = 4): string {
  return text.trim().split(/\r?\n/).slice(-n).join(" | ");
}

/** Run a POSIX shell script on the remote host (piped to `sh -s`) and return its stdout. */
function runScript(t: SshTarget, script: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(SSH, [...baseArgs(t), t.target, "sh", "-s", "--", ...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new SshError(`SSH to ${t.target} timed out`));
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new SshError(`Couldn't run ${SSH}: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new SshError(`SSH to ${t.target} failed (exit ${code}): ${lastLines(stderr) || "no output"}`));
    });
    child.stdin.end(script);
  });
}

// Prints candidate servers as "port <n>" lines (best first) and the launcher's runner as "runner <path>".
const DISCOVER_SCRIPT = String.raw`
set -u
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
RT="$HOME/.t3/userdata/server-runtime.json"
if [ -f "$RT" ]; then
  pid=$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$RT")
  port=$(sed -n 's/.*"port": *\([0-9][0-9]*\).*/\1/p' "$RT")
  if alive "$pid" && [ -n "$port" ]; then echo "port $port"; fi
fi
for d in "$HOME"/.t3/ssh-launch/*/; do
  [ -f "$d/port" ] || continue
  port=$(cat "$d/port" 2>/dev/null || true)
  pid=$(cat "$d/pid" 2>/dev/null || true)
  managed=$(cat "$d/managed" 2>/dev/null || true)
  if [ -n "$port" ] && { [ "$managed" = "external" ] || alive "$pid"; }; then echo "port $port"; fi
  if [ -x "$d/run-t3.sh" ]; then echo "runner $d/run-t3.sh"; fi
done
exit 0
`;

export interface Discovery {
  ports: number[];
  runner?: string;
}

export async function discover(t: SshTarget): Promise<Discovery> {
  const out = await runScript(t, DISCOVER_SCRIPT);
  const ports: number[] = [];
  let runner: string | undefined;
  for (const line of out.split(/\r?\n/)) {
    const [kind, value] = [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1).trim()];
    if (kind === "port" && /^\d+$/.test(value) && !ports.includes(Number(value))) ports.push(Number(value));
    if (kind === "runner" && !runner) runner = value;
  }
  return { ports, runner };
}

/** Mint a one-time pairing credential on the remote host using T3's own runner. Never logged. */
export async function createPairingCredential(t: SshTarget, runner: string): Promise<string> {
  const script = String.raw`
set -eu
"$1" auth pairing create --base-dir "$HOME/.t3" --label t3-command --ttl 5m --json
`;
  const out = await runScript(t, script, [runner]);
  const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
  try {
    const credential = (JSON.parse(json) as { credential?: string }).credential;
    if (credential) return credential;
  } catch {
    // fall through
  }
  throw new SshError(`T3 on ${t.target} didn't return a pairing credential`);
}

function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url: string, child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + TUNNEL_READY_TIMEOUT_MS;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const res = await fetch(`${url}/.well-known/t3/environment`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

interface Tunnel {
  child: ChildProcess;
  url: string;
  remotePort: number;
}

/**
 * Keeps one tunnel per SSH base. `ensure` returns a local URL for the base's T3 server,
 * (re)discovering and (re)opening the tunnel when needed.
 */
export class SshTunnels {
  private tunnels = new Map<string, Tunnel>();
  private pending = new Map<string, Promise<string>>();
  private lastFailure = new Map<string, { at: number; error: Error }>();

  constructor() {
    const closeAll = () => this.closeAll();
    process.once("exit", closeAll);
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => process.exit(0));
  }

  ensure(id: string, t: SshTarget): Promise<string> {
    const live = this.tunnels.get(id);
    if (live && live.child.exitCode === null) return Promise.resolve(live.url);
    const inflight = this.pending.get(id);
    if (inflight) return inflight;
    // Don't hammer an unreachable host: reuse a recent failure for a few seconds.
    const failed = this.lastFailure.get(id);
    if (failed && Date.now() - failed.at < 5000) return Promise.reject(failed.error);
    const p = this.open(id, t).finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }

  private async open(id: string, t: SshTarget): Promise<string> {
    try {
      const { ports } = await discover(t);
      if (ports.length === 0) {
        throw new SshError(`No running T3 server found on ${t.target}. Connect to it once from T3 desktop (which starts it), then retry.`);
      }
      for (const remotePort of ports) {
        const localPort = await freeLocalPort();
        const child = spawn(
          SSH,
          [
            ...baseArgs(t),
            "-o", "ExitOnForwardFailure=yes",
            "-o", "ControlMaster=no",
            "-o", "ControlPath=none",
            "-n", "-N",
            "-L", `${localPort}:127.0.0.1:${remotePort}`,
            t.target,
          ],
          { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
        );
        let stderr = "";
        child.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
        child.on("error", () => {});
        const url = `http://127.0.0.1:${localPort}`;
        if (await waitForHttp(url, child)) {
          this.tunnels.set(id, { child, url, remotePort });
          this.lastFailure.delete(id);
          child.on("exit", () => {
            if (this.tunnels.get(id)?.child === child) this.tunnels.delete(id);
            if (stderr.trim()) console.warn(`[ssh ${t.target}] tunnel closed: ${lastLines(stderr, 2)}`);
          });
          return url;
        }
        child.kill();
        if (stderr.trim()) console.warn(`[ssh ${t.target}] tunnel to port ${remotePort} failed: ${lastLines(stderr, 2)}`);
      }
      throw new SshError(`Found T3 on ${t.target} (port ${ports.join(", ")}) but couldn't tunnel to it`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.lastFailure.set(id, { at: Date.now(), error });
      throw error;
    }
  }

  close(id: string): void {
    this.tunnels.get(id)?.child.kill();
    this.tunnels.delete(id);
  }

  closeAll(): void {
    for (const t of this.tunnels.values()) t.child.kill();
    this.tunnels.clear();
  }
}
