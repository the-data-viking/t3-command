import assert from "node:assert/strict";
import test from "node:test";
import { RpcConnection } from "./rpc";

class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  static latest: FakeWebSocket;
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  constructor() { super(); FakeWebSocket.latest = this; }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  respond(id: string, value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ _tag: "Exit", requestId: id, exit: { _tag: "Success", value } }) }));
  }
}

test("timed out telemetry requests are interrupted and late responses cannot settle another call", async () => {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const rpc = new RpcConnection("ws://test", { onOpen: () => {}, onClose: () => {} });
  try {
    const ws = FakeWebSocket.latest;
    await assert.rejects(rpc.request("host", {}, 5), /timed out/);
    assert.deepEqual(ws.sent[1], { _tag: "Interrupt", requestId: "1" });
    const next = rpc.request("host", {}, 1000);
    ws.respond("1", "late");
    ws.respond("2", "new");
    assert.equal(await next, "new");
    const disconnected = rpc.request("host", {}, 1000);
    rpc.close();
    await assert.rejects(disconnected, /Connection closed/);
  } finally {
    rpc.close();
    globalThis.WebSocket = previous;
  }
});

test("a local relay open is not live until an upstream protocol Pong arrives", () => {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  let opened = 0;
  const rpc = new RpcConnection("ws://test", { onOpen: () => opened++, onClose: () => {} });
  try {
    const ws = FakeWebSocket.latest;
    ws.dispatchEvent(new Event("open"));
    assert.equal(opened, 0, "failed upstream opens cannot reset environment retry backoff");
    assert.deepEqual(ws.sent[0], { _tag: "Ping" });
    for (let n = 0; n < 2; n++) ws.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ _tag: "Pong" }) }));
    assert.equal(opened, 1);
  } finally { rpc.close(); globalThis.WebSocket = previous; }
});
