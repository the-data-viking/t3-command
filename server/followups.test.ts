import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CommsLog } from "./comms.ts";
import { FollowUps } from "./followups.ts";
import type { ThreadShell } from "../src/t3/types.ts";

const shell = (turnId: string, state: string, over: Partial<ThreadShell> = {}) => ({
  id: "t", title: "Fix CI", hasPendingApprovals: false, hasPendingUserInput: false, archivedAt: null,
  modelSelection: { instanceId: "codex", model: "gpt" }, runtimeMode: "full-access", interactionMode: "default",
  latestTurn: { turnId, state, requestedAt: "", startedAt: "", completedAt: null, assistantMessageId: null }, ...over,
}) as unknown as ThreadShell;

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fu-"));
  const comms = new CommsLog(dir);
  const sent: string[] = [];
  const followUps = new FollowUps(dir, comms, async (_env, _thread, text) => { sent.push(text); }, () => "Box");
  return { dir, comms, sent, followUps };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("an order queued for a busy crew member is sent when that turn completes, once", async () => {
  const { comms, sent, followUps } = await setup();
  followUps.observe("e", [shell("a", "running")]);
  followUps.add("e", "t", "Open a PR");
  followUps.observe("e", [shell("a", "running")]);
  await tick();
  assert.deepEqual(sent, []);
  followUps.observe("e", [shell("a", "completed")]);
  await tick();
  followUps.observe("e", [shell("a", "completed")]);
  await tick();
  assert.deepEqual(sent, ["Open a PR"]);
  assert.equal(followUps.view().queued.length, 0);
  assert.ok(comms.since().some((e) => e.text.startsWith("Sent by follow-up to \"Fix CI\" on Box")));
});

test("it never goes out after a failed turn, a different turn, or while paused", async () => {
  const { comms, sent, followUps } = await setup();
  followUps.observe("e", [shell("a", "running")]);
  followUps.add("e", "t", "next");
  followUps.observe("e", [shell("a", "error")]);
  await tick();
  assert.deepEqual(sent, []);
  assert.ok(comms.since().some((e) => /not sent: the turn failed/.test(e.text)));

  followUps.observe("e", [shell("b", "running")]);
  followUps.add("e", "t", "next");
  followUps.observe("e", [shell("c", "running")]);
  assert.equal(followUps.view().queued.length, 0, "someone else's order started a new turn");

  followUps.observe("e", [shell("d", "running")]);
  followUps.add("e", "t", "held");
  followUps.setPaused(true);
  followUps.observe("e", [shell("d", "completed")]);
  await tick();
  assert.deepEqual(sent, [], "paused");
  followUps.setPaused(false);
  await tick();
  assert.deepEqual(sent, ["held"], "resuming sends what's due");
});

test("only busy crew can have a follow-up, one each, and it can be cancelled", async () => {
  const { followUps } = await setup();
  followUps.observe("e", [shell("a", "completed")]);
  assert.throws(() => followUps.add("e", "t", "x"), /isn't busy/);
  followUps.observe("e", [shell("b", "running", { hasPendingApprovals: true })]);
  followUps.add("e", "t", "first");
  const second = followUps.add("e", "t", "second");
  assert.deepEqual(followUps.view().queued.map((f) => f.text), ["second"]);
  assert.equal(followUps.cancel(second.id), true);
  assert.equal(followUps.view().queued.length, 0);
  assert.throws(() => followUps.add("e", "nobody", "x"), /isn't known/);
});

test("a standing order goes again after each turn it starts, until its count runs out", async () => {
  const { comms, sent, followUps } = await setup();
  followUps.observe("e", [shell("a", "running")]);
  followUps.add("e", "t", "Keep going", Date.now(), { times: 2 });
  assert.equal(followUps.view().queued[0].total, 2);
  followUps.observe("e", [shell("a", "completed")]);
  await tick();
  assert.deepEqual(sent, ["Keep going"]);
  assert.equal(followUps.view().queued[0].left, 1, "one more to go, waiting for the turn it started");
  assert.equal(followUps.view().queued[0].afterTurnId, null);
  followUps.observe("e", [shell("a", "completed")]);
  await tick();
  assert.equal(sent.length, 1, "the old turn doesn't count twice");
  followUps.observe("e", [shell("b", "running")]);
  assert.equal(followUps.view().queued[0].afterTurnId, "b");
  followUps.observe("e", [shell("b", "completed")]);
  await tick();
  assert.deepEqual(sent, ["Keep going", "Keep going"]);
  assert.equal(followUps.view().queued.length, 0);
  assert.ok(comms.since().some((e) => e.text.startsWith("Standing order 2 of 2 sent to \"Fix CI\"")));
});

test("a standing order given with an order sent now waits on that order's turn, and stops on a failure", async () => {
  const { comms, sent, followUps } = await setup();
  followUps.observe("e", [shell("a", "completed")]);
  followUps.add("e", "t", "Next step", Date.now(), { times: 3, startedAfter: "a" });
  assert.equal(followUps.view().queued[0].total, 4, "the order sent now, then three more");
  // The order's own turn starts and finishes before the server looks: it still counts.
  followUps.observe("e", [shell("b", "completed")]);
  await tick();
  assert.deepEqual(sent, ["Next step"]);
  followUps.observe("e", [shell("c", "error")]);
  await tick();
  assert.equal(followUps.view().queued.length, 0);
  assert.ok(comms.since().some((e) => /not sent: the turn failed/.test(e.text)));
  assert.throws(() => followUps.add("e", "t", "x", Date.now(), { times: 11, startedAfter: "c" }), /1–10 times/);
});

test("a standing order whose send never starts a turn is dropped, not left waiting", async () => {
  const { comms, followUps } = await setup();
  followUps.observe("e", [shell("a", "completed")]);
  const now = Date.now();
  followUps.add("e", "t", "Next", now - 4 * 60_000, { times: 2, startedAfter: "a" });
  followUps.observe("e", [shell("a", "completed")]);
  assert.equal(followUps.view().queued.length, 0);
  assert.ok(comms.since().some((e) => /didn't start a turn/.test(e.text)));
});
