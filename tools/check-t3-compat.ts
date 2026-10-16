// Read-only check of Command's protocol adapter against a paired T3 server.
// No credentials or transcript content are printed. Usage: npx tsx tools/check-t3-compat.ts [env-id]
// --exercise-actions checks temporary project/thread mutations locally, without starting an agent.
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { Registry } from "../server/registry.ts";
import { t3SocketUrl } from "../server/t3-socket.ts";
import { protocolRequest, protocolStreamDecoder, protocolStreamPayload } from "../shared/t3-protocol.ts";
import type { ShellStreamItem, ThreadStreamItem } from "../src/t3/types.ts";

const registry = new Registry(process.env.T3C_DATA_DIR ?? path.join(os.homedir(), ".t3-command"));
await registry.load();
const envId = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const env = envId ? registry.get(envId) : registry.ids().map((id) => registry.get(id)!).find((e) => e.url?.includes("127.0.0.1"));
assert.ok(env && !env.hermes, "Select a paired T3 environment");
const status = await registry.status(env.id);
assert.equal(status?.status, "ok", status?.statusDetail);
const url = await t3SocketUrl(registry, env, "t3-command-compat-check");
const version = status.protocolVersion ?? 1;
const ws = new WebSocket(url, { headers: { authorization: `Bearer ${await registry.tokenFor(env)}` }, maxPayload: 64 * 1024 * 1024 });
let next = 1;
const calls = new Map<string, (msg: Record<string, unknown>) => void>();
ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg._tag === "Chunk") ws.send(JSON.stringify({ _tag: "Ack", requestId: msg.requestId }));
  calls.get(msg.requestId)?.(msg);
});
await once(ws, "open");
const request = (tag: string, payload: unknown) => new Promise<unknown>((resolve, reject) => {
  const id = String(next++);
  const timer = setTimeout(() => { calls.delete(id); reject(new Error(`${tag} timed out`)); }, 30_000);
  calls.set(id, (msg) => {
    if (msg._tag !== "Exit") return;
    clearTimeout(timer); calls.delete(id);
    const exit = msg.exit as { _tag: string; value: unknown; cause: unknown };
    if (exit._tag === "Success") resolve(exit.value); else reject(new Error(`${tag}: ${JSON.stringify(exit.cause)}`));
  });
  ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
});
const snapshot = <T>(tag: string, payload: unknown) => new Promise<T[]>((resolve, reject) => {
  const id = String(next++);
  const decode = protocolStreamDecoder(version, tag);
  const timer = setTimeout(() => { calls.delete(id); reject(new Error(`${tag} timed out`)); }, 30_000);
  calls.set(id, (msg) => {
    if (msg._tag === "Exit") { clearTimeout(timer); calls.delete(id); reject(new Error(`${tag}: ${JSON.stringify(msg.exit)}`)); return; }
    if (msg._tag !== "Chunk") return;
    const values = decode(msg.values as unknown[]) as T[];
    if (!values.some((v) => (v as { kind: string }).kind === "snapshot")) return;
    clearTimeout(timer); calls.delete(id);
    ws.send(JSON.stringify({ _tag: "Interrupt", requestId: id })); resolve(values);
  });
  ws.send(JSON.stringify({ _tag: "Request", id, tag, payload: protocolStreamPayload(version, tag, payload), headers: [] }));
});
try {
  const shell = (await snapshot<ShellStreamItem>("orchestration.subscribeShell", { requestCompletionMarker: true })).find((i) => i.kind === "snapshot");
  assert.ok(shell?.kind === "snapshot");
  const threads = shell.snapshot.threads;
  const chosen = threads.filter((t) => t.latestTurn && t.latestUserMessageAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);
  const counts = [];
  for (const thread of chosen) {
    const detail = (await snapshot<ThreadStreamItem>("orchestration.subscribeThread", { threadId: thread.id, requestCompletionMarker: true })).find((i) => i.kind === "snapshot");
    assert.ok(detail?.kind === "snapshot");
    assert.equal(detail.snapshot.thread.id, thread.id);
    counts.push({ messages: detail.snapshot.thread.messages.length, activities: detail.snapshot.thread.activities.length, checkpoints: detail.snapshot.thread.checkpoints.length });
  }
  const config = await protocolRequest(version, "server.getConfig", {}, request) as { providers: unknown[] };
  assert.ok(config.providers.length);
  if (process.argv.includes("--check-usage")) {
    const day = new Date().toISOString().slice(0, 10);
    const usage = await request("server.getUsageSummary", { sinceDay: day, untilDay: day, timeZone: "UTC" }) as { contractVersion: number };
    assert.ok(usage.contractVersion >= 4 && usage.contractVersion <= 6);
    console.log(`Usage check passed: contract v${usage.contractVersion}.`);
  }
  if (process.argv.includes("--exercise-actions")) {
    assert.equal(version, 2, "Action check targets T3 Code 0.1.0");
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(await registry.resolveUrl(env)).hostname), "Action check requires a local T3 server");
    assert.ok(chosen[0], "Need a model selection from an existing thread");
    const projectId = randomUUID();
    const threadId = randomUUID();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-command-compat-"));
    const dispatch = (command: Record<string, unknown>) => protocolRequest(version, "orchestration.dispatchCommand", { commandId: randomUUID(), ...command }, request);
    try {
      await dispatch({ type: "project.create", projectId, title: "Command compatibility check", workspaceRoot: root, defaultModelSelection: null });
      await request("vcs.init", { cwd: root, kind: "git" });
      const files = await request("projects.listEntries", { cwd: root, directoryPath: "" }) as { entries: unknown[] };
      assert.ok(Array.isArray(files.entries));
      await request("orchestration.launchThread", { commandId: randomUUID(), threadId, projectId, title: "Command compatibility check", modelSelection: chosen[0].modelSelection,
        runtimeMode: "approval-required", interactionMode: "default", workspaceStrategy: { type: "root" } });
      await dispatch({ type: "thread.interaction-mode.set", threadId, interactionMode: "plan" });
      await dispatch({ type: "thread.runtime-mode.set", threadId, runtimeMode: "approval-required" });
      await dispatch({ type: "thread.settle", threadId });
      await dispatch({ type: "thread.unsettle", threadId, reason: "user" });
      const p = await request("orchestration.getThreadProjection", { threadId }) as { thread: { interactionMode: string }; runs: unknown[] };
      assert.equal(p.thread.interactionMode, "plan");
      assert.equal(p.runs.length, 0, "The action check must never start an agent");
      console.log("Action check passed: project creation, Git init, file listing, empty-thread launch, modes, settle/unsettle; no agent started.");
    } finally {
      await dispatch({ type: "project.delete", projectId, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify({ serverVersion: status.serverVersion, protocolVersion: version, projects: shell.snapshot.projects.length, threads: threads.length, providers: config.providers.length, sampledThreads: counts }, null, 2));
} finally { ws.close(); }
