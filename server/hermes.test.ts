import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { probeHermes } from "./hermes/acp.ts";

const fixture = `
import fs from 'node:fs';
import { createInterface } from 'node:readline';
const log = process.argv[2];
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n');
const reply = (id, result) => send({ id, result });
const update = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });
const modes = { currentModeId: 'default', availableModes: [{id: 'default'}, {id: 'accept_edits'}] };
let pending;
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  fs.appendFileSync(log, JSON.stringify({ pid: process.pid, cwd: process.cwd(), ...msg }) + '\\n');
  if (msg.method === 'initialize') reply(msg.id, { protocolVersion: 1, agentInfo: { name: 'hermes-fixture', version: 'fixture' }, agentCapabilities: { loadSession: true } });
  else if (msg.method === 'session/new') reply(msg.id, { sessionId: 'session-' + process.pid, modes });
  else if (msg.method === 'session/load') {
    update(msg.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'HISTORY MUST NOT DUPLICATE' } });
    reply(msg.id, { modes });
  }
  else if (msg.method === 'session/set_mode') reply(msg.id, {});
  else if (msg.method === 'session/prompt') {
    const sessionId = msg.params.sessionId;
    if (msg.params.prompt[0].text === 'crash') { process.exit(7); return; }
    pending = { id: msg.id, sessionId, hang: msg.params.prompt[0].text === 'hang' };
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking' } });
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'cmd', title: 'echo hello', kind: 'execute', status: 'in_progress' });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'cmd', title: 'Running command' });
    update(sessionId, { sessionUpdate: 'usage_update', used: 20, size: 100 });
    send({ id: 'permission', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'cmd', title: 'echo hello' }, options: [
      {optionId:'allow_once', kind:'allow_once', name:'Allow once'},
      {optionId:'allow_session', kind:'allow_always', name:'Allow for session'},
      {optionId:'allow_always', kind:'allow_always', name:'Allow always'},
      {optionId:'deny', kind:'reject_once', name:'Deny'}
    ] } });
  }
  else if (msg.method === 'session/cancel' && pending) {
    const p = pending; pending = undefined;
    update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'cmd', status: 'failed' });
    reply(p.id, { stopReason: 'cancelled' });
  }
  else if (msg.id === 'permission' && pending && !pending.hang) {
    const p = pending; pending = undefined;
    update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'cmd', status: 'completed' });
    update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'a', content: { type: 'text', text: 'Hello ' } });
    update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'a', content: { type: 'text', text: 'world' } });
    update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'b', content: { type: 'text', text: 'Second reply' } });
    reply(p.id, { stopReason: 'end_turn' });
  }
});
`;

class RpcProbe {
  ws: WebSocket;
  messages: Record<string, unknown>[] = [];
  autoAck = true;
  private next = 0;
  constructor(url: string, origin?: string) {
    this.ws = new WebSocket(url, { headers: { "Tailscale-User-Login": "test@example.com", ...(origin ? { origin } : {}) } });
    this.ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      this.messages.push(message);
      if (message._tag === "Chunk" && this.autoAck) this.ws.send(JSON.stringify({ _tag: "Ack", requestId: message.requestId }));
    });
  }
  async request(tag: string, payload: unknown = {}): Promise<unknown> {
    const id = String(++this.next);
    this.ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    const exit = await this.wait((message) => message._tag === "Exit" && message.requestId === id) as { exit: { _tag: string; value: unknown; cause?: Array<{ error: { message: string } }> } };
    if (exit.exit._tag === "Failure") throw new Error(exit.exit.cause?.[0].error.message);
    return exit.exit.value;
  }
  stream(tag: string, payload = {}) {
    const id = String(++this.next);
    this.ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    return id;
  }
  async wait(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const match = this.messages.find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("RPC condition timed out");
  }
  async thread(id: string, predicate: (thread: Record<string, unknown>) => boolean) {
    const chunk = await this.wait((msg) => msg._tag === "Chunk" && msg.requestId === id && (msg.values as Array<{ snapshot?: { thread: Record<string, unknown> } }>).some((item) => item.snapshot?.thread && predicate(item.snapshot.thread)));
    return (chunk.values as Array<{ snapshot: { thread: Record<string, unknown> } }>)[0].snapshot.thread;
  }
}

