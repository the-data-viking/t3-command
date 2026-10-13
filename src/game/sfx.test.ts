import assert from "node:assert/strict";
import test from "node:test";
import { admit, newGate } from "./sfx";

test("a sound repeated within 350 ms is dropped", () => {
  const g = newGate();
  assert.equal(admit(g, "select", 0), true);
  assert.equal(admit(g, "select", 200), false);
  assert.equal(admit(g, "select", 400), true);
});

test("announcements take turns: a burst plays the most urgent once, not a pile of alarms", () => {
  const g = newGate();
  // A reconnect announces five finished turns and two approvals within a few milliseconds.
  const played = ["done", "done", "alert", "done", "question", "alert", "error"].map((s, i) => [s, admit(g, s as never, i * 5)] as const)
    .filter(([, ok]) => ok).map(([s]) => s);
  assert.deepEqual(played, ["done", "alert"], "the approval cuts in once; lesser sounds wait");
  assert.equal(admit(g, "question", 500), false, "still within the gap after the approval");
  assert.equal(admit(g, "question", 950), true);
});

test("everyday clicks never wait on announcements", () => {
  const g = newGate();
  assert.equal(admit(g, "alert", 0), true);
  assert.equal(admit(g, "select", 10), true);
  assert.equal(admit(g, "deny", 20), true);
});
