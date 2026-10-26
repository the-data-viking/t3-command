import assert from "node:assert/strict";
import test from "node:test";
import { SubagentRelay } from "./subagent-relay.ts";

test("background lifecycle streams omit transcript payloads and still preserve chunk flow control", () => {
  const relay = new SubagentRelay();
  const request = relay.request({ _tag: "Request", id: "native", tag: "orchestration.subscribeThread", payload: {
    threadId: "parent", afterSequence: 7, acceptBoundedSnapshot: true, commandSubagentsOnly: true,
  } });
  assert.deepEqual(request.payload, { threadId: "parent", afterSequence: 7, acceptBoundedSnapshot: true });
  const agent = { id: "a", threadId: "parent", origin: "provider_native", childThreadId: "child", status: "running", prompt: "private prompt", result: "large tool result" };
  const response = relay.response({ _tag: "Chunk", requestId: "native", values: [
    { kind: "snapshot", snapshotSequence: 9, projection: { thread: { id: "parent", title: "parent" }, messages: [{ text: "conversation" }], turnItems: [{ output: "large" }], subagents: [agent] } },
    { kind: "event", sequence: 10, event: { type: "message.updated", payload: { text: "transcript" } } },
    { kind: "event", sequence: 11, event: { type: "subagent.updated", payload: agent } },
    { kind: "synchronized" },
  ] });
  const raw = JSON.stringify(response);
  for (const excluded of ["private prompt", "large tool result", "conversation", "transcript", "turnItems"]) assert.ok(!raw.includes(excluded));
  assert.match(raw, /running/);
  assert.match(raw, /synchronized/);
  assert.deepEqual(relay.response({ _tag: "Chunk", requestId: "native", values: [{ kind: "event", event: { type: "message.updated" } }] }),
    { _tag: "Chunk", requestId: "native", values: [] }, "even filtered chunks must be acknowledged");
  const normal = { _tag: "Chunk", requestId: "visible-chat", values: [{ kind: "event", event: { type: "message.updated", payload: { text: "keep" } } }] };
  assert.equal(relay.response(normal), normal, "visible chat streams are unaffected");
  relay.request({ _tag: "Interrupt", requestId: "native" });
  const reuse = { ...normal, requestId: "native" };
  assert.equal(relay.response(reuse), reuse);
});
