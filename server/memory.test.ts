import assert from "node:assert/strict";
import test from "node:test";
import { memoryOf } from "../shared/memory.ts";
import type { TurnRecord } from "../shared/history.ts";

const rec = (envId: string, projectId: string, outcome: TurnRecord["outcome"], completedAt: string) =>
  ({ envId, projectId, outcome, completedAt } as TurnRecord);

test("station memory counts clean and failed turns per project copy, in the window", () => {
  const records = [
    rec("e1", "p", "completed", "2026-10-10T00:00:00Z"),
    rec("e1", "p", "completed", "2026-10-11T00:00:00Z"),
    rec("e1", "p", "error", "2026-10-11T00:00:00Z"),
    rec("e1", "p", "interrupted", "2026-10-11T00:00:00Z"),
    rec("e2", "p", "completed", "2026-10-12T00:00:00Z"),
    rec("e1", "p", "completed", "2026-01-01T00:00:00Z"),
  ];
  assert.deepEqual(memoryOf(records, Date.parse("2026-07-15T00:00:00Z")), {
    "e1:p": { completed: 2, failed: 1 },
    "e2:p": { completed: 1, failed: 0 },
  });
});
