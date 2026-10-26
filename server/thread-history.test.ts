import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import type { Registry } from "./registry.ts";
import { readThreadData } from "./thread-history.ts";
import type { BoundedThreadSnapshot } from "../shared/thread-history.ts";

test("thread reads use authenticated bounded HTTP and opaque history cursors, never unbounded fallback", async (t) => {
  const seen: string[] = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.url!);
    assert.equal(req.headers.authorization, "Bearer test-secret");
    assert.equal(req.headers["x-t3-orchestration-protocol"], "2");
    if (req.url?.includes("missing")) { res.writeHead(404); res.end(); return; }
    if (req.url?.includes("redirect")) { res.writeHead(302, { location: "/unbounded" }); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ snapshotSequence: 42, historyCursor: "opaque", hasMoreHistory: true, items: [], nextCursor: null,
      projection: { thread: { id: "parent" }, messages: [{ text: "private" }], turnItems: [{ output: "large" }],
        subagents: [{ id: "agent", origin: "provider_native", childThreadId: "child", status: "completed", prompt: "private", result: "large" }] } }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const base = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const registry = { get: (id: string) => id === "env" ? {} : undefined, resolveUrl: async () => base, tokenFor: async () => "test-secret" } as unknown as Registry;
  const snapshot = await readThreadData(registry, "env", "parent/with:punctuation", "bounded") as BoundedThreadSnapshot;
  assert.equal(snapshot.snapshotSequence, 42);
  const control = await readThreadData(registry, "env", "parent", "subagents");
  assert.ok(!JSON.stringify(control).includes("private"));
  assert.ok(!JSON.stringify(control).includes("large"));
  assert.match(JSON.stringify(control), /completed/);
  await readThreadData(registry, "env", "parent", "history", "opaque+/cursor?x=y");
  assert.equal(seen[0], "/api/orchestration/threads/parent%2Fwith%3Apunctuation/bounded?compactTurnItems=1");
  assert.equal(new URL(seen[2], base).searchParams.get("cursor"), "opaque+/cursor?x=y");
  await assert.rejects(readThreadData(registry, "env", "missing", "bounded"), /cannot provide bounded/);
  await assert.rejects(readThreadData(registry, "env", "redirect", "bounded"));
  await assert.rejects(readThreadData(registry, "unknown", "parent", "bounded"), /Unknown/);
  await assert.rejects(readThreadData(registry, "env", "parent", "history"), /cursor/);
  assert.ok(seen.every((s) => s.includes("/bounded?") || s.includes("/history?")), "no full projection or redirect target was requested");
});
