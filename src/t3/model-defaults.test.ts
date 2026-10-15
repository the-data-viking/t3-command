import assert from "node:assert/strict";
import test from "node:test";
import { isMyDefault, providerDefault, startingSelection, t3Defaults } from "./model-defaults";
import type { Provider } from "./types";

const provider = (instanceId: string, slugs: string[], isDefault: string): Provider => ({
  instanceId, driver: instanceId, enabled: true, installed: true, status: "ready",
  models: slugs.map((slug) => ({ slug, name: slug, isDefault: slug === isDefault })),
}) as unknown as Provider;
const codex = provider("codex", ["gpt-6.1-sol", "gpt-6-astra"], "gpt-6-astra");
const claude = provider("claudeAgent", ["claude-opus-5-5", "claude-fable-5-1"], "claude-fable-5-1");
const none = { models: {}, routing: {} };
const sol = { instanceId: "codex", model: "gpt-6.1-sol", options: [{ id: "reasoningEffort", value: "high" }] };

test("with no Command default, a machine starts on its own T3 default, not T3's built-in one", () => {
  const t3 = t3Defaults({ defaultModelSelection: sol });
  assert.deepEqual(startingSelection([claude, codex], { prefs: none, t3 }), sol);
});

test("a T3 project override beats the machine's server-wide default", () => {
  const t3 = t3Defaults({ defaultModelSelection: sol, projectSettingsOverrides: { p: { defaultModelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } } } });
  assert.equal(startingSelection([codex, claude], { prefs: none, t3, projectId: "p" })?.model, "claude-opus-5-5");
});

test("your Command default wins on every machine, and switching provider keeps your model for it", () => {
  const prefs = { provider: "claudeAgent", models: { claudeAgent: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, codex: sol }, routing: {} };
  const t3 = t3Defaults({ defaultModelSelection: { instanceId: "codex", model: "gpt-6-astra" } });
  assert.equal(startingSelection([codex, claude], { prefs, t3 })?.model, "claude-opus-5-5");
  assert.deepEqual(providerDefault(codex, { prefs, t3 }), sol);
});

test("switching to a provider with no default of yours uses the machine's choice, then T3's built-in", () => {
  const t3 = t3Defaults({ defaultModelSelection: sol });
  assert.equal(providerDefault(codex, { prefs: none, t3 }).model, "gpt-6.1-sol");
  assert.equal(providerDefault(claude, { prefs: none, t3 }).model, "claude-fable-5-1");
});

test("a default for a model this machine lacks is skipped", () => {
  const prefs = { provider: "codex", models: { codex: { instanceId: "codex", model: "gpt-7" } }, routing: {} };
  assert.equal(startingSelection([codex], { prefs })?.model, "gpt-6-astra");
});

test("isMyDefault: same provider, model and options, in any order", () => {
  const prefs = { provider: "codex", models: { codex: { ...sol, options: [{ id: "a", value: "1" }, { id: "b", value: true }] } }, routing: {} };
  assert.equal(isMyDefault(prefs, { ...sol, options: [{ id: "b", value: true }, { id: "a", value: "1" }] }), true);
  assert.equal(isMyDefault(prefs, { ...sol, options: [{ id: "a", value: "2" }] }), false);
  assert.equal(isMyDefault({ ...prefs, provider: "claudeAgent" }, prefs.models.codex), false);
});
