import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DISPATCH_MAX, DISPATCH_TTL_MS, sanitizeMembers } from "../shared/dispatches.ts";
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