test("local Hermes fleet supports approvals, reconnect, reload, cancellation, and failed agents", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3c-hermes-"));
  const workspaceRoot = await fs.realpath(dir);
  const script = path.join(dir, "agent.mjs");
  const log = path.join(dir, "acp.jsonl");
  await fs.writeFile(script, fixture);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const reservation = http.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  let child: ChildProcessWithoutNullStreams;
  const start = async () => {
    child = spawn(process.execPath, ["server/index.ts"], { env: { ...process.env, T3C_PORT: String(port), T3C_DATA_DIR: dir,
      T3C_DEV_NO_AUTH: "0", T3C_ALLOWED_USERS: "test@example.com", T3C_HERMES_COMMAND: process.execPath, T3C_HERMES_ARGS: JSON.stringify([script, log]) }, stdio: "pipe" });
    child.stderr.resume();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Command host startup timeout")), 8000);
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Command host exited")); });
      child.stdout.on("data", (data: Buffer) => { if (data.toString().includes("listening")) { clearTimeout(timer); resolve(); } });
    });
  };
  await start();
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; } });
  const base = `http://127.0.0.1:${port}`;
  const headers = { "Tailscale-User-Login": "test@example.com", "Content-Type": "application/json" };
  const add = (body: unknown, extra = {}) => fetch(`${base}/api/envs`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await add({ hermes: { workspaceRoot: dir } }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await add({ hermes: { workspaceRoot: "relative/path" } })).status, 400);
  const res = await add({ hermes: { workspaceRoot: dir }, label: "Local Hermes" });
  assert.equal(res.status, 200);
  const env = await res.json() as { id: string; kind: string; status: string };
  assert.equal(env.kind, "hermes");
  assert.equal(env.status, "ok");
  const duplicate = await (await add({ hermes: { workspaceRoot: dir } })).json() as { id: string };
  assert.equal(duplicate.id, env.id);
  assert.equal((await fetch(`${base}/env/${env.id}/assets/foo/test.png`, { headers })).status, 404);
  const connect = async () => {
    const probe = new RpcProbe(`ws://127.0.0.1:${port}/env/${env.id}/ws`);
    await once(probe.ws, "open");
    t.after(() => probe.ws.close());
    return probe;
  };
  let rpc = await connect();
  const config = await rpc.request("server.getConfig") as { providers: Array<{ runtimeModes: Array<{ id: string }> }> };
  assert.deepEqual(config.providers[0].runtimeModes.map((mode) => mode.id), ["approval-required", "auto-accept-edits"]);
  rpc.autoAck = false;
  const shell = rpc.stream("orchestration.subscribeShell");
  await rpc.wait((msg) => msg.requestId === shell && msg._tag === "Chunk");
  rpc.autoAck = true;
  const command = (text: string, commandId = text, threadId = "worker") => ({ commandId, type: "thread.turn.start", threadId,
    message: { messageId: commandId, text }, modelSelection: { instanceId: "hermes", model: "default" }, runtimeMode: "approval-required", interactionMode: "default",
    bootstrap: { createThread: { projectId: env.id, title: text } } });
  const initial = command("hello");
  await assert.rejects(rpc.request("orchestration.dispatchCommand", { ...initial, runtimeMode: "full-access" }), /Unsupported Hermes/);
  initial.commandId = "hello-valid";
  await rpc.request("orchestration.dispatchCommand", initial);
  // Same command ID never starts a duplicate turn.
  await rpc.request("orchestration.dispatchCommand", initial);
  let detail = rpc.stream("orchestration.subscribeThread", { threadId: "worker" });
  let thread = await rpc.thread(detail, (thread) => thread.hasPendingApprovals === true);
  const activities = thread.activities as Array<{ kind: string; payload: { requestId: string; options: Array<{ decision: string }>; itemType?: string } }>;
  const approval = activities.find((activity) => activity.kind === "approval.requested")!;
  assert.deepEqual(approval.payload.options.map((option) => option.decision), ["accept", "acceptForSession", "acceptAlways", "decline"]);
  assert.equal(activities.filter((a) => a.kind === "tool.started").at(-1)?.payload.itemType, "command_execution");
  assert.equal(rpc.messages.filter((msg) => msg.requestId === shell).length, 1, "shell snapshots wait for Ack");
  rpc.ws.send(JSON.stringify({ _tag: "Ack", requestId: shell }));
  const updatedShell = await rpc.wait((msg) => msg.requestId === shell && (msg.values as Array<{ snapshot?: { threads?: Array<{ id: string }> } }>).some((item) => item.snapshot?.threads?.some((thread) => thread.id === "worker")));
  const shellThread = (updatedShell.values as Array<{ snapshot: { threads: Array<{ messages?: unknown }> } }>)[0].snapshot.threads[0];
  assert.equal(shellThread.messages, undefined, "shell updates do not carry full transcripts");
  await assert.rejects(rpc.request("orchestration.dispatchCommand", { commandId: "bad-choice", type: "thread.approval.respond", threadId: "worker", requestId: approval.payload.requestId, decision: "unknown" }), /did not offer/);
  await assert.rejects(rpc.request("orchestration.dispatchCommand", command("overlap")), /still working/);
  const mutation = (action: string, origin?: string) => fetch(`${base}/api/envs/${env.id}/hermes`, {
    method: 'POST', headers: { ...headers, ...(origin ? { origin } : {}) }, body: JSON.stringify({ action, profile: 'default' }),
  });
  assert.equal((await mutation('profiles.update', 'https://evil.example')).status, 403);
  const locked = await mutation('profiles.update');
  assert.equal(locked.status, 400);
  assert.match((await locked.json() as { error: string }).error, /already working/);
  const duplicateTurn = { ...command('parallel order', 'parallel'), threadId: 'parallel' };
  await assert.rejects(rpc.request('orchestration.dispatchCommand', duplicateTurn), /already working/);
  // A browser disconnect leaves the same ACP process and permission request alive.
  rpc.ws.close();
  rpc = await connect();
  detail = rpc.stream("orchestration.subscribeThread", { threadId: "worker" });
  thread = await rpc.thread(detail, (thread) => thread.hasPendingApprovals === true);
  await rpc.request("orchestration.dispatchCommand", { commandId: "approve", type: "thread.approval.respond", threadId: "worker", requestId: approval.payload.requestId, decision: "acceptForSession" });
  thread = await rpc.thread(detail, (thread) => (thread.latestTurn as { state: string }).state === "completed");
  const messages = thread.messages as Array<{ role: string; text: string; streaming: boolean }>;
  assert.deepEqual(messages.filter((m) => m.role === "assistant").map((m) => m.text), ["Hello world", "Second reply"]);
  assert.ok(messages.every((message) => !message.streaming));
  assert.equal(thread.hasPendingApprovals, false);
  let rows = (await fs.readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.filter((row) => row.method === "session/prompt").length, 1);
  assert.equal(rows.find((row) => row.id === "permission" && row.result)?.result.outcome.optionId, "allow_session");
  // Follow-ups reload the same saved session in a fresh process, and denial preserves Hermes's option ID.
  rpc.messages = [];
  await rpc.request("orchestration.dispatchCommand", command("deny request", "deny-turn"));
  thread = await rpc.thread(detail, (thread) => thread.hasPendingApprovals === true);
  const deniedApproval = (thread.activities as typeof activities).filter((activity) => activity.kind === "approval.requested").at(-1)!;
  await rpc.request("orchestration.dispatchCommand", { commandId: "deny", type: "thread.approval.respond", threadId: "worker", requestId: deniedApproval.payload.requestId, decision: "decline" });
  await rpc.thread(detail, (thread) => (thread.latestTurn as { state: string }).state === "completed");
  rows = (await fs.readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.filter((row) => row.method === "session/new").length, 1);
  assert.equal(rows.filter((row) => row.id === "permission" && row.result).at(-1)?.result.outcome.optionId, "deny");
  // Restart the host: use ACP session/load, and suppress history replay duplicates.
  rpc.ws.close();
  const exited = once(child!, "exit"); child!.kill(); await exited;
  await start();
  rpc = await connect();
  await rpc.request("orchestration.dispatchCommand", command("hang", "hang"));
  detail = rpc.stream("orchestration.subscribeThread", { threadId: "worker" });
  thread = await rpc.thread(detail, (thread) => thread.hasPendingApprovals === true);
  await rpc.request("orchestration.dispatchCommand", { commandId: "halt", type: "thread.turn.interrupt", threadId: "worker" });
  thread = await rpc.thread(detail, (thread) => (thread.latestTurn as { state: string }).state === "interrupted");
  assert.equal(thread.hasPendingApprovals, false);
  assert.ok(!(thread.messages as Array<{ text: string }>).some((message) => message.text.includes("HISTORY MUST NOT DUPLICATE")));
  rows = (await fs.readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.filter((row) => row.method === "session/load").length, 2);
  assert.ok(rows.filter((row) => row.method === "session/new" || row.method === "session/load").every((row) => row.params.cwd === workspaceRoot && row.cwd === workspaceRoot));
  await rpc.request("orchestration.dispatchCommand", command("crash", "crash", "broken"));
  const broken = rpc.stream("orchestration.subscribeThread", { threadId: "broken" });
  await rpc.thread(broken, (thread) => (thread.latestTurn as { state: string }).state === "error");
  rpc.ws.close();
  const removed = await fetch(`${base}/api/envs/${env.id}`, { method: "DELETE", headers });
  assert.equal(removed.status, 200);
  assert.equal((await fs.readdir(dir)).includes(`${env.id}.json`), false);
});

test("missing local Hermes executable produces a controlled connection failure", async () => {
  await assert.rejects(probeHermes("/missing/hermes-executable", ["acp"], os.tmpdir()), /ENOENT/);
});
