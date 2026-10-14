import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PUSH_RULES, deviceWants, inQuietHours, sanitizeDeviceKinds, sanitizeRules, shouldPush, type PushRules } from "../shared/push.ts";
import { quietSince, QUIET_MS } from "./long-turns.ts";
import { notificationFor, PushNotifier } from "./push.ts";
import type { ThreadShell } from "../src/t3/types.ts";

const rules = (over: Partial<PushRules["quiet"]> = {}): PushRules => ({ ...DEFAULT_PUSH_RULES, quiet: { ...DEFAULT_PUSH_RULES.quiet, enabled: true, timeZone: "UTC", ...over } });
const at = (hhmm: string) => new Date(`2026-10-13T${hhmm}:00Z`);

test("quiet hours wrap past midnight and let only the allowed kinds through", () => {
  const r = rules({ start: "22:00", end: "07:00", allow: ["approval"] });
  assert.equal(inQuietHours(r, at("23:30")), true);
  assert.equal(inQuietHours(r, at("06:59")), true);
  assert.equal(inQuietHours(r, at("07:00")), false);
  assert.equal(shouldPush(r, "approval", at("03:00")), true, "approvals still wake you");
  assert.equal(shouldPush(r, "question", at("03:00")), false);
  assert.equal(shouldPush(r, "question", at("12:00")), true);
  assert.equal(inQuietHours(rules({ start: "09:00", end: "17:00" }), at("12:00")), true, "a daytime window works too");
});

test("only pushable, enabled kinds are pushed; routine and unknown kinds never are", () => {
  const r = { ...DEFAULT_PUSH_RULES, kinds: { ...DEFAULT_PUSH_RULES.kinds, done: false } };
  assert.equal(shouldPush(r, "done", at("12:00")), false);
  assert.equal(shouldPush(r, "started", at("12:00")), false);
  assert.equal(shouldPush(r, undefined, at("12:00")), false);
  assert.equal(shouldPush(r, "failed", at("12:00")), true);
});

test("rules from a client are cleaned: bad times and unknown kinds fall back to defaults", () => {
  const clean = sanitizeRules({ kinds: { approval: false, bogus: true }, quiet: { enabled: true, start: "25:00", end: "06:30", allow: ["approval", "nope"] } })!;
  assert.equal(clean.kinds.approval, false);
  assert.equal("bogus" in clean.kinds, false);
  assert.equal(clean.quiet.start, DEFAULT_PUSH_RULES.quiet.start);
  assert.equal(clean.quiet.end, "06:30");
  assert.deepEqual(clean.quiet.allow, ["approval"]);
  assert.equal(sanitizeRules("nope"), undefined);
});

test("a notification says what happened and where, and links straight to the crew member", () => {
  const n = notificationFor({ id: 1, at: 0, tone: "alert", kind: "approval", text: "\"Fix CI\" needs your approval", envId: "mini", threadId: "t 1" }, "Mac mini");
  assert.deepEqual(n, { title: "Approval needed", body: "\"Fix CI\" needs your approval · Mac mini", url: "/#decide/mini/t%201", tag: "approval:mini:t 1" });
  assert.equal(notificationFor({ id: 2, at: 0, tone: "bad", kind: "offline", text: "Lost contact with Box", envId: "box" }).url, "/#host/box");
});

test("a running turn with no update for a while, and not waiting on you, has gone quiet", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  const t = (updatedMinAgo: number, over: Partial<ThreadShell> = {}) => ({ updatedAt: new Date(now - updatedMinAgo * 60_000).toISOString(), hasPendingApprovals: false, hasPendingUserInput: false,
    latestTurn: { state: "running" }, ...over }) as unknown as ThreadShell;
  assert.equal(quietSince(t(5), now), undefined);
  assert.equal(quietSince(t(QUIET_MS / 60_000 + 1), now), now - (QUIET_MS / 60_000 + 1) * 60_000);
  assert.equal(quietSince(t(60, { hasPendingApprovals: true }), now), undefined, "waiting on you isn't quiet");
  assert.equal(quietSince(t(60, { latestTurn: { state: "completed" } } as Partial<ThreadShell>), now), undefined);
});

test("each device can narrow what it gets: everything, only some kinds, or nothing", () => {
  assert.equal(deviceWants(null, "done"), true);
  assert.equal(deviceWants(undefined, "done"), true);
  assert.equal(deviceWants(["approval"], "approval"), true);
  assert.equal(deviceWants(["approval"], "done"), false);
  assert.equal(deviceWants([], "approval"), false, "an empty list mutes the device");
  assert.deepEqual(sanitizeDeviceKinds(["done", "bogus", "approval"]), ["approval", "done"]);
  assert.equal(sanitizeDeviceKinds(null), null);
  assert.equal(sanitizeDeviceKinds("approval"), undefined);
});

test("a device's filter is saved, survives a restart and a re-subscribe, and unknown devices are refused", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "push-"));
  try {
    const push = new PushNotifier(dir);
    await push.load();
    const subscription = { endpoint: "https://push.example/abc", keys: { p256dh: "k", auth: "a" } };
    push.subscribe(subscription, "iPhone · Safari");
    assert.equal(push.status().devices[0].kinds, null);
    push.setDeviceKinds(subscription.endpoint, ["approval", "question"]);
    push.subscribe(subscription, "iPhone · Safari");
    assert.deepEqual(push.status().devices[0].kinds, ["approval", "question"]);
    assert.throws(() => push.setDeviceKinds("https://push.example/nobody", null), /No such device/);
    assert.throws(() => push.setDeviceKinds(subscription.endpoint, "all"), /list of event kinds/);
    await push.flush();
    const again = new PushNotifier(dir);
    await again.load();
    assert.deepEqual(again.status().devices[0].kinds, ["approval", "question"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a finished squad order's notification opens its replies", () => {
  const n = notificationFor({ id: 1, at: 0, tone: "good", kind: "mission", text: "Mission \"Ship it\": 3 of 3 reported.", dispatchId: "d 1" });
  assert.equal(n.title, "Squad order finished");
  assert.equal(n.url, "/#replies/d%201");
  assert.equal(shouldPush(DEFAULT_PUSH_RULES, "mission", new Date()), true, "on by default");
});

test("pushes are signed with an https contact by default (Apple rejects mailto:…@localhost)", async () => {
  const { DEFAULT_PUSH_SUBJECT } = await import("./push.ts");
  assert.match(DEFAULT_PUSH_SUBJECT, /^https:\/\//);
});
