import assert from "node:assert/strict";
import test from "node:test";
import type { EnvWorld } from "../store";
import type { Provider } from "./types";
import { parseDiff } from "./diff";
import { fleetLimits, limitLevel } from "./limits";

const env = (label: string, providers: Partial<Provider>[]) =>
  ({ summary: { id: label, label }, providers: providers.map((p) => ({ enabled: true, installed: true, status: "ready", models: [], driver: p.instanceId, ...p })) }) as unknown as EnvWorld;
const weekly = (usedPercent: number) => ({ checkedAt: "2026-10-12T00:00:00Z", windows: [{ id: "w", kind: "weekly" as const, label: "Weekly", usedPercent, resetsAt: "2026-10-18T04:13:00Z" }] });

test("one account reported by several machines shows once, with every machine listed", () => {
  const limits = fleetLimits([
    env("Mac mini", [{ instanceId: "codex", displayName: "Codex", usageLimits: weekly(15.2) }]),
    env("Wesley", [{ instanceId: "codex", displayName: "Codex", usageLimits: weekly(15.4) }]),
    env("Agent 3", [{ instanceId: "codex", displayName: "Codex", usageLimits: weekly(62) }]),
  ]);
  assert.equal(limits.windows.length, 2);
  assert.deepEqual(limits.windows[0], { provider: "Codex", label: "Weekly", usedPercent: 62, resetsAt: "2026-10-18T04:13:00Z", machines: ["Agent 3"] });
  assert.deepEqual(limits.windows[1].machines, ["Mac mini", "Wesley"]);
  assert.equal(limits.peak, 62);
});

test("missing quotas explain themselves; disabled providers and their notes stay out", () => {
  const limits = fleetLimits([
    env("A", [
      { instanceId: "codex", usageLimits: { checkedAt: "", windows: [], unavailable: { reason: "probeFailed", message: "JSON-RPC -32600" } } },
      { instanceId: "claudeAgent", displayName: "Claude", message: "Claude Code is too old", usageLimits: { checkedAt: "", windows: [], unavailable: { reason: "unsupported" } } },
      { instanceId: "cursor", status: "disabled", message: "Cursor is disabled in T3 Code settings." },
    ]),
    env("B", [{ instanceId: "claudeAgent", displayName: "Claude", message: "Claude Code is too old" }]),
  ]);
  assert.equal(limits.peak, undefined);
  assert.deepEqual(limits.notes.map((n) => [n.provider, n.text, n.machines.join("+")]), [
    ["codex", "Usage could not be read: JSON-RPC -32600", "A"],
    ["Claude", "Usage limits are not reported", "A"],
    ["Claude", "Claude Code is too old", "A+B"],
  ]);
});

test("quota gauges warn earlier than host load", () => {
  assert.deepEqual([50, 75, 89, 90].map(limitLevel), ["ok", "high", "high", "critical"]);
});

test("unified diffs split into files with counted additions and deletions", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts", "index 1..2 100644", "--- a/src/a.ts", "+++ b/src/a.ts",
    "@@ -1,3 +1,3 @@", " keep", "-old", "+new", "+more", "\\ No newline at end of file",
    "diff --git a/img.png b/img.png", "new file mode 100644", "Binary files /dev/null and b/img.png differ",
    "diff --git a/gone.ts b/gone.ts", "deleted file mode 100644", "--- a/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
  ].join("\n");
  const { files, truncated } = parseDiff(diff);
  assert.equal(truncated, false);
  assert.deepEqual(files.map((f) => [f.path, f.additions, f.deletions, f.binary]), [["src/a.ts", 2, 1, false], ["img.png", 0, 0, true], ["gone.ts", 0, 1, false]]);
  assert.deepEqual(files[0].lines.map((l) => l.kind), ["hunk", "ctx", "del", "add", "add", "meta"]);
  assert.equal(files[0].lines[3].text, "new");
});

test("huge diffs stop rendering at the budget but keep counting", () => {
  const diff = ["diff --git a/x b/x", "@@ -0,0 +1,10 @@", ...Array.from({ length: 10 }, (_, i) => `+line ${i}`)].join("\n");
  const { files, truncated } = parseDiff(diff, 5);
  assert.equal(truncated, true);
  assert.equal(files[0].lines.length, 5);
  assert.equal(files[0].additions, 10);
});
