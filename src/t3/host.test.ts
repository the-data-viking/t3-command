import assert from "node:assert/strict";
import test from "node:test";
import { hostView, type HostResources } from "./host";
import { GAUGE, STATUS } from "../game/theme";

const snapshot: HostResources = { sampledAt: 100_000, cpuUtilization: 0, cpuCount: 8, availableMemoryBytes: 20, totalMemoryBytes: 100 };

test("zero CPU remains a valid reading and RAM shows the used fraction", () => {
  const view = hostView({ snapshot, history: [] }, "live", 100_000);
  assert.equal(view.cpuFraction, 0);
  assert.equal(view.memoryFraction, 0.8);
  assert.equal(view.stale, false);
  assert.equal(view.memoryColor, view.cpuColor);
  assert.equal(hostView({ snapshot: { ...snapshot, availableMemoryBytes: 100 }, history: [] }, "live", 100_000).memoryFraction, 0);
  assert.equal(hostView({ snapshot: { ...snapshot, availableMemoryBytes: 0 }, history: [] }, "live", 100_000).memoryFraction, 1);
});

test("old, disconnected and failed samples retain values but become stale", () => {
  for (const [connection, now, error] of [["live", 136_000, undefined], ["reconnecting", 100_000, undefined], ["live", 100_000, "timeout"]] as const) {
    const view = hostView({ snapshot, history: [], error }, connection, now);
    assert.equal(view.stale, true);
    assert.equal(view.cpuFraction, 0);
    assert.equal(view.memoryFraction, 0.8);
  }
  assert.equal(hostView(undefined, "live", 100_000).snapshot, undefined);
});

test("invalid host readings are unavailable and CPU and RAM share utilization thresholds", () => {
  for (const cpuUtilization of [null, NaN, Infinity, -0.1, 1.1]) {
    assert.equal(hostView({ snapshot: { ...snapshot, cpuUtilization }, history: [] }, "live", 100_000).cpuFraction, undefined);
  }
  for (const [availableMemoryBytes, totalMemoryBytes] of [[-1, 100], [101, 100], [0, 0], [10, Infinity], [NaN, 100]]) {
    assert.equal(hostView({ snapshot: { ...snapshot, availableMemoryBytes, totalMemoryBytes }, history: [] }, "live", 100_000).memoryFraction, undefined);
  }
  for (const [cpuUtilization, availableMemoryBytes, color] of [[0.84, 16, GAUGE.ok], [0.85, 15, GAUGE.high], [0.95, 5, GAUGE.critical]]) {
    const view = hostView({ snapshot: { ...snapshot, cpuUtilization, availableMemoryBytes }, history: [] }, "live", 100_000);
    assert.equal(view.cpuColor, color);
    assert.equal(view.memoryColor, color);
    // A busy host must never look like an approval or a question.
    assert.ok(color !== STATUS.alert && color !== STATUS.question);
  }
});
