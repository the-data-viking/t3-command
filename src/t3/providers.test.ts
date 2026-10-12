import assert from "node:assert/strict";
import test from "node:test";
import { providerVersions } from "./providers";
import type { Provider, ProviderVersionAdvisory } from "./types";

const advisory = (over: Partial<ProviderVersionAdvisory> = {}): ProviderVersionAdvisory => ({
  status: "behind_latest", currentVersion: "1.0.0", latestVersion: "1.2.0", updateCommand: "npm i -g @openai/codex@latest", canUpdate: true, message: null, ...over,
});
const provider = (over: Partial<Provider> = {}): Provider => ({
  instanceId: "codex", driver: "codex", enabled: true, installed: true, status: "ready", models: [], version: "1.0.0", versionAdvisory: advisory(), ...over,
});

test("an outdated CLI T3 can update offers a one-click update", () => {
  const [v] = providerVersions([provider()]);
  assert.equal(v.label, "Codex");
  assert.equal(v.version, "1.0.0");
  assert.equal(v.latestVersion, "1.2.0");
  assert.equal(v.canUpdate, true);
  assert.equal(v.updating, false);
});

test("current, disabled and uninstalled providers offer no update", () => {
  assert.equal(providerVersions([provider({ versionAdvisory: advisory({ status: "current", latestVersion: "1.0.0" }) })])[0].latestVersion, undefined);
  assert.deepEqual(providerVersions([provider({ enabled: false }), provider({ instanceId: "c2", installed: false })]), []);
});

test("a latest release T3 marks incompatible is not offered", () => {
  const [v] = providerVersions([provider({ compatibilityAdvisory: { status: "supported", latestVersionStatus: "broken", message: null } })]);
  assert.equal(v.latestVersion, undefined);
  assert.equal(v.canUpdate, false);
});

test("instances of one driver share an entry; mismatched installers fall back to a manual command", () => {
  const work = provider({ instanceId: "codex-work", displayName: "Codex (work)" });
  assert.equal(providerVersions([provider(), work]).length, 1);
  assert.equal(providerVersions([provider(), work])[0].canUpdate, true);
  const brew = provider({ instanceId: "codex-brew", versionAdvisory: advisory({ updateCommand: "brew upgrade codex" }) });
  assert.equal(providerVersions([provider(), brew])[0].canUpdate, false);
  const [manual] = providerVersions([provider({ versionAdvisory: advisory({ canUpdate: false }) })]);
  assert.equal(manual.canUpdate, false);
  assert.equal(manual.updateCommand, "npm i -g @openai/codex@latest");
});

test("an in-flight update targets its instance; finished runs surface their outcome", () => {
  const running = provider({ instanceId: "codex-work", updateState: { status: "running", startedAt: "2026-10-12T10:00:00Z", finishedAt: null, message: null, output: null } });
  const [v] = providerVersions([provider(), running]);
  assert.equal(v.updating, true);
  assert.equal(v.instanceId, "codex-work");
  const failed = { status: "failed" as const, startedAt: "2026-10-12T10:00:00Z", finishedAt: "2026-10-12T10:01:00Z", message: "EACCES", output: "npm ERR!" };
  assert.equal(providerVersions([provider({ updateState: failed })])[0].lastUpdate?.message, "EACCES");
  assert.equal(providerVersions([provider({ updateState: { ...failed, status: "idle" } })])[0].lastUpdate, undefined);
});
