import assert from "node:assert/strict";
import test from "node:test";
import { byWait, requestSummary, waitingSince } from "./queue";
import type { OrchestrationThread, PendingRequest, ThreadShell } from "../t3/types";

const request = (kind: "approval" | "user-input", payload: Record<string, unknown>): PendingRequest =>
  ({ requestId: "r", kind, activity: { kind: `${kind}.requested`, createdAt: "2026-10-13T10:00:00Z", payload } }) as unknown as PendingRequest;

test("the crew member waiting longest comes first, ties broken stably", () => {
  const rows = [{ key: "b", since: 300 }, { key: "a", since: 100 }, { key: "c", since: 100 }];
  assert.deepEqual(rows.sort(byWait).map((r) => r.key), ["a", "c", "b"]);
});

test("waiting starts at the oldest open request, or the last update before details load", () => {
  const thread = { updatedAt: "2026-10-13T12:00:00Z" } as ThreadShell;
  assert.equal(waitingSince(thread, undefined), Date.parse("2026-10-13T12:00:00Z"));
  const detail = { activities: [
    { kind: "approval.requested", createdAt: "2026-10-13T11:00:00Z", payload: { requestId: "x" } },
    { kind: "user-input.requested", createdAt: "2026-10-13T10:30:00Z", payload: { requestId: "y" } },
  ] } as unknown as OrchestrationThread;
  assert.equal(waitingSince(thread, detail), Date.parse("2026-10-13T10:30:00Z"));
});

test("a request reads as what it literally asks", () => {
  assert.equal(requestSummary(request("approval", { requestKind: "command", detail: "pnpm migrate\n--force" })), "▲ run pnpm migrate");
  assert.equal(requestSummary(request("approval", { requestKind: "file-change" })), "▲ edit files");
  assert.equal(requestSummary(request("user-input", { questions: [{ id: "q", question: "Which environment?" }] })), "◆ Which environment?");
  assert.equal(requestSummary(request("approval", { requestKind: "command", detail: "x".repeat(100) }), 20)?.length, 20);
  assert.equal(requestSummary(undefined), undefined);
});
