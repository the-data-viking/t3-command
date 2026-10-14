import assert from "node:assert/strict";
import test from "node:test";
import { T3LatestVersion } from "./t3-latest.ts";
import { selfUpdateOf } from "./registry.ts";

test("npm's latest t3 release is cached, and a failed check keeps the last answer", async () => {
  let calls = 0, now = 1_000_000, body: unknown = { version: "0.0.45" }, ok = true;
  const fake = (async () => { calls++; return { ok, status: ok ? 200 : 503, json: async () => body }; }) as unknown as typeof fetch;
  const latest = new T3LatestVersion(fake, () => now);
  assert.equal((await latest.get()).version, "0.0.45");
  await latest.get();
  assert.equal(calls, 1, "cached");
  now += 2 * 3_600_000; ok = false;
  assert.equal((await latest.get()).version, "0.0.45", "kept through a failure");
  now += 2 * 3_600_000; ok = true; body = { version: "latest" };
  assert.equal((await latest.get()).version, "0.0.45", "never a dist-tag");
});

test("a descriptor's self-update capability, or none", () => {
  assert.deepEqual(selfUpdateOf({ capabilities: { serverSelfUpdate: "desktop-managed", desktopAppUpdate: true, serverUpdateThreadContinuation: true } }),
    { method: "desktop-managed", desktopAppUpdate: true, continuesThreads: true });
  assert.equal(selfUpdateOf({ capabilities: {} }), undefined);
  assert.equal(selfUpdateOf({}), undefined);
});
