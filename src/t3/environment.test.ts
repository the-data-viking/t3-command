import assert from "node:assert/strict";
import test from "node:test";
import { EnvironmentClient } from "./environment";
import type { EnvSummary } from "../../shared/api";

test("question responses dispatch against the original request without starting an unrelated turn", async () => {
  const client = new EnvironmentClient({ id: "env", label: "Station" } as EnvSummary);
  const calls: Array<{ tag: string; payload: Record<string, unknown> }> = [];
  Object.defineProperty(client, "rpc", { value: { isOpen: true,
    request: async (tag: string, payload: Record<string, unknown>) => { calls.push({ tag, payload }); return { sequence: 42 }; },
  } });
  await client.respondToQuestion("thread", "request", { route: "Core", kits: "Repair, Mining" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tag, "orchestration.dispatchCommand");
  assert.equal(calls[0].payload.type, "thread.user-input.respond");
  assert.equal(calls[0].payload.threadId, "thread");
  assert.equal(calls[0].payload.requestId, "request");
  assert.deepEqual(calls[0].payload.answers, { route: "Core", kits: "Repair, Mining" });
  assert.equal(typeof calls[0].payload.commandId, "string");
  assert.ok(Number.isFinite(Date.parse(String(calls[0].payload.createdAt))));
});

test("disconnected question submissions reject so the form can retain answers and retry", async () => {
  const client = new EnvironmentClient({ id: "env", label: "Station" } as EnvSummary);
  await assert.rejects(client.respondToQuestion("thread", "request", { route: "Core" }), /not connected/);
});
