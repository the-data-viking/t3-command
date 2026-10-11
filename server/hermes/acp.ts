import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type JsonObject = Record<string, unknown>;
export interface AcpMessage extends JsonObject {
  id?: string | number;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: { message: string };
}

/** ACP uses newline-delimited JSON-RPC over stdio. Never invoke a shell. */
export class AcpProcess {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (err: Error) => void; timer?: NodeJS.Timeout }>();
  private ended = false;

  constructor(command: string, args: string[], cwd: string, onMessage: (message: AcpMessage) => void,
    onExit: (error: Error) => void = () => {}) {
    this.child = spawn(command, args, { cwd, stdio: "pipe", shell: false });
    // Drain diagnostics without exposing provider credentials or filling the pipe.
    this.child.stderr.resume();
    this.child.stdin.on("error", (err) => this.fail(err, onExit));
    this.child.on("error", (err) => this.fail(err, onExit));
    this.child.on("exit", (code, signal) => this.fail(new Error(`Hermes exited (${signal ?? code}). Check Hermes setup and ACP dependencies.`), onExit));
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      let message: AcpMessage;
      try { message = JSON.parse(line) as AcpMessage; }
      catch { this.fail(new Error("Hermes emitted invalid ACP JSON"), onExit); this.close(); return; }
      if (!message || typeof message !== "object") return;
      if (message.method) {
        try { onMessage(message); }
        catch { this.fail(new Error("Invalid Hermes ACP message"), onExit); this.close(); }
        return;
      }
      if (typeof message.id !== "number") return;
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve((message.result ?? {}) as JsonObject);
    });
  }

  private fail(error: Error, onExit: (error: Error) => void): void {
    if (this.ended) return;
    this.ended = true;
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
    this.pending.clear();
    onExit(error);
  }

  send(message: JsonObject): void {
    if (this.ended) throw new Error("Hermes ACP process is disconnected");
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  request(method: string, params: JsonObject, timeoutMs = 30_000): Promise<JsonObject> {
    if (this.ended) return Promise.reject(new Error("Hermes ACP process is disconnected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hermes ${method} timed out`));
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  initialize(): Promise<JsonObject> {
    return this.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "t3-command", version: "0.0.0" } });
  }

  close(): void {
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL"); }, 2000);
    timer.unref();
  }
}

export async function probeHermes(command: string, args: string[], cwd: string): Promise<string | undefined> {
  const process = new AcpProcess(command, args, cwd, (message) => {
    if (message.id !== undefined) process.send({ id: message.id, error: { code: -32601, message: "Client method not supported" } });
  });
  try {
    const result = await process.initialize();
    if (result.protocolVersion !== 1) throw new Error(`Unsupported Hermes ACP protocol v${result.protocolVersion}`);
    return (result.agentInfo as { version?: string } | undefined)?.version;
  } finally { process.close(); }
}
