import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PUSH_RULES, inQuietHours, sanitizeRules, shouldPush, type PushRules } from "../shared/push.ts";
import { quietSince, QUIET_MS } from "./long-turns.ts";
import { notificationFor } from "./push.ts";
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
