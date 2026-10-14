import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CommsLog } from "./comms.ts";
import { Decisions } from "./decide.ts";
import { notificationFor } from "./push.ts";

const thread = (detail: string) => ({ id: "t", activities: [
  { id: "a1", kind: "approval.requested", tone: "approval", summary: "Run command", turnId: "u", createdAt: "", payload: { requestId: "r1", requestKind: "command", detail } },
] }) as never;

async function setup(detail: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "decide-"));
  const comms = new CommsLog(dir);
  const sent: unknown[] = [];
  const decisions = new Decisions(async () => [{ kind: "snapshot", snapshot: { thread: thread(detail) } }], async (_env, tag, payload) => { sent.push({ tag, payload }); }, comms);
  return { dir, comms, sent, decisions };
}

test("an unflagged approval can be decided from its notification, once, and it's logged", async () => {
  const { dir, comms, sent, decisions } = await setup("pnpm test");
  try {
    const d = await decisions.prepare("e", "t", "Fix CI");
    assert.equal(d?.requestId, "r1");
    assert.equal(d?.what, "pnpm test");
    assert.ok(d?.token);
    await assert.rejects(decisions.decide(d!.token!, "acceptForSession"), /Only approve or deny/);
    const fresh = await decisions.prepare("e", "t", "Fix CI");
    const out = await decisions.decide(fresh!.token!, "accept");
    assert.deepEqual(out, { title: "Fix CI", what: "pnpm test" });
    assert.equal((sent[0] as { payload: { type: string; requestId: string; decision: string } }).payload.type, "thread.approval.respond");
    assert.equal((sent[0] as { payload: { decision: string } }).payload.decision, "accept");
    await assert.rejects(decisions.decide(fresh!.token!, "accept"), /expired/, "single use");
    assert.ok(comms.since().some((e) => e.text === "Approved from a notification for \"Fix CI\": pnpm test"));
    const late = await decisions.prepare("e", "t", "Fix CI", Date.now() - 31 * 60_000);
    await assert.rejects(decisions.decide(late!.token!, "decline"), /expired/);
    await comms.flush();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a flagged approval is described with its risk but never gets a token: it opens the app", async () => {
  const { dir, decisions } = await setup("rm -rf /var/data");
  try {
    const d = await decisions.prepare("e", "t", "Clean up");
    assert.equal(d?.token, undefined);
    assert.equal(d?.risk?.level, "danger");
    const n = notificationFor({ id: 1, at: 0, tone: "alert", kind: "approval", text: "\"Clean up\" needs your approval", envId: "e", threadId: "t" }, "Box", d);
    assert.match(n.body, /▲ rm -rf \/var\/data · Danger: /);
    assert.equal(n.actions, undefined);
    const ok = notificationFor({ id: 2, at: 0, tone: "alert", kind: "approval", text: "x", envId: "e", threadId: "t" }, "Box", { requestId: "r", what: "pnpm test", token: "tok" });
    assert.deepEqual(ok.actions?.map((a) => a.action), ["accept", "decline"]);
    assert.equal(ok.token, "tok");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
