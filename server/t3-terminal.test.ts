import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import type { Registry, StoredEnv } from "./registry.ts";
import { runInT3Terminal } from "./t3-terminal.ts";

type Request = { id: string; tag: string; payload: Record<string, unknown> };
const success = (ws: WebSocket, id: string) => ws.send(JSON.stringify({ _tag: "Exit", requestId: id, exit: { _tag: "Success" } }));
const chunk = (ws: WebSocket, id: string, values: unknown[]) => ws.send(JSON.stringify({ _tag: "Chunk", requestId: id, values }));

async function fixture(t: TestContext, handle: (ws: WebSocket, request: Request) => void) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  t.after(() => { for (const client of server.clients) client.terminate(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const registry = {
    status: async () => ({ protocolVersion: 2 }),
    resolveUrl: async () => `http://127.0.0.1:${address.port}`,
    tokenFor: async () => "fixture-token",
  } as unknown as Registry;
  server.on("connection", (ws, req) => {
    assert.equal(new URL(req.url!, "http://localhost").searchParams.get("orchestrationProtocol"), "2");
    ws.on("message", (raw) => { const request = JSON.parse(raw.toString()); if (request._tag === "Request") handle(ws, request); });
  });
  return (timeout = 100) => runInT3Terminal(registry, { id: "test" } as StoredEnv, "/tmp", "read-only probe", (out) => out.includes("DONE\n"), timeout);
}

test("a dropped terminal RPC rejects promptly instead of freezing fleet sampling", async (t) => {
  const run = await fixture(t, (ws, r) => { if (r.tag === "terminal.open") ws.close(); });
  await assert.rejects(Promise.race([run(), new Promise((_, reject) => setTimeout(() => reject(new Error("test guard: operation hung")), 500))]), /connection closed/i);
});

test("the deadline covers an RPC that never replies and bounds cleanup too", async (t) => {
  const run = await fixture(t, () => {});
  await assert.rejects(Promise.race([run(), new Promise((_, reject) => setTimeout(() => reject(new Error("test guard: operation hung")), 500))]), /timed out/i);
});

test("waits for attach, collects output, and finishes even if close never replies", async (t) => {
  let attached = false;
  let streamId = "";
  let closed = false;
  const run = await fixture(t, (ws, r) => {
    if (r.tag === "terminal.open") success(ws, r.id);
    if (r.tag === "terminal.attach") {
      streamId = r.id;
      setTimeout(() => { attached = true; chunk(ws, r.id, [{ type: "snapshot", snapshot: { history: "" } }]); }, 10);
    }
    if (r.tag === "terminal.write") {
      assert.equal(attached, true, "writing before attach is ready can lose output");
      chunk(ws, streamId, [{ type: "output", data: "DONE\n" }]);
      success(ws, r.id);
    }
    if (r.tag === "terminal.close") { closed = true; assert.equal(r.payload.deleteHistory, true); }
  });
  assert.equal(await run(), "DONE\n");
  assert.equal(closed, true);
});

test("stream failures are reported instead of waiting for the output deadline", async (t) => {
  const run = await fixture(t, (ws, r) => {
    if (r.tag === "terminal.open" || r.tag === "terminal.close") success(ws, r.id);
    if (r.tag === "terminal.attach") ws.send(JSON.stringify({ _tag: "Exit", requestId: r.id, exit: { _tag: "Failure", cause: [{ error: { message: "terminal permission denied" } }] } }));
  });
  await assert.rejects(run(), /terminal permission denied/);
});

for (const stalled of ["terminal.attach", "terminal.write", "output"]) {
  test(`the deadline also covers a stalled ${stalled}`, async (t) => {
    const run = await fixture(t, (ws, r) => {
      if (r.tag === stalled) return;
      if (r.tag === "terminal.attach") chunk(ws, r.id, [{ type: "snapshot", snapshot: { history: "" } }]);
      else success(ws, r.id);
    });
    await assert.rejects(run(), /timed out/i);
  });
}

test("a disconnect while waiting for output reports a connection failure", async (t) => {
  const run = await fixture(t, (ws, r) => {
    if (r.tag === "terminal.attach") chunk(ws, r.id, [{ type: "snapshot", snapshot: { history: "" } }]);
    else success(ws, r.id);
    if (r.tag === "terminal.write") ws.close();
  });
  await assert.rejects(run(), /connection closed/i);
});
