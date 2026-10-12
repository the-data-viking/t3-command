import assert from "node:assert/strict";
import test from "node:test";
import type { EnvSummary } from "../../shared/api";
import { useGame } from "../store";
import { EnvironmentClient } from "./environment";
import { RpcError } from "./rpc";
import type { Provider } from "./types";

type Stream = { tag: string; payload: unknown; onItems: (items: unknown[]) => void; onEnd: (err?: RpcError) => void };

function setup() {
  const summary = { id: "mission-test", label: "Station", kind: "t3" } as EnvSummary;
  useGame.setState({ envs: { [summary.id]: { summary, connection: "live", synced: true, providers: [], projects: {}, threads: {} } } });
  const client = new EnvironmentClient(summary);
  const calls: Array<{ tag: string; payload: Record<string, unknown> }> = [];
  const streams: Stream[] = [];
  const rpc = { isOpen: true,
    request: async (tag: string, payload: Record<string, unknown>) => {
      calls.push({ tag, payload });
      if (tag === "orchestration.getTurnDiff") return { diff: "diff --git a/x b/x" };
      if (tag === "server.getConfig") return { providers: [{ instanceId: "hermes" }] };
      return { sequence: 1 };
    },
    stream: (tag: string, payload: unknown, onItems: Stream["onItems"], onEnd: Stream["onEnd"]) => {
      streams.push({ tag, payload, onItems, onEnd });
      return () => {};
    },
  };
  Object.defineProperty(client, "rpc", { value: rpc });
  const providers = () => useGame.getState().envs[summary.id].providers;
  return { client, calls, streams, providers };
}

test("rolling back dispatches T3's checkpoint revert for exactly the chosen turn", async () => {
  const s = setup();
  await s.client.rollBackToTurn("thread-1", 3);
  const command = s.calls.find((c) => c.tag === "orchestration.dispatchCommand")!.payload;
  assert.equal(command.type, "thread.checkpoint.revert", "files and conversation, not conversation-only");
  assert.equal(command.threadId, "thread-1");
  assert.equal(command.turnCount, 3);
  assert.equal(typeof command.commandId, "string");
});

test("a turn's diff covers only that turn", async () => {
  const s = setup();
  assert.equal(await s.client.turnDiff("thread-1", 4, 5), "diff --git a/x b/x");
  assert.deepEqual(s.calls[0], { tag: "orchestration.getTurnDiff", payload: { threadId: "thread-1", fromTurnCount: 4, toTurnCount: 5 } });
});

test("provider status follows the config stream, and servers without it fall back to one fetch", async () => {
  const s = setup();
  (s.client as unknown as { loadConfig(): void }).loadConfig();
  const stream = s.streams.find((x) => x.tag === "subscribeServerConfig")!;
  const codex = (usedPercent: number) => ({ instanceId: "codex", usageLimits: { checkedAt: "", windows: [{ id: "w", kind: "weekly", label: "Weekly", usedPercent }] } }) as unknown as Provider;
  stream.onItems([{ version: 1, type: "snapshot", config: { providers: [codex(10)] } }]);
  assert.equal(s.providers()[0].usageLimits?.windows[0].usedPercent, 10);
  stream.onItems([{ version: 1, type: "keybindingsUpdated", payload: {} }, { version: 1, type: "providerStatuses", payload: { providers: [codex(42)] } }]);
  assert.equal(s.providers()[0].usageLimits?.windows[0].usedPercent, 42);
  // The Hermes bridge (and older servers) reject the stream: fetch config once instead.
  stream.onEnd(new RpcError("HermesError", "Unknown request tag: subscribeServerConfig"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(s.calls.some((c) => c.tag === "server.getConfig"));
  assert.equal(s.providers()[0].instanceId, "hermes");
});

test("watching git status streams the workspace and reports stream failures", () => {
  const s = setup();
  const events: unknown[] = [];
  const errors: string[] = [];
  s.client.watchVcs("/repo", (e) => events.push(e), (m) => errors.push(m));
  const stream = s.streams.find((x) => x.tag === "subscribeVcsStatus")!;
  assert.deepEqual(stream.payload, { cwd: "/repo" });
  // T3 hands new subscribers its cached status, so a fresh one is requested too.
  assert.deepEqual(s.calls.find((c) => c.tag === "vcs.refreshStatus")?.payload, { cwd: "/repo" });
  stream.onItems([{ _tag: "snapshot", local: { isRepo: true }, remote: null }]);
  stream.onEnd(new RpcError("Disconnected", "gone"));
  stream.onEnd(new RpcError("VcsError", "not a repository"));
  assert.equal(events.length, 1);
  assert.deepEqual(errors, ["not a repository"], "disconnects are handled by reconnecting, not reported");
});
