import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DISPATCH_MAX, DISPATCH_TTL_MS, sanitizeMembers } from "../shared/dispatches.ts";
import { CommsLog } from "./comms.ts";
import { Dispatches } from "./dispatches.ts";

const member = (threadId: string, how = "sent") => ({ envId: "e", threadId, title: threadId, how, baseTurnId: "t1" });

test("dispatches persist owner-only, take retries, close, and tell subscribers", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatches-"));
  try {
    const store = new Dispatches(dir);
    await store.load();
    const seen: number[] = [];
    store.subscribe((list) => seen.push(list.length));
    const d = store.add("  Status please.  ", [member("a"), member("b", "failed")]);
    assert.equal(d.text, "Status please.");
    store.update(d.id, [member("b", "sent"), member("stranger")]);
    assert.deepEqual(store.all()[0].members.map((m) => m.how), ["sent", "sent"]);
    await store.flush();
    assert.equal((await fs.stat(path.join(dir, "dispatches.json"))).mode & 0o777, 0o600);
    const again = new Dispatches(dir);
    await again.load();
    assert.equal(again.all()[0].members.length, 2);
    assert.equal(store.close(d.id), true);
    assert.equal(store.close(d.id), false);
    assert.equal(store.update("nope", []), undefined);
    assert.deepEqual(seen, [1, 1, 0]);
    assert.throws(() => store.add("", [member("a")]));
    assert.throws(() => store.add("x", []));
    await store.flush();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("only the newest dispatches are kept, and old ones age out", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatches-"));
  try {
    const store = new Dispatches(dir);
    for (let i = 0; i < DISPATCH_MAX + 5; i++) store.add(`order ${i}`, [member("a")], 1_000 + i);
    await store.flush();
    assert.equal(store.all(1_000).length, DISPATCH_MAX);
    assert.equal(store.all(1_000)[0].text, `order ${DISPATCH_MAX + 4}`);
    assert.equal(store.all(1_000 + DISPATCH_TTL_MS + DISPATCH_MAX + 5).length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("members are validated: one per crew member, known kinds only", () => {
  assert.deepEqual(sanitizeMembers("x"), []);
  const clean = sanitizeMembers([member("a"), member("a"), { envId: "e", threadId: "b", how: "lost" }, { envId: "", threadId: "c", how: "sent" }, { envId: "e", threadId: "d", how: "queued", baseTurnId: 7 }]);
  assert.deepEqual(clean.map((m) => [m.threadId, m.how, m.baseTurnId]), [["a", "sent", "t1"], ["d", "queued", null]]);
});

test("a mission keeps its name, goal and each member's part across a restart", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatches-"));
  try {
    const store = new Dispatches(dir);
    store.add("Tiles render at 60 fps.", [{ ...member("a"), part: " Renderer " }, member("b")], Date.now(), { name: "Ship it", goal: "Tiles render at 60 fps." });
    await store.flush();
    const again = new Dispatches(dir);
    await again.load();
    const d = again.all()[0];
    assert.deepEqual(d.mission, { name: "Ship it", goal: "Tiles render at 60 fps." });
    assert.deepEqual(d.members.map((m) => m.part), ["Renderer", undefined]);
    assert.equal(store.add("plain", [member("a")]).mission, undefined, "no name and goal: an ordinary squad order");
    await store.flush();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const shell = (id: string, turnId: string | null, state = "completed", over: Record<string, unknown> = {}) =>
  ({ id, title: id, archivedAt: null, hasPendingApprovals: false, hasPendingUserInput: false, latestTurn: turnId ? { turnId, state } : null, ...over }) as never;

test("once every crew member's part is over, the order is announced once, with how it went", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatches-"));
  try {
    const store = new Dispatches(dir);
    const comms = new CommsLog(dir);
    let queued = true;
    store.announceTo(comms, (_e, t) => queued && t === "c");
    const d = store.add("Status?", [member("a"), member("b"), { ...member("c"), how: "queued" }, { ...member("x"), how: "failed" }], Date.now(),
      { name: "Ship it", goal: "Done." });
    store.observe("e", [shell("a", "t2", "running"), shell("b", "t1"), shell("c", "t1"), shell("x", "t1")]);
    assert.equal(comms.since().length, 0, "a still working, b not started, c queued");
    store.observe("e", [shell("a", "t2"), shell("b", "t2", "error"), shell("c", "t1"), shell("x", "t1")]);
    assert.equal(comms.since().length, 0, "c's follow-up hasn't gone out yet");
    queued = false;
    store.observe("e", [shell("a", "t2"), shell("b", "t2", "error"), shell("c", "t3", "completed", { hasPendingApprovals: true }), shell("x", "t1")]);
    assert.equal(comms.since().length, 0, "c is waiting on you");
    store.observe("e", [shell("a", "t2"), shell("b", "t2", "error"), shell("c", "t3"), shell("x", "t1")]);
    const said = comms.since();
    assert.equal(said.length, 1);
    assert.equal(said[0].kind, "mission");
    assert.equal(said[0].dispatchId, d.id);
    assert.equal(said[0].text, `Mission "Ship it": 2 of 4 reported, 1 failed, 1 never sent. Replies are ready to read.`);
    assert.ok(store.all()[0].finishedAt);
    store.observe("e", [shell("a", "t9")]);
    assert.equal(comms.since().length, 1, "said once");
    await store.flush(); await comms.flush();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an order's crew on a machine not seen yet are waited for, and a removed thread counts as gone", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatches-"));
  try {
    const store = new Dispatches(dir);
    const comms = new CommsLog(dir);
    store.announceTo(comms, () => false);
    store.add("Go", [member("a"), { ...member("b"), envId: "other" }]);
    store.observe("e", [shell("a", "t2")]);
    assert.equal(comms.since().length, 0, "the other machine hasn't reported");
    store.observe("other", []);
    assert.match(comms.since()[0].text, /^Squad order "Go": 1 of 2 reported, 1 gone\./);
    await store.flush(); await comms.flush();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a queued member whose follow-up was dropped ends the order as never sent, even if a later turn runs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatches-"));
  try {
    const store = new Dispatches(dir);
    const comms = new CommsLog(dir);
    store.announceTo(comms, () => false);
    store.add("Go", [member("a"), { ...member("b"), how: "queued" }], Date.now() - 300_000);
    store.observe("e", [shell("a", "t2"), shell("b", "t1")]);
    assert.equal(comms.since().length, 0, "b is still queued (its follow-up may be on its way)");
    store.followUpDropped("e", "b", "t1");
    assert.equal(store.all()[0].members[1].dropped, true);
    assert.match(comms.since()[0].text, /^Squad order "Go": 1 of 2 reported, 1 never sent\./);
    await store.flush(); await comms.flush();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a retry that reaches a failed member reopens a finished order; all-failed waits for one", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatches-"));
  try {
    const store = new Dispatches(dir);
    const comms = new CommsLog(dir);
    store.announceTo(comms, () => false);
    const now = Date.now();
    const all = store.add("Go", [{ ...member("a"), how: "failed" }], now);
    store.observe("e", [shell("a", "t1")], now + 1_000);
    assert.equal(comms.since().length, 0, "every send failed just now: a retry gets a chance");
    store.observe("e", [shell("a", "t1")], now + 130_000);
    assert.equal(comms.since().length, 1);
    assert.ok(store.all(now + 130_000).find((d) => d.id === all.id)?.finishedAt);
    store.update(all.id, [{ ...member("a"), how: "sent" }]);
    assert.equal(store.all(now + 130_000).find((d) => d.id === all.id)?.finishedAt, undefined, "reopened");
    store.observe("e", [shell("a", "t2")], now + 140_000);
    assert.equal(comms.since().length, 2, "and announced again once the retried part is over");
    await store.flush(); await comms.flush();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the clock ends an order whose sent member never started, without any thread update", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatches-"));
  try {
    const store = new Dispatches(dir);
    const comms = new CommsLog(dir);
    store.announceTo(comms, () => false);
    const now = Date.now();
    store.add("Go", [member("a")], now);
    store.observe("e", [shell("a", "t1")], now + 1_000);
    assert.equal(comms.since().length, 0);
    store.tick(now + 200_000);
    assert.match(comms.since()[0].text, /^Squad order "Go": 0 of 1 reported, 1 didn't start\./);
    await store.flush(); await comms.flush();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("each member is pinned to the turn its order started: a later turn doesn't rewrite its result", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatches-"));
  try {
    const store = new Dispatches(dir);
    const comms = new CommsLog(dir);
    store.announceTo(comms, () => false);
    const d = store.add("Go", [member("a"), member("b")]);
    store.observe("e", [shell("a", "t2", "running"), shell("b", "t2", "running")]);
    assert.deepEqual(store.all()[0].members.map((m) => m.turnId), ["t2", "t2"], "pinned when their turns started");
    store.observe("e", [shell("a", "t2", "error"), shell("b", "t2", "running")]);
    assert.equal(store.all()[0].members[0].result, "error");
    // You step in on a: a new turn completes cleanly. It doesn't make a's part "reported".
    store.observe("e", [shell("a", "t3", "completed"), shell("b", "t2", "completed")]);
    const m = store.all().find((x) => x.id === d.id)!.members;
    assert.deepEqual([m[0].result, m[1].result], ["error", "completed"]);
    assert.match(comms.since()[0].text, /1 of 2 reported, 1 failed\./);
    // A turn that started and ended between two observations: another took over before it was seen.
    const e = store.add("Again", [member("a")]);
    store.observe("e", [shell("a", "t5", "running")]);
    store.observe("e", [shell("a", "t6", "completed")]);
    assert.equal(store.all().find((x) => x.id === e.id)!.members[0].result, "superseded");
    await store.flush(); await comms.flush();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a mission's next round joins it: numbered, announced as that round, closed together", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatches-"));
  try {
    const store = new Dispatches(dir);
    const comms = new CommsLog(dir);
    store.announceTo(comms, () => false);
    const first = store.add("Goal.", [member("a")], Date.now(), { name: "Ship", goal: "Goal." });
    const second = store.add("Now wire it up.", [member("a")], Date.now(), { name: "Ship", goal: "Goal." }, { missionId: first.id });
    const third = store.add("And document it.", [member("a")], Date.now(), { name: "Ship", goal: "Goal." }, { missionId: first.id });
    assert.deepEqual([second.missionId, second.round, third.round], [first.id, 2, 3]);
    assert.equal(store.add("x", [member("a")], Date.now(), undefined, { missionId: "nope" }).round, undefined, "an unknown mission starts no round");
    store.observe("e", [shell("a", "t9")]);
    assert.ok(comms.since().some((e) => e.text.startsWith("Mission \"Ship\", round 3:")));
    store.close(second.id);
    assert.equal(store.all().filter((d) => d.id === first.id || d.missionId === first.id).length, 0, "closing any round closes the mission");
    await store.flush(); await comms.flush();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
