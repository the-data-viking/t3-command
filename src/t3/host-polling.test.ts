import assert from "node:assert/strict";
import test from "node:test";
import { EnvironmentClient } from "./environment";
import { useGame, type EnvWorld } from "../store";
import type { EnvSummary } from "../../shared/api";
import type { HostResources } from "./host";

interface HostClient {
  rpc: { isOpen: boolean; request: () => Promise<HostResources>; close: () => void };
  loadHost: () => Promise<void>;
}
const snapshot: HostResources = { sampledAt: Date.now(), cpuUtilization: 0.5, cpuCount: 8, availableMemoryBytes: 10, totalMemoryBytes: 100 };
const browser = { hidden: false, removeEventListener: () => {} };

test("host polls never overlap or replace environment shells, and late disposed results are ignored", async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: browser });
  const client = new EnvironmentClient({ id: "host-test", label: "Host" } as EnvSummary);
  const internal = client as unknown as HostClient;
  const envs = { "host-test": { summary: { id: "host-test" }, threads: {} } as EnvWorld };
  useGame.setState({ envs, hosts: {} });
  let finish!: (s: HostResources) => void;
  let calls = 0;
  internal.rpc = { isOpen: true, request: () => { calls++; return new Promise((resolve) => { finish = resolve; }); }, close: () => {} };
  try {
    const pending = internal.loadHost();
    await internal.loadHost();
    assert.equal(calls, 1);
    finish(snapshot);
    await pending;
    assert.equal(useGame.getState().envs, envs);
    assert.equal(useGame.getState().hosts["host-test"].snapshot, snapshot);
    browser.hidden = true;
    await internal.loadHost();
    assert.equal(calls, 1);
    browser.hidden = false;
    const late = internal.loadHost();
    client.dispose();
    finish({ ...snapshot, cpuUtilization: 0.9 });
    await late;
    assert.equal(useGame.getState().hosts["host-test"], undefined);
  } finally {
    client.dispose();
    browser.hidden = false;
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("a failed host refresh retains its last sample as stale", async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: browser });
  const client = new EnvironmentClient({ id: "host-test", label: "Host" } as EnvSummary);
  const internal = client as unknown as HostClient;
  useGame.setState({ hosts: { "host-test": { snapshot, history: [snapshot] } } });
  internal.rpc = { isOpen: true, request: async () => { throw new Error("Timed out"); }, close: () => {} };
  try {
    await internal.loadHost();
    const host = useGame.getState().hosts["host-test"];
    assert.equal(host.snapshot, snapshot);
    assert.equal(host.error, "Timed out");
    assert.deepEqual(host.history, [snapshot]);
  } finally {
    client.dispose();
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
