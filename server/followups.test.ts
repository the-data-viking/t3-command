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

test("a send that errors isn't sent twice if it landed, is retried with backoff if not, and gives up loudly", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fu-"));
  const comms = new CommsLog(dir);
  let fail = true;
  const sent: string[] = [];
  const followUps = new FollowUps(dir, comms, async (_e, _t, text) => { sent.push(text); if (fail) throw new Error("socket closed"); }, () => "Box");
  followUps.observe("e", [shell("a", "running")]);
  followUps.add("e", "t", "Ship it");
  followUps.observe("e", [shell("a", "completed")]);
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(followUps.view().queued[0].uncertain?.attempts, 1);
  assert.ok(comms.since().some((e) => /didn't go through \(socket closed\); trying again shortly/.test(e.text)));
  followUps.observe("e", [shell("a", "completed")]);
  await tick();
  assert.equal(sent.length, 1, "not again before the backoff");
  // It had landed after all: its turn shows up, so it counts as sent, and nothing is resent.
  followUps.observe("e", [shell("b", "running")]);
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(followUps.view().queued.length, 0);
  assert.ok(comms.since().some((e) => e.text.startsWith("Sent by follow-up to \"Fix CI\"")));
  assert.ok(!comms.since().some((e) => /another order started/.test(e.text)), "not mistaken for someone else's order");
  fail = false;
  await comms.flush(); await followUps.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

test("decide: an errored send waits out its backoff, resends, and is dropped after five tries", async () => {
  const { decide } = await import("./followups.ts");
  const f = { id: "f", envId: "e", threadId: "t", afterTurnId: "a", text: "x", createdAt: 0, expiresAt: 10_000_000 };
  assert.deepEqual(decide({ ...f, uncertain: { attempts: 1, retryAt: 500 } }, shell("a", "completed"), 100), { action: "wait" });
  assert.deepEqual(decide({ ...f, uncertain: { attempts: 1, retryAt: 500 } }, shell("a", "completed"), 600), { action: "send" });
  assert.deepEqual(decide({ ...f, uncertain: { attempts: 5, retryAt: 0 } }, shell("a", "completed"), 600), { action: "drop", reason: "sending failed 5 times" });
  assert.deepEqual(decide({ ...f, uncertain: { attempts: 2, retryAt: 9e9 } }, shell("b", "running"), 600), { action: "landed", turnId: "b" });
});

test("replacing or cancelling a queued follow-up is said, and reported as dropped", async () => {
  const { comms, followUps } = await setup();
  const dropped: string[] = [];
  followUps.onDrop((f) => dropped.push(f.text));
  followUps.observe("e", [shell("a", "running")]);
  followUps.add("e", "t", "Keep going", Date.now(), { times: 5 });
  const second = followUps.add("e", "t", "Status?");
  assert.ok(comms.since().some((e) => e.text === "Standing order for \"Fix CI\" replaced by a newer one: Keep going"));
  followUps.cancel(second.id);
  assert.deepEqual(dropped, ["Keep going", "Status?"]);
  followUps.add("e", "t", "Third");
  followUps.forget("e");
  assert.deepEqual(dropped, ["Keep going", "Status?", "Third"]);
  assert.equal(followUps.view().queued.length, 0);
  assert.ok(comms.since().some((e) => /1 follow-up dropped: the machine was removed/.test(e.text)));
});

test("tick re-judges on a clock: a standing order whose send never started is dropped without an update", async () => {
  const { comms, followUps } = await setup();
  followUps.observe("e", [shell("a", "completed")]);
  followUps.add("e", "t", "Next", Date.now(), { times: 2, startedAfter: "a" });
  followUps.tick(Date.now() + 4 * 60_000);
  assert.equal(followUps.view().queued.length, 0);
  assert.ok(comms.since().some((e) => /didn't start a turn/.test(e.text)));
});

test("a standing order waits a moment after a clean turn before going again (time for a NOTHING LEFT to cancel it)", async () => {
  const { decide } = await import("./followups.ts");
  const f = { id: "f", envId: "e", threadId: "t", afterTurnId: "a", text: "x", createdAt: 0, expiresAt: 1e13, left: 2, total: 3 };
  const done = (at: number) => ({ ...shell("a", "completed"), latestTurn: { turnId: "a", state: "completed", requestedAt: "", startedAt: "", completedAt: new Date(at).toISOString(), assistantMessageId: null } }) as never;
  assert.deepEqual(decide(f, done(1_000_000), 1_005_000), { action: "wait" });
  assert.deepEqual(decide(f, done(1_000_000), 1_025_000), { action: "send" });
  assert.deepEqual(decide({ ...f, left: undefined, total: undefined }, done(1_000_000), 1_005_000), { action: "send" }, "a plain follow-up goes straight away");
});
