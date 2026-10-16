import assert from "node:assert/strict";
import test from "node:test";
import { ProtocolUnsupported, t3SocketUrl, withProtocol } from "./t3-socket.ts";
import { versionChange } from "./t3-versions.ts";
import type { Registry, StoredEnv } from "./registry.ts";

const env = { id: "e", label: "tls-agent-02" } as StoredEnv;
const registry = (protocolVersion?: number) => ({
  status: async () => ({ serverVersion: "0.0.46", protocolVersion }),
  resolveUrl: async () => "https://tls-agent-02.example.ts.net",
}) as unknown as Registry;

test("Command connects to protocol v1 machines as before, with no protocol parameter", async () => {
  const url = await t3SocketUrl(registry(1), env, "t3-command-history");
  assert.equal(url.href, "wss://tls-agent-02.example.ts.net/ws?clientSurface=web&clientAppVersion=t3-command-history");
  assert.equal((await t3SocketUrl(registry(undefined), env, "x")).searchParams.has("orchestrationProtocol"), false, "absent means v1");
});

test("a machine on a newer protocol is refused with a clear reason instead of being sent v1 requests", async () => {
  await assert.rejects(t3SocketUrl(registry(3), env, "t3-command"), (err: Error) =>
    err instanceof ProtocolUnsupported && /T3 0\.0\.46 with orchestration protocol v3.*Update Command/.test(err.message));
});

test("newer protocols are requested the way T3's own client does", () => {
  assert.equal(withProtocol(new URL("wss://h/ws"), 2).searchParams.get("orchestrationProtocol"), "2");
  assert.equal(withProtocol(new URL("wss://h/ws"), 1).search, "");
});

test("T3 updates are announced once, loudly when the protocol moves past what Command speaks", () => {
  assert.equal(versionChange("Box", undefined, { serverVersion: "0.0.45", protocolVersion: 1 }), undefined, "first sighting is a baseline");
  assert.equal(versionChange("Box", { serverVersion: "0.0.45", protocolVersion: 1 }, { serverVersion: "0.0.45", protocolVersion: 1 }), undefined);
  assert.deepEqual(versionChange("Box", { serverVersion: "0.0.45", protocolVersion: 1 }, { serverVersion: "0.0.45.1", protocolVersion: 1 }),
    { tone: "info", text: "Box updated T3 0.0.45 → 0.0.45.1" });
  const breaking = versionChange("Box", { serverVersion: "0.0.45", protocolVersion: 1 }, { serverVersion: "0.0.46", protocolVersion: 3 })!;
  assert.equal(breaking.tone, "bad");
  assert.match(breaking.text, /protocol v3\. Command can't follow it until Command is updated/);
});

test("T3 Code 0.1.0 sockets explicitly negotiate protocol v2", async () => {
  const url = await t3SocketUrl(registry(2), env, "t3-command");
  assert.equal(url.searchParams.get("orchestrationProtocol"), "2");
  assert.equal(versionChange("Box", { serverVersion: "0.0.45", protocolVersion: 1 }, { serverVersion: "0.1.0", protocolVersion: 2 })?.tone, "info");
});
