import assert from "node:assert/strict";
import test from "node:test";
import { EnvironmentClient } from "./environment";
import { useGame } from "../store";
import type { EnvSummary } from "../../shared/api";
import { v2ThreadStream } from "../../shared/t3-protocol";

const summary = { id: "env", label: "Test", protocolVersion: 2 } as EnvSummary;
const shell = { id: "th", projectId: "p", title: "Large thread", status: "running", latestRunId: "run", createdAt: "2026-10-26", updatedAt: "2026-10-26" };
const item = (text: string, id = "message") => ({ id, messageId: id, threadId: "th", runId: "run", type: "assistant_message", text,
  startedAt: "2026-10-26T12:00:00Z", updatedAt: text === "live" ? "2026-10-26T12:01:00Z" : "2026-10-26T12:00:00Z" });
const visible = (text: string, id = "message") => ({ sourceThreadId: "th", sourceItemId: id, visibility: "local", item: item(text, id) });
const snapshot = () => ({ snapshotSequence: 10, projection: { thread: shell, runs: [{ id: "run", ordinal: 1, status: "running" }],
  turnItems: [], visibleTurnItems: [visible("initial")] }, turnItemsOmitLocalVisible: true, historyCursor: "opaque+cursor", hasMoreHistory: true });
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const before = useGame.getState();
  useGame.setState({ envs: { env: { summary, connection: "live", synced: true, projects: {}, threads: {}, providers: [] } }, details: {} });
  const client = new EnvironmentClient(summary);
  const streams: Array<{ payload: Record<string, unknown>; emit(items: unknown[]): void; cancelled: boolean }> = [];
  Object.defineProperty(client, "rpc", { value: { isOpen: true,
    rawStream: (_tag: string, payload: Record<string, unknown>, emit: (items: unknown[]) => void) => {
      const stream = { payload, emit, cancelled: false }; streams.push(stream);
      return () => { stream.cancelled = true; };
    },
  } });
  return { client, streams, restore: () => useGame.setState(before, true) };
}

test("compact bounded snapshots seed live decoding and older pages preserve newer live values and cursor", () => {
  const decode = v2ThreadStream();
  let decoded = decode([{ kind: "snapshot", ...snapshot() }, { kind: "synchronized" }]);
  assert.equal(decoded[0].kind === "snapshot" && decoded[0].snapshot.thread.messages[0].text, "initial");
  // Snapshot overlaps and unknown event kinds cannot undo live changes.
  decode([{ kind: "event", sequence: 11, event: { type: "turn-item.updated", payload: item("live") } }]);
  decoded = decode([{ kind: "history-page", snapshotSequence: 1, items: [visible("older", "old"), visible("stale")], nextCursor: null, hasMoreHistory: false }]);
  assert.equal(decoded[0].kind, "snapshot");
  if (decoded[0].kind !== "snapshot") return;
  assert.equal(decoded[0].snapshot.snapshotSequence, 11, "history paging cannot rewind the live cursor");
  assert.equal(decoded[0].snapshot.thread.messages.find((m) => m.id === "message")?.text, "live");
  assert.equal(decoded[0].snapshot.thread.messages.filter((m) => m.id === "message").length, 1);
  assert.equal(decoded[0].snapshot.thread.messages.find((m) => m.id === "old")?.text, "older");
  assert.deepEqual(decoded[0].snapshot.history, { cursor: null, hasMore: false });
});

test("chat opens by HTTP before subscribing from its cursor; paging never reloads the socket", async () => {
  const originalFetch = globalThis.fetch;
  const { client, streams, restore } = setup();
  let finish!: (value: Response) => void;
  const reads: string[] = [];
  globalThis.fetch = async (url) => {
    reads.push(String(url));
    if (String(url).includes("/history?")) return new Promise((r) => { finish = r; });
    return new Response(JSON.stringify(snapshot()));
  };
  const release = client.watchThread("th");
  try {
    assert.equal(streams.length, 0, "an unseeded decoder must not request a full thread snapshot");
    await flush();
    assert.equal(streams.length, 1);
    assert.equal(streams[0].payload.afterSequence, 10);
    assert.equal(streams[0].payload.acceptBoundedSnapshot, true);
    streams[0].emit([{ kind: "synchronized" }]);
    const pending = client.loadOlderHistory("th");
    await client.loadOlderHistory("th");
    assert.equal(reads.filter((p) => p.includes("/history?")).length, 1, "history requests never overlap");
    streams[0].emit([{ kind: "event", sequence: 11, event: { type: "turn-item.updated", payload: item("live") } }]);
    finish(new Response(JSON.stringify({ snapshotSequence: 10, items: [visible("old", "old")], nextCursor: null, hasMoreHistory: false })));
    await pending;
    assert.equal(streams.length, 1);
    assert.equal(useGame.getState().details["env:th"].thread.messages.find((m) => m.id === "message")?.text, "live");
    assert.equal(useGame.getState().details["env:th"].history?.hasMore, false);
    assert.match(reads[1], /cursor=opaque%2Bcursor/);
  } finally { release(); restore(); globalThis.fetch = originalFetch; }
});

test("closing during bootstrap aborts it; failed bounded reads stay local and never fall back to a full socket snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const { client, streams, restore } = setup();
  let finish!: (value: Response) => void;
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = async (_url, init) => { signal = init?.signal; return new Promise((r) => { finish = r; }); };
  try {
    const close = client.watchThread("th");
    close();
    assert.equal(signal?.aborted, true);
    finish(new Response(JSON.stringify(snapshot())));
    await flush();
    assert.equal(streams.length, 0);
    assert.equal(useGame.getState().details["env:th"], undefined);
    // Give the loader a visible shell for its recoverable error state.
    useGame.setState((s) => ({ envs: { ...s.envs, env: { ...s.envs.env, threads: { th: shell as never } } } }));
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "Bounded snapshot unavailable" }), { status: 404 });
    const release = client.watchThread("th");
    await flush();
    assert.equal(streams.length, 0);
    assert.equal(useGame.getState().details["env:th"].error, "Bounded snapshot unavailable");
    release();
  } finally { restore(); globalThis.fetch = originalFetch; }
});

test("a replacement snapshot releases an obsolete page load and ignores its late response", async () => {
  const originalFetch = globalThis.fetch;
  const { client, streams, restore } = setup();
  let finish!: (value: Response) => void;
  globalThis.fetch = async (url) => String(url).includes("/history?")
    ? new Promise((r) => { finish = r; }) : new Response(JSON.stringify(snapshot()));
  const release = client.watchThread("th");
  try {
    await flush();
    const loading = client.loadOlderHistory("th");
    assert.equal(useGame.getState().details["env:th"].history?.loading, true);
    streams[0].emit([{ kind: "snapshot", ...snapshot(), snapshotSequence: 50, historyCursor: "replacement-cursor" }]);
    assert.equal(useGame.getState().details["env:th"].history?.loading, false);
    finish(new Response(JSON.stringify({ snapshotSequence: 10, items: [visible("obsolete", "old")], nextCursor: null, hasMoreHistory: false })));
    await loading;
    assert.equal(useGame.getState().details["env:th"].history?.cursor, "replacement-cursor");
    assert.ok(!useGame.getState().details["env:th"].thread.messages.some((m) => m.id === "old"));
  } finally { release(); restore(); globalThis.fetch = originalFetch; }
});
