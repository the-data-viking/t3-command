import assert from "node:assert/strict";
import test from "node:test";
import { pulseOf, pulseText } from "./pulse";

const T0 = Date.parse("2026-10-14T10:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const tool = (id: string, min: number, payload: Record<string, unknown>) => ({ id, kind: "tool.completed", tone: "tool", summary: String(payload.detail ?? ""), turnId: "t1", createdAt: at(min), payload: { toolCallId: id, ...payload } });
const thread = (activities: unknown[], state = "running") => ({ latestTurn: { turnId: "t1", state, startedAt: at(0), requestedAt: at(0) }, activities }) as never;

test("a turn's pulse: last file change, tests, a command failing again and again, and a long stretch with no changes", () => {
  const busy = thread([
    tool("e1", 5, { itemType: "file_change", status: "completed" }),
    tool("c1", 6, { detail: "npm test", status: "failed" }), tool("c2", 8, { detail: "npm test", status: "failed" }), tool("c3", 9, { detail: "npm test", exitCode: 1 }),
  ]);
  const p = pulseOf(busy, T0 + 12 * 60_000)!;
  assert.equal(p.lastChangeAt, T0 + 5 * 60_000);
  assert.deepEqual(p.repeatFail, { command: "npm test", count: 3 });
  assert.equal(p.noChangeMs, undefined);
  assert.match(pulseText(p, T0 + 12 * 60_000), /^⚠ npm test failed 3× this turn · files changed 7m.* ago · tests ✕$/);
  const still = pulseOf(thread([tool("e1", 5, { itemType: "file_change", status: "completed" })]), T0 + 80 * 60_000)!;
  assert.equal(still.noChangeMs, 75 * 60_000, "running 75 minutes past its last change");
  assert.equal(pulseOf(thread([], "completed"), T0 + 200 * 60_000)!.noChangeMs, undefined, "a finished turn isn't 'not changing'");
});
