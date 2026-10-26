import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Registry, pairingNotice, pairingScopes } from "./registry.ts";

test("v2 pairing explicitly requests the granular permissions Command uses, with no access or relay management", () => {
  const scopes = pairingScopes(2).split(" ");
  assert.ok(scopes.includes("diagnostics:read"));
  assert.ok(scopes.includes("filesystem:read"));
  assert.ok(scopes.includes("source-control:write"));
  assert.ok(scopes.includes("providers:manage"));
  assert.ok(scopes.includes("environment:maintain"));
  assert.ok(scopes.includes("terminal:read") && scopes.includes("terminal:operate"));
  assert.ok(!scopes.some((s) => /^(access|relay):/.test(s)));
  assert.equal(pairingScopes(1), "orchestration:read orchestration:operate");
});

test("older credentials explain which features need re-pairing without blocking working threads", () => {
  assert.match(pairingNotice(["orchestration:read", "orchestration:operate"])!, /Pair this machine again to enable usage estimates.*pair:local/);
  assert.match(pairingNotice(["orchestration:read"], true)!, /Reconnect it in T3 desktop/);
  assert.equal(pairingNotice(pairingScopes(2).split(" ")), undefined);
  assert.equal(pairingNotice(undefined), undefined);
});

test("pairing exchanges the right scopes for each protocol and reports legacy grants from the authenticated session", async () => {
  for (const version of [1, 2]) {
    let requested = "";
    const server = http.createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/.well-known/t3/environment") res.end(JSON.stringify({ environmentId: "local", orchestrationProtocolVersion: version, serverVersion: version === 2 ? "0.1.0" : "0.0.45" }));
      else if (req.url === "/oauth/token") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        requested = new URLSearchParams(Buffer.concat(chunks).toString()).get("scope") ?? "";
        res.end(JSON.stringify({ access_token: "private-token", scope: requested }));
      } else res.end(JSON.stringify({ authenticated: true, permissions: ["orchestration:read", "orchestration:operate"] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3c-pair-test-"));
    try {
      const registry = new Registry(dir);
      await registry.load();
      const summary = await registry.add(`http://127.0.0.1:${(server.address() as { port: number }).port}`, "one-time-credential");
      assert.equal(requested, pairingScopes(version));
      assert.equal(summary.status, "ok");
      assert.equal(Boolean(summary.permissionNotice), version === 2);
      assert.ok(!JSON.stringify(summary).includes("private-token"));
    } finally { server.close(); await fs.rm(dir, { recursive: true, force: true }); }
  }
});

test("a failed descriptor probe retains known protocol metadata for reconnects", async (t) => {
  let fail = false;
  const server = http.createServer((req, res) => {
    if (req.url === "/.well-known/t3/environment" && fail) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/.well-known/t3/environment"
      ? { orchestrationProtocolVersion: 2, serverVersion: "0.1.0" } : { authenticated: true }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3c-probe-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "environments.json"), JSON.stringify([{ id: "env", label: "T3", url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "test" }]));
  const registry = new Registry(dir); await registry.load();
  const initial = await registry.status("env"); assert.equal(initial?.protocolVersion, 2);
  const cache = (registry as unknown as { statusCache: Map<string, { at: number }> }).statusCache;
  cache.get("env")!.at = 0; fail = true;
  const failed = await registry.status("env");
  assert.equal(failed?.status, "unreachable");
  assert.equal(failed.protocolVersion, 2);
  assert.equal(failed.serverVersion, "0.1.0");
});
