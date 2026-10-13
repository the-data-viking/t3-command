import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { HistoryRecorder } from "./history-recorder.ts";
import { TurnHistory } from "./history.ts";
import type { Registry } from "./registry.ts";

const iso = (ms: number) => new Date(ms).toISOString();

test("the recorder subscribes with the environment's token, acks chunks, and records turns finishing over the wire", async (t) => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const seen: { auth?: string; acks: number; requests: Array<{ tag: string; payload: unknown }> } = { acks: 0, requests: [] };
  let socket: WebSocket | undefined;
  wss.on("connection", (ws, req) => {
    seen.auth = req.headers.authorization;
    socket = ws;
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg._tag === "Ack") seen.acks++;
      if (msg._tag === "Request") seen.requests.push({ tag: msg.tag, payload: msg.payload });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { wss.close(); server.close(); });
  const port = (server.address() as { port: number }).port;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3c-recorder-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const history = new TurnHistory(dir);
  await history.load();
  const env = { id: "remote", label: "Remote", url: `http://127.0.0.1:${port}`, token: "secret", addedAt: "" };
  const registry = { ids: () => ["remote"], get: () => env, resolveUrl: async () => env.url, tokenFor: async () => "secret", status: async () => ({ protocolVersion: 1 }) } as unknown as Registry;
  const recorder = new HistoryRecorder(registry, history, async () => { throw new Error("no Hermes here"); });
  recorder.start();
  t.after(() => recorder.stop());

  const until = async (check: () => boolean, ms = 2_000) => { for (let i = 0; i < ms / 10 && !check(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(check()); };
  await until(() => seen.requests.length === 1);
  assert.equal(seen.auth, "Bearer secret");
  assert.deepEqual(seen.requests[0], { tag: "orchestration.subscribeShell", payload: { requestCompletionMarker: true } });

  const now = Date.now();
  const thread = (state: string, completedAt: string | null) => ({ id: "th", projectId: "p", title: "Fix it", modelSelection: { instanceId: "codex", model: "sol" },
    session: null, latestTurn: { turnId: "turn-1", state, requestedAt: iso(now), startedAt: iso(now), completedAt, assistantMessageId: null } });
  const chunk = (values: unknown[]) => socket!.send(JSON.stringify({ _tag: "Chunk", requestId: "1", values }));
  chunk([{ kind: "snapshot", snapshot: { snapshotSequence: 1, projects: [{ id: "p", title: "Project" }], threads: [thread("running", null)] } }, { kind: "synchronized" }]);
  chunk([{ kind: "thread-upserted", sequence: 2, thread: thread("completed", iso(now + 42_000)) }]);
  await until(() => history.summary(1, "UTC").recent.length === 1);
  const [record] = history.summary(1, "UTC").recent;
  assert.deepEqual([record.envLabel, record.projectTitle, record.threadTitle, record.durationMs], ["Remote", "Project", "Fix it", 42_000]);
  assert.equal(seen.acks, 2, "every chunk is acknowledged");

  // If T3 ends the stream, the recorder reconnects (after its 5 s backoff) and subscribes again.
  socket!.send(JSON.stringify({ _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: null } }));
  await until(() => seen.requests.length === 2, 8_000);
});
