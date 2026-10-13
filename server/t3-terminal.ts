// Run one read-only command on a T3 machine through T3's own terminal API, in a short-lived
// session under a thread id no real thread uses, and always close it (deleting its history).

import { WebSocket } from "ws";
import type { Registry, StoredEnv } from "./registry.ts";
import { t3SocketUrl } from "./t3-socket.ts";

const THREAD_ID = "t3-command-storage";

/** Resolves with everything the terminal printed once `done(output)` is true, or the deadline passes. */
export async function runInT3Terminal(registry: Registry, env: StoredEnv, cwd: string, command: string,
  done: (output: string) => boolean, timeoutMs: number): Promise<string> {
  const url = await t3SocketUrl(registry, env, "t3-command-storage");
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${await registry.tokenFor(env)}` }, maxPayload: 16 * 1024 * 1024 });
  const exits = new Map<string, (exit: { _tag: string; cause?: Array<{ error?: { message?: string } }> }) => void>();
  const streams = new Map<string, (values: Array<{ type?: string; data?: string; snapshot?: { history?: string } }>) => void>();
  let next = 1;
  ws.on("message", (data) => {
    let msg: { _tag: string; requestId: string; values?: never[]; exit?: never };
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg._tag === "Chunk") { ws.send(JSON.stringify({ _tag: "Ack", requestId: msg.requestId })); streams.get(msg.requestId)?.(msg.values ?? []); }
    if (msg._tag === "Exit") exits.get(msg.requestId)?.(msg.exit!);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => { res.resume(); reject(new Error(`T3 rejected the connection (HTTP ${res.statusCode})`)); });
  });
  const call = (tag: string, payload: unknown, onValues?: (values: Array<{ type?: string; data?: string; snapshot?: { history?: string } }>) => void) =>
    new Promise<void>((resolve, reject) => {
      const id = String(next++);
      exits.set(id, (exit) => exit._tag === "Success" ? resolve() : reject(new Error(exit.cause?.[0]?.error?.message ?? `${tag} failed`)));
      if (onValues) { streams.set(id, onValues); resolve(); }
      ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  const ids = { threadId: THREAD_ID, terminalId: `storage-${Date.now().toString(36)}` };
  let output = "";
  try {
    await call("terminal.open", { ...ids, cwd, cols: 300, rows: 50 });
    await call("terminal.attach", ids, (values) => {
      for (const v of values) if (v.type === "output" && v.data) output += v.data;
    });
    await call("terminal.write", { ...ids, data: `${command}\r` });
    const deadline = Date.now() + timeoutMs;
    while (!done(output) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    if (!done(output)) throw new Error("Timed out reading disk usage");
    return output;
  } finally {
    await call("terminal.close", { ...ids, deleteHistory: true }).catch(() => {});
    ws.close();
  }
}
