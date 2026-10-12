import assert from "node:assert/strict";
import test from "node:test";
import type { EnvWorld } from "../store";
import type { ThreadShell } from "./types";
import { attentionCount, titleFor } from "../ui/attention";

const t = (id: string, extra: Partial<ThreadShell>) => ({ id, session: null, latestTurn: null, archivedAt: null, settledAt: null, ...extra }) as unknown as ThreadShell;

test("the tab title counts crew waiting on approvals and questions", () => {
  const envs = { a: { threads: {
    one: t("one", { hasPendingApprovals: true }),
    two: t("two", { hasPendingUserInput: true }),
    three: t("three", { session: { status: "running" } as ThreadShell["session"] }),
  } } } as unknown as Record<string, EnvWorld>;
  assert.equal(attentionCount(envs), 2);
  assert.equal(titleFor(2), "(2) T3 Command");
  assert.equal(titleFor(0), "T3 Command");
});
