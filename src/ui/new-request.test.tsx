import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectGroup } from "../game/layout";
import { machineChoices, projectOrder } from "./new-request";

const env = (id: string, connection = "live", threads: unknown[] = []) => ({ summary: { id, label: id }, connection, threads: Object.fromEntries((threads as Array<{ id: string }>).map((t) => [t.id, t])) });
const busy = (id: string) => ({ id, projectId: "p", updatedAt: "2026-10-14T10:00:00Z", latestTurn: { state: "running" } });
const group = (envs: ReturnType<typeof env>[], key = "g", name = "g"): ProjectGroup => ({ key, name, members: envs.map((e, index) => ({ env: e, project: { id: "p" }, index })) }) as unknown as ProjectGroup;
const host = (cpu: number) => ({ snapshot: { cpuUtilization: cpu, sampledAt: Date.now(), totalMemoryBytes: 1, availableMemoryBytes: 1 }, history: [] });

test("the suggested machine is reachable, its disk not filling, and the least busy, and it says why", () => {
  const g = group([env("busy", "live", [busy("t1"), busy("t2")]), env("quiet"), env("gone", "reconnecting")]);
  const choices = machineChoices(g, { busy: host(0.9), quiet: host(0.1), gone: host(0) } as never, {});
  assert.deepEqual(choices.map((c) => c.envId), ["quiet", "busy", "gone"]);
  assert.match(choices[0].reason, /10% CPU · nobody working here/);
  assert.equal(choices[2].reason, "unreachable");
  assert.equal(choices[2].ok, false);
});

test("projects: the last one used first, then the most recently active", () => {
  const recent = group([env("m", "live", [{ id: "t", projectId: "p", updatedAt: "2026-10-14T12:00:00Z" }])], "recent", "recent");
  const old = group([env("m", "live", [{ id: "t", projectId: "p", updatedAt: "2026-10-01T12:00:00Z" }])], "old", "old");
  assert.deepEqual(projectOrder([old, recent], undefined).map((g) => g.key), ["recent", "old"]);
  assert.deepEqual(projectOrder([old, recent], "old").map((g) => g.key), ["old", "recent"]);
});

test("routing levels: Prefer outranks a quieter Normal machine, Manual only is never auto-picked", () => {
  const g = group([env("a"), env("b"), env("c")]);
  const hosts = { a: host(0.3), b: host(0.2), c: host(0) } as never;
  const choices = machineChoices(g, hosts, {}, { a: "prefer", c: "manual" });
  assert.deepEqual(choices.map((c) => c.envId), ["a", "b", "c"]);
  assert.deepEqual(choices.map((c) => c.auto), [true, true, false]);
  assert.match(choices[0].reason, /preferred/);
  assert.match(choices[2].reason, /manual only/);
  assert.equal(choices[2].ok, true, "still yours to pick by hand");
  assert.deepEqual(machineChoices(g, hosts, {}, { b: "less" }).map((c) => c.envId), ["c", "a", "b"]);
});

test("a machine's load counts as measured only once its CPU is known", () => {
  const choices = machineChoices(group([env("a"), env("b")]), { a: host(0.5) } as never, {});
  assert.deepEqual(Object.fromEntries(choices.map((c) => [c.envId, c.measured])), { a: true, b: false });
});
