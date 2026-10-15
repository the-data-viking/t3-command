import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Prefs } from "./prefs.ts";

test("prefs: patches merge, null clears, Normal is the absence of a level, and it all persists", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3c-prefs-"));
  const prefs = new Prefs(dir);
  await prefs.load();
  prefs.update({ provider: "codex", models: { codex: { instanceId: "codex", model: "gpt-6.1-sol", options: [{ id: "reasoningEffort", value: "high" }] } } });
  prefs.update({ models: { claudeAgent: { instanceId: "claudeAgent", model: "claude-opus-5-5" } }, routing: { a: "manual", b: "prefer" } });
  prefs.update({ routing: { b: null, c: "normal", d: "bogus" }, models: { codex: { instanceId: "other", model: "x" } } });
  const want = {
    provider: "codex",
    models: {
      codex: { instanceId: "codex", model: "gpt-6.1-sol", options: [{ id: "reasoningEffort", value: "high" }] },
      claudeAgent: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    },
    routing: { a: "manual" },
  };
  assert.deepEqual(prefs.all(), want, "a mismatched model entry is dropped");
  prefs.forget("a");
  prefs.update({ provider: null });
  await prefs.flush();
  const again = new Prefs(dir);
  await again.load();
  assert.deepEqual(again.all(), { models: want.models, routing: {} });
  assert.throws(() => prefs.update([]));
});
