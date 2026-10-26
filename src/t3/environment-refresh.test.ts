import assert from "node:assert/strict";
import test from "node:test";
import { refreshEnvironments } from "./environment";
import { useGame } from "../store";
import type { EnvSummary } from "../../shared/api";

class Socket extends EventTarget {
  static count = 0;
  static OPEN = 1;
  readyState = 0;
  constructor() { super(); Socket.count++; }
  close() { this.readyState = 3; }
}

test("failed health probes preserve a live client's metadata and selection through recovery", async () => {
  const before = useGame.getState();
  const globals = ["document", "location", "WebSocket", "fetch"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  let summaries: EnvSummary[] = [{ id: "probe-env", label: "T3", status: "ok", protocolVersion: 2, tokenExpiresAt: "2026-11-15", permissionNotice: "legacy grant" } as EnvSummary];
  const original = summaries[0];
  Object.defineProperty(globalThis, "document", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { protocol: "http:", host: "test" } });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: Socket });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => new Response(JSON.stringify(summaries)) });
  try {
    await refreshEnvironments();
    const created = Socket.count;
    useGame.setState({ selection: { kind: "unit", envId: "probe-env", threadId: "th" } });
    summaries = [{ id: "probe-env", label: "T3", status: "unreachable", statusDetail: "timeout" } as EnvSummary];
    await refreshEnvironments();
    assert.equal(Socket.count, created);
    assert.equal(useGame.getState().envs[original.id].summary.protocolVersion, 2);
    assert.equal(useGame.getState().envs[original.id].summary.tokenExpiresAt, original.tokenExpiresAt);
    summaries = [original]; await refreshEnvironments();
    assert.equal(Socket.count, created, "recovery is not a protocol upgrade from an inferred v1");
    assert.equal(useGame.getState().selection?.kind, "unit");
    summaries = [{ ...original, tokenExpiresAt: "2026-12-15" }]; await refreshEnvironments();
    assert.equal(Socket.count, created + 1, "a confirmed credential change still recreates the client");
  } finally {
    summaries = []; await refreshEnvironments();
    useGame.setState(before, true);
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
