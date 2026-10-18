// Run one read-only command on a T3 machine through T3's own terminal API, in a short-lived
// session under a thread id no real thread uses, and always close it (deleting its history).

import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { Registry, StoredEnv } from "./registry.ts";
import { t3SocketUrl } from "./t3-socket.ts";

const THREAD_ID = "t3-command-storage";
const CLEANUP_MS = 1_000;
type Exit = { _tag: string; cause?: Array<{ error?: { message?: string } }> };
type TerminalEvent = { type?: string; data?: string; message?: string; snapshot?: { history?: string } };

/** The deadline covers connection, RPCs, attach and output; cleanup has its own short bound. */
export async function runInT3Terminal(registry: Registry, env: StoredEnv, cwd: string, command: string,
  done: (output: string) => boolean, timeoutMs: number): Promise<string> {
  const url = await t3SocketUrl(registry, env, "t3-command-storage");
  const token = await registry.tokenFor(env);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error("Timed out reading disk usage")), timeoutMs);
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, maxPayload: 16 * 1024 * 1024, handshakeTimeout: timeoutMs });
  const pending = new Map<string, { resolve(): void; reject(error: Error): void }>();
  let next = 1;
  let streamId: string | undefined;
  let output = "";
  let outputChanged: (() => void) | undefined;
  let cleaning = false;
  const fail = (error: Error) => {
    controller.abort(error);
    for (const request of pending.values()) request.reject(error);
  };
  ws.on("error", fail);
  ws.on("close", () => fail(new Error("T3 terminal connection closed")));
  ws.on("unexpected-response", (_req, res) => {
    res.resume();
    fail(new Error(`T3 rejected the connection (HTTP ${res.statusCode})`));
  });
  ws.on("message", (data) => {
    let msg: { _tag: string; requestId: string; values?: TerminalEvent[]; exit?: Exit };
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg._tag === "Chunk") {
      ws.send(JSON.stringify({ _tag: "Ack", requestId: msg.requestId }));
      if (msg.requestId !== streamId || cleaning) return;
      for (const value of msg.values ?? []) {
        if (value.type === "output" && value.data) output += value.data;
        if (value.type === "snapshot" && value.snapshot?.history) output += value.snapshot.history;
        if (value.type === "error") fail(new Error(value.message ?? "T3 terminal error"));
        if ((value.type === "exited" || value.type === "closed") && !done(output)) fail(new Error("T3 terminal exited before disk usage completed"));
      }
      // The first chunk confirms attach is listening before the command is written.
      pending.get(msg.requestId)?.resolve();
      outputChanged?.();
    }
    if (msg._tag === "Exit") {
      const error = new Error(msg.exit?.cause?.[0]?.error?.message ?? "T3 terminal request failed");
      if (msg.requestId === streamId && !cleaning) fail(error);
      else if (msg.exit?._tag === "Success") pending.get(msg.requestId)?.resolve();
      else pending.get(msg.requestId)?.reject(error);
    }
  });
  const call = (tag: string, payload: unknown, signal: AbortSignal = controller.signal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    if (ws.readyState !== WebSocket.OPEN) { reject(new Error("T3 terminal connection closed")); return; }
    const id = String(next++);
    if (tag === "terminal.attach") streamId = id;
    const finish = (error?: Error) => {
      pending.delete(id);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve();
    };
    const onAbort = () => finish(signal.reason);
    pending.set(id, { resolve: () => finish(), reject: finish });
    signal.addEventListener("abort", onAbort, { once: true });
    ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }), (error) => { if (error) finish(error); });
  });
  const ids = { threadId: THREAD_ID, terminalId: `storage-${randomUUID()}` };
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = () => { controller.signal.removeEventListener("abort", onAbort); ws.off("open", onOpen); };
      const onOpen = () => { finish(); resolve(); };
      const onAbort = () => { finish(); reject(controller.signal.reason); };
      if (controller.signal.aborted) { reject(controller.signal.reason); return; }
      ws.once("open", onOpen);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    await call("terminal.open", { ...ids, cwd, cols: 300, rows: 50 });
    await call("terminal.attach", ids);
    await call("terminal.write", { ...ids, data: `${command}\r` });
    await new Promise<void>((resolve, reject) => {
      const finish = () => { controller.signal.removeEventListener("abort", onAbort); outputChanged = undefined; };
      const onAbort = () => { finish(); reject(controller.signal.reason); };
      outputChanged = () => { if (done(output)) { finish(); resolve(); } };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort(); else outputChanged();
    });
    return output;
  } finally {
    clearTimeout(deadline);
    cleaning = true;
    // A lost close reply must never strand the monitor or keep its socket alive.
    await call("terminal.close", { ...ids, deleteHistory: true }, AbortSignal.timeout(Math.min(CLEANUP_MS, timeoutMs))).catch(() => {});
    ws.terminate();
  }
}
