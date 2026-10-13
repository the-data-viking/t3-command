import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_PLAYBOOKS, expandPlaybook, sanitizePlaybooks } from "../shared/playbooks.ts";
import { Playbooks } from "./playbooks.ts";

test("playbooks start from the defaults, persist owner-only, and reject junk", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "playbooks-"));
  try {
    const books = new Playbooks(dir);
    await books.load();
    assert.deepEqual(books.all(), DEFAULT_PLAYBOOKS);
    await books.set([{ name: "Ship", text: "  Ship it.  " }]);
    assert.equal((await fs.stat(path.join(dir, "playbooks.json"))).mode & 0o777, 0o600);
    const again = new Playbooks(dir);
    await again.load();
    assert.deepEqual(again.all(), [{ name: "ship", text: "Ship it." }]);
    await assert.rejects(books.set("nope"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sanitizing drops bad names, empty texts and duplicates", () => {
  assert.equal(sanitizePlaybooks({}), undefined);
  assert.deepEqual(sanitizePlaybooks([
    { name: "ok", text: "a" },
    { name: "ok", text: "duplicate" },
    { name: "has space", text: "b" },
    { name: "-dash-first", text: "c" },
    { name: "empty", text: "   " },
    null,
    "junk",
  ]), [{ name: "ok", text: "a" }]);
  assert.equal(sanitizePlaybooks(Array.from({ length: 60 }, (_, i) => ({ name: `p${i}`, text: "x" })))!.length, 50);
});

test("a leading /name expands; trailing text is kept; anything else is left alone", () => {
  const books = [{ name: "status", text: "Give me a status." }];
  assert.equal(expandPlaybook("/status", books), "Give me a status.");
  assert.equal(expandPlaybook("  /status  focus on the tests", books), "Give me a status.\n\nfocus on the tests");
  assert.equal(expandPlaybook("/unknown", books), "/unknown");
  assert.equal(expandPlaybook("please /status", books), "please /status");
  assert.equal(expandPlaybook("/statusx", books), "/statusx");
});
