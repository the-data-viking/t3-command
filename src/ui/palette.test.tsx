import assert from "node:assert/strict";
import test from "node:test";
import { fuzzyFilter, fuzzyScore } from "./fuzzy";
import { liveMembers } from "./squad";
import type { EnvWorld } from "../store";

test("fuzzy matching ranks word starts and contiguous runs first, and needs every letter in order", () => {
  const items = ["Restore Glassrun Gorge Canyon", "Turn history", "tls-agent-02", "Glassrun seam fix", "Theme: High Contrast"];
  assert.deepEqual(fuzzyFilter(items, "glass", (s) => s), ["Glassrun seam fix", "Restore Glassrun Gorge Canyon"]);
  assert.equal(fuzzyFilter(items, "tag02", (s) => s)[0], "tls-agent-02");
  assert.equal(fuzzyFilter(items, "hc", (s) => s)[0], "Theme: High Contrast");
  assert.equal(fuzzyScore("xyz", "Turn history"), undefined);
  assert.equal(fuzzyScore("glass", "Fix Playtest Log Upload Errors In camp · tls-agent-03"), undefined, "strewn letters don't count");
  assert.equal(fuzzyFilter(items, "", (s) => s).length, items.length, "an empty query lists everything in order");
});

test("a squad or control group keeps only crew that still exist and aren't archived", () => {
  const thread = (id: string, over = {}) => ({ id, latestTurn: { state: "completed" }, session: null, latestUserMessageAt: "x", archivedAt: null, ...over });
  const envs = { e: { threads: { a: thread("a"), b: thread("b", { archivedAt: "2026-10-12" }), h: thread("h", { latestTurn: null, latestUserMessageAt: null }) } } } as unknown as Record<string, EnvWorld>;
  const members = [{ envId: "e", threadId: "a" }, { envId: "e", threadId: "b" }, { envId: "e", threadId: "h" }, { envId: "e", threadId: "gone" }, { envId: "x", threadId: "a" }];
  assert.deepEqual(liveMembers(members, envs), [{ envId: "e", threadId: "a" }]);
});
