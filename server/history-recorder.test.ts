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

for (const protocolVersion of [1, 2]) test(`the v${protocolVersion} recorder subscribes, reads replies, sends follow-ups, and records turns over the wire`, async (t) => {
  let boundedReads = 0;
  const server = http.createServer((req, res) => {
    assert.equal(protocolVersion, 2);
    assert.equal(req.url, "/api/orchestration/threads/th/bounded?compactTurnItems=1");
    assert.equal(req.headers.authorization, "Bearer secret");
    boundedReads++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ snapshotSequence: 4, projection: { thread: { id: "th" }, runs: [],
      messages: [{ id: "reply", role: "assistant", text: "Done", createdAt: iso(Date.now()), updatedAt: iso(Date.now()) }] } }));
  });
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
      if (msg._tag === "Request" && msg.tag === "orchestration.subscribeThread") {
        const thread = { id: "th", messages: [{ id: "reply", role: "assistant", text: "Done", runId: "turn-1", turnId: "turn-1", createdAt: iso(Date.now()), updatedAt: iso(Date.now()) }], activities: [], checkpoints: [] };
        const value = protocolVersion === 1 ? { kind: "snapshot", snapshot: { thread } }
          : { kind: "snapshot", snapshotSequence: 4, projection: { thread, messages: thread.messages, runs: [], turnItems: [] } };
        ws.send(JSON.stringify({ _tag: "Chunk", requestId: msg.id, values: [value] }));
      } else if (msg._tag === "Request" && msg.tag !== "orchestration.subscribeShell") {
        ws.send(JSON.stringify({ _tag: "Exit", requestId: msg.id, exit: { _tag: "Success", value: { sequence: 5 } } }));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3c-recorder-"));
  const history = new TurnHistory(dir);
  await history.load();
  const env = { id: "remote", label: "Remote", url: `http://127.0.0.1:${port}`, token: "secret", addedAt: "" };
  const registry = { ids: () => ["remote"], get: () => env, resolveUrl: async () => env.url, tokenFor: async () => "secret", status: async () => ({ protocolVersion }) } as unknown as Registry;
  const recorder = new HistoryRecorder(registry, history, async () => { throw new Error("no Hermes here"); });
  recorder.start();
  t.after(async () => {
    await recorder.stop();
    wss.close();
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const until = async (check: () => boolean, ms = 2_000) => { for (let i = 0; i < ms / 10 && !check(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(check()); };
  await until(() => seen.requests.length === 1);
  assert.equal(seen.auth, "Bearer secret");
  assert.deepEqual(seen.requests[0], { tag: "orchestration.subscribeShell", payload: { requestCompletionMarker: true } });

  const now = Date.now();
  const thread = (state: string, completedAt: string | null) => ({ id: "th", projectId: "p", title: "Fix it", modelSelection: { instanceId: "codex", model: "sol" },
    ...(protocolVersion === 2 ? { status: state, latestRunId: "turn-1", latestRunRequestedAt: iso(now), latestRunStartedAt: iso(now), latestRunCompletedAt: completedAt }
      : { session: null, latestTurn: { turnId: "turn-1", state, requestedAt: iso(now), startedAt: iso(now), completedAt, assistantMessageId: null } }) });
  const chunk = (values: unknown[]) => socket!.send(JSON.stringify({ _tag: "Chunk", requestId: "1", values }));
  chunk([{ kind: "snapshot", snapshot: { snapshotSequence: 1, projects: [{ id: "p", title: "Project", workspaceRoot: "/p" }, { id: "q", title: "Inactive project", workspaceRoot: "/q" }], threads: [thread("running", null)] } }, { kind: "synchronized" }]);
  if (protocolVersion === 2) {
    chunk([{ kind: "snapshot", snapshot: { snapshotSequence: 100, projects: [{ id: "p", title: "Old project title", workspaceRoot: "/p", repositoryIdentity: { canonicalKey: "github.com/test/p" } }], threads: [] }, resolvedRepositoryIdentityRoots: ["/p"] }]);
    await until(() => recorder.snapshot("remote")?.projects.p.repositoryIdentity?.canonicalKey === "github.com/test/p");
    const snapshot = recorder.snapshot("remote")!;
    assert.equal(snapshot.threads.length, 1, "repository enrichment cannot clear running turns");
    assert.equal(snapshot.projects.p.title, "Project");
    assert.equal(snapshot.projects.q.title, "Inactive project", "unrelated projects remain available to history and storage");
  }
  chunk([{ kind: protocolVersion === 2 ? "thread.updated" : "thread-upserted", location: "active", sequence: 2, thread: thread("completed", iso(now + 42_000)) }]);
  await until(() => history.summary(1, "UTC").recent.length === 1);
  const [record] = history.summary(1, "UTC").recent;
  assert.deepEqual([record.envLabel, record.projectTitle, record.threadTitle, record.durationMs], ["Remote", "Project", "Fix it", 42_000]);
  assert.equal(seen.acks, protocolVersion === 2 ? 3 : 2, "every chunk is acknowledged");

  const reply = await recorder.peek<{ kind: string; snapshot: { thread: { messages: Array<{ text: string }> } } }>("remote", "orchestration.subscribeThread", { threadId: "th", turnLimit: 1 });
  assert.equal(reply[0].snapshot.thread.messages[0].text, "Done");
  assert.equal(boundedReads, protocolVersion === 2 ? 1 : 0);
  if (protocolVersion === 2) assert.ok(!seen.requests.some((r) => r.tag === "orchestration.subscribeThread"), "one-off reads must not load full projections on the shared recorder socket");
  await recorder.request("remote", "orchestration.dispatchCommand", { commandId: "follow", type: "thread.turn.start", threadId: "th", message: { messageId: "m", text: "Continue", attachments: [] } });
  assert.equal((seen.requests.at(-1)?.payload as { type: string }).type, protocolVersion === 2 ? "message.dispatch" : "thread.turn.start");

  // If T3 ends the stream, the recorder reconnects (after its 5 s backoff) and subscribes again.
  const previous = seen.requests.length;
  socket!.send(JSON.stringify({ _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: null } }));
  await until(() => seen.requests.length === previous + 1, 8_000);
});
