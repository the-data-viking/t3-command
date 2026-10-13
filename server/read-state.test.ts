import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_MARKS, ReadState } from "./read-state.ts";

test("read marks persist owner-only, report only real changes, and reach listeners", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-"));
  const state = new ReadState(dir);
  await state.load();
  const heard: Array<Record<string, string>> = [];
  state.subscribe((changed) => heard.push(changed));
  assert.deepEqual(state.mark({ "e:t1": "turn-a", "e:t2": "turn-b" }), { "e:t1": "turn-a", "e:t2": "turn-b" });
  assert.deepEqual(state.mark({ "e:t1": "turn-a" }), {}, "the same mark again changes nothing");
  assert.deepEqual(state.mark({ "e:t1": "turn-c" }), { "e:t1": "turn-c" }, "a later turn's read replaces it");
  assert.equal(heard.length, 2);
  await state.flush();
  assert.equal((await fs.stat(path.join(dir, "read-reports.json"))).mode & 0o777, 0o600);
  const again = new ReadState(dir);
  await again.load();
  assert.deepEqual(again.all(), { "e:t1": "turn-c", "e:t2": "turn-b" });
});

test("the oldest marks are dropped past the cap; junk is ignored", async () => {
  const state = new ReadState(await fs.mkdtemp(path.join(os.tmpdir(), "read-")));
  state.mark(Object.fromEntries(Array.from({ length: MAX_MARKS + 3 }, (_, i) => [`e:t${i}`, "x"])));
  const all = state.all();
  assert.equal(Object.keys(all).length, MAX_MARKS);
  assert.equal(all["e:t0"], undefined);
  assert.equal(all[`e:t${MAX_MARKS + 2}`], "x");
  assert.deepEqual(state.mark({ "e:bad": 7 } as unknown as Record<string, string>), {});
});
