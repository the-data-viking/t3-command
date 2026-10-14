import assert from "node:assert/strict";
import test from "node:test";
import { loadDemoFleet } from "../demo";
import { useGame } from "../store";
import { pendingRequests } from "../t3/derive";
import { lastWords, requestContext } from "./request-context";

test("last words keep the final sentences that fit", () => {
  assert.equal(lastWords("Short."), "Short.");
  const long = "First sentence here. " + "x".repeat(300) + ". Second to last. The last one.";
  assert.equal(lastWords(long, 40), "Second to last. The last one.");
  assert.equal(lastWords("```ts\ncode\n```\nThen I ran it."), "Then I ran it.", "code blocks are dropped");
});

test("an approval's context comes from its own turn: order, last words, recent tools, where", () => {
  loadDemoFleet();
  const s = useGame.getState();
  const detail = s.details["mini:a2"]!.thread;
  const ctx = requestContext(s.envs.mini, s.envs.mini.threads.a2, detail, pendingRequests(detail)[0]);
  assert.match(ctx.order!, /^Restore the Glassrun/);
  assert.match(ctx.intent!, /run the pending migrations/);
  assert.deepEqual(ctx.recent, ["cp backups/glassrun-2026-10-06.db data/levels.db", "pnpm test -- levels/loader", "cat prisma/migrations/0042_canyon_props/migration.sql"]);
  assert.equal(ctx.where[0], "Mac mini (local)");
});
