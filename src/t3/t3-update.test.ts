import assert from "node:assert/strict";
import test from "node:test";
import type { EnvWorld } from "../store";
import { behindMachines, compareVersions, t3UpdateOffer } from "./t3-update";

const env = (id: string, version: string, extra: Partial<EnvWorld["summary"]> = {}, running = 0, connection = "live") => ({
  summary: { id, label: id, serverVersion: version, protocolVersion: 1, ...extra },
  connection,
  threads: Object.fromEntries(Array.from({ length: running }, (_, i) => [`t${i}`, { id: `t${i}`, latestTurn: { state: "running" } }])),
}) as unknown as EnvWorld;
const desktop = { selfUpdate: { method: "desktop-managed" as const, desktopAppUpdate: true, continuesThreads: true } };

test("versions compare numerically, part by part", () => {
  assert.ok(compareVersions("0.0.9", "0.0.10") < 0);
  assert.ok(compareVersions("0.1.0", "0.0.45") > 0);
  assert.equal(compareVersions("0.0.45", "0.0.45"), 0);
});

test("a machine behind the latest can update, says what happens to crew, and whether the version is proven", () => {
  const envs = { a: env("a", "0.0.44", desktop, 2), b: env("b", "0.0.45") };
  const o = t3UpdateOffer("a", envs, "0.0.45")!;
  assert.deepEqual([o.behind, o.can, o.running, o.continues, o.proven, o.method], [true, true, 2, true, true, "desktop-managed"]);
  assert.equal(t3UpdateOffer("b", envs, "0.0.45")!.behind, false);
  assert.equal(t3UpdateOffer("a", { a: envs.a }, "0.0.45")!.proven, false, "nothing else runs it yet");
  assert.deepEqual(behindMachines(envs, "0.0.45"), ["a"]);
});

test("no remote update without the capability, a desktop app that refuses, or a connection", () => {
  assert.match(t3UpdateOffer("a", { a: env("a", "0.0.44") }, "0.0.45")!.reason!, /can't update remotely/);
  assert.match(t3UpdateOffer("a", { a: env("a", "0.0.44", { selfUpdate: { method: "desktop-managed", desktopAppUpdate: false, continuesThreads: false } }) }, "0.0.45")!.reason!, /desktop app/);
  assert.equal(t3UpdateOffer("a", { a: env("a", "0.0.44", desktop, 0, "offline") }, "0.0.45")!.can, false);
  assert.equal(t3UpdateOffer("h", { h: env("h", "1.0", { kind: "hermes" }) }, "0.0.45"), undefined, "Hermes has no T3");
});
