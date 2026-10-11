import assert from "node:assert/strict";
import test from "node:test";
import { hostView, type HostResources } from "./host";

const snapshot: HostResources = { sampledAt: 100_000, cpuUtilization: 0, cpuCount: 8, availableMemoryBytes: 20, totalMemoryBytes: 100 };

test("zero CPU remains a valid reading and RAM shows availability rather than usage", () => {
  const view = hostView({ snapshot, history: [] }, "live", 100_000);
  assert.equal(view.cpuFraction, 0);
  assert.equal(view.freeFraction, 0.2);
  assert.equal(view.stale, false);
  assert.equal(view.memoryColor, 0xffd23f);
});

test("old, disconnected and failed samples retain values but become stale", () => {
  for (const [connection, now, error] of [["live", 136_000, undefined], ["reconnecting", 100_000, undefined], ["live", 100_000, "timeout"]] as const) {
    const view = hostView({ snapshot, history: [], error }, connection, now);
    assert.equal(view.stale, true);
    assert.equal(view.cpuFraction, 0);
    assert.equal(view.freeFraction, 0.2);
  }
  assert.equal(hostView(undefined, "live", 100_000).snapshot, undefined);
});

test("invalid host readings are unavailable and high CPU or low available RAM is flagged", () => {
  for (const cpuUtilization of [null, NaN, Infinity, -0.1, 1.1]) {
    assert.equal(hostView({ snapshot: { ...snapshot, cpuUtilization }, history: [] }, "live", 100_000).cpuFraction, undefined);
  }
  for (const [availableMemoryBytes, totalMemoryBytes] of [[-1, 100], [101, 100], [0, 0], [10, Infinity], [NaN, 100]]) {
    assert.equal(hostView({ snapshot: { ...snapshot, availableMemoryBytes, totalMemoryBytes }, history: [] }, "live", 100_000).freeFraction, undefined);
  }
  const high = hostView({ snapshot: { ...snapshot, cpuUtilization: 0.96, availableMemoryBytes: 9 }, history: [] }, "live", 100_000);
  assert.equal(high.cpuColor, 0xff4655);
  assert.equal(high.memoryColor, 0xff4655);
});
