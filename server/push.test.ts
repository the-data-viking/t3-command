import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PUSH_RULES, deviceWants, inQuietHours, sanitizeDeviceKinds, sanitizeRules, shouldPush, type PushRules } from "../shared/push.ts";
import { notificationFor, PushKeyChanged, PushNotifier } from "./push.ts";

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

test("rotating the key signs with the new one at once, keeps it owner-only, and leaves old subscriptions stale until their device subscribes again", async (t) => {
  const webpush = (await import("web-push")).default;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "push-"));
  try {
    const push = new PushNotifier(dir);
    await push.load();
    const before = push.status().publicKey;
    const old = { endpoint: "https://push.example/old", keys: { p256dh: "k", auth: "a" } };
    push.subscribe(old, "iPhone · Safari");
    push.setDeviceKinds(old.endpoint, ["approval"]);
    // A device from before keys were recorded: made with the only key there was.
    push.subscribe({ endpoint: "https://push.example/legacy", keys: { p256dh: "k", auth: "a" } }, "Mac · Chrome");
    await push.flush();
    const legacy = JSON.parse(await fs.readFile(path.join(dir, "push-subscriptions.json"), "utf8")) as Array<{ key?: string }>;
    delete legacy[1].key;
    await fs.writeFile(path.join(dir, "push-subscriptions.json"), JSON.stringify(legacy));
    await push.load();
    assert.equal(push.status().devices.some((d) => d.stale), false, "nothing is stale before a rotation");

    const { publicKey, stale } = await push.rotate();
    assert.notEqual(publicKey, before);
    assert.equal(stale, 2, "both the stamped and the unstamped subscription were made with the old key");
    assert.equal(push.status().publicKey, publicKey);
    const signer = webpush.generateRequestDetails({ endpoint: "https://push.example/x", keys: { p256dh: "k", auth: "a" } }, null);
    assert.match(String(signer.headers.Authorization), new RegExp(`k=${publicKey}$`), "the live signer is the new key, not just the file");
    const file = path.join(dir, "push-vapid.json");
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.readdir(dir)).some((f) => f.endsWith(".tmp")), false);
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).publicKey, publicKey);

    const sent = t.mock.method(webpush, "sendNotification", async () => ({}));
    assert.equal(push.wants({ id: 1, at: Date.now(), tone: "alert", kind: "approval", text: "x" }), false, "nothing can reach a stale device");
    assert.deepEqual(await push.test(), { sent: 0, errors: [] });
    assert.equal(sent.mock.callCount(), 0);

    // The phone turns push on again: a new subscription replaces the old one and keeps its filter.
    const fresh = { endpoint: "https://push.example/new", keys: { p256dh: "k2", auth: "a2" } };
    push.subscribe(fresh, "iPhone · Safari", old.endpoint);
    const devices = push.status().devices;
    assert.deepEqual(devices.map((d) => [d.endpoint, d.stale]), [["https://push.example/legacy", true], [fresh.endpoint, false]]);
    assert.deepEqual(devices[1].kinds, ["approval"]);
    assert.deepEqual(await push.test(), { sent: 1, errors: [] });
    assert.equal(sent.mock.calls[0]?.arguments[0]?.endpoint, fresh.endpoint);

    await push.flush();
    const again = new PushNotifier(dir);
    await again.load();
    assert.equal(again.status().publicKey, publicKey);
    assert.deepEqual(again.status().devices.map((d) => d.stale), [true, false], "staleness survives a restart");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a subscription made with a key replaced meanwhile is refused, overlapping rotations settle on one key, and a failed rotation keeps the old signer", async () => {
  const webpush = (await import("web-push")).default;
  const signerKey = () => String(webpush.generateRequestDetails({ endpoint: "https://push.example/x", keys: { p256dh: "k", auth: "a" } }, null).headers.Authorization).split("k=")[1];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "push-"));
  try {
    const push = new PushNotifier(dir);
    await push.load();
    const k0 = push.status().publicKey;
    await push.rotate();
    assert.throws(() => push.subscribe({ endpoint: "https://push.example/late", keys: { p256dh: "k", auth: "a" } }, "Phone", undefined, k0), PushKeyChanged);
    assert.equal(push.status().devices.length, 0);

    const [a, b] = await Promise.all([push.rotate(), push.rotate()]);
    assert.notEqual(a.publicKey, b.publicKey);
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, "push-vapid.json"), "utf8")).publicKey;
    assert.equal(onDisk, b.publicKey, "the last rotation wins on disk");
    assert.equal(push.status().publicKey, b.publicKey, "and in memory");
    assert.equal(signerKey(), b.publicKey, "and in the live signer");

    // The subscriptions are saved but the key file can't be: still the same key, on disk and live.
    await fs.mkdir(path.join(dir, "push-vapid.json.tmp"));
    await assert.rejects(push.rotate());
    assert.equal(push.status().publicKey, b.publicKey);
    assert.equal(signerKey(), b.publicKey);
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, "push-vapid.json"), "utf8")).publicKey, b.publicKey);
    await fs.rmdir(path.join(dir, "push-vapid.json.tmp"));

    await fs.chmod(dir, 0o500);
    try { await assert.rejects(push.rotate()); } finally { await fs.chmod(dir, 0o700); }
    assert.equal(push.status().publicKey, b.publicKey, "a rotation that couldn't be saved changes nothing");
    assert.equal(signerKey(), b.publicKey);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("old saved rules cannot re-enable elapsed-time or inactivity pushes", () => {
  const legacy = sanitizeRules({ kinds: { quiet: true, "long-turn": true, approval: true } })!;
  for (const r of [DEFAULT_PUSH_RULES, legacy]) {
    assert.equal(shouldPush(r, "quiet", new Date()), false);
    assert.equal(shouldPush(r, "long-turn", new Date()), false);
  }
});

test("muted threads and all subagent kinds cannot send push, including a mute during an approval read", async (t) => {
  const { threadNotificationsEnabled } = await import("../shared/thread-notifications.ts");
  const webpush = (await import("web-push")).default;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "push-mute-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let muted = false;
  let child = false;
  const push = new PushNotifier(dir, undefined, () => threadNotificationsEnabled(
    { mutedThreads: muted ? { "e:t": true } : {} }, "e",
    { id: "t", lineage: { relationshipToParent: child ? "subagent" : "fork" } } as never,
  ));
  await push.load();
  push.subscribe({ endpoint: "https://push.example/phone", keys: { p256dh: "k", auth: "a" } }, "Phone");
  const send = t.mock.method(webpush, "sendNotification", async () => ({}));
  const entry = { id: 1, at: Date.now(), tone: "alert" as const, kind: "approval" as const, text: "Approve", envId: "e", threadId: "t" };
  assert.equal(push.wants(entry), true);
  muted = true; // An approval read was in flight when another device muted this thread.
  await push.notify(entry);
  assert.equal(push.wants(entry), false);
  assert.equal(send.mock.callCount(), 0);
  muted = false;
  child = true;
  for (const kind of ["approval", "question", "failed", "spinning", "merged", "done"] as const) {
    push.setRules({ kinds: { ...DEFAULT_PUSH_RULES.kinds, done: true } });
    assert.equal(push.wants({ ...entry, kind }), false);
    await push.notify({ ...entry, kind });
  }
  assert.equal(send.mock.callCount(), 0);
  child = false; // Forks are ordinary threads and can notify after unmuting.
  await push.notify(entry);
  assert.equal(send.mock.callCount(), 1);
  await push.flush();
});
