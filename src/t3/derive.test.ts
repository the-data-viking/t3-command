import assert from "node:assert/strict";
import test from "node:test";
import { isHistory, unitState } from "./derive";
import type { ThreadShell } from "./types";

test("a canonical Bot Chat remains on duty and writable before its first Command turn", () => {
  const imported = {
    latestTurn: null, session: null, latestUserMessageAt: null,
    hasPendingApprovals: false, hasPendingUserInput: false,
    settledAt: null, snoozedUntil: null,
  } as ThreadShell;
  assert.equal(isHistory(imported), true, "ordinary imported transcripts stay in the archive");
  const botChat = { ...imported, hermesProfile: "default", hermesBotChat: true };
  assert.equal(isHistory(botChat), false, "the chat keeps its message box and crew presence");
  assert.equal(unitState(botChat), "idle");
});
