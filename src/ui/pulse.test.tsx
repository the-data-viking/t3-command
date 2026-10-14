import assert from "node:assert/strict";
import test from "node:test";
import { pulseOf, pulseText } from "./pulse";

const T0 = Date.parse("2026-10-14T10:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const tool = (id: string, min: number, payload: Record<string, unknown>) => ({ id, kind: "tool.completed", tone: "tool", summary: String(payload.detail ?? ""), turnId: "t1", createdAt: at(min), payload: { toolCallId: id, ...payload } });
const thread = (activities: unknown[], state = "running") => ({ latestTurn: { turnId: "t1", state, startedAt: at(0), requestedAt: at(0) }, activities }) as never;

test("a turn's pulse: last file change, tests, a command failing again and again, and a long stretch with no changes", () => {
  const busy = thread([
    tool("e1", 5, { itemType: "file_change", status: "completed" }),
    tool("c1", 6, { detail: "npm test", status: "failed" }), tool("c2", 8, { detail: "npm test", status: "failed" }), tool("c3", 9, { detail: "npm test", exitCode: 1 }),
  ]);
  const p = pulseOf(busy, T0 + 12 * 60_000)!;
  assert.equal(p.lastChangeAt, T0 + 5 * 60_000);
  assert.deepEqual(p.repeatFail, { command: "npm test", count: 3 });
  assert.equal(p.noChangeMs, undefined);
  assert.match(pulseText(p, T0 + 12 * 60_000), /^⚠ npm test failed 3× this turn · files changed 7m.* ago · tests ✕$/);
  const still = pulseOf(thread([tool("e1", 5, { itemType: "file_change", status: "completed" })]), T0 + 80 * 60_000)!;
  assert.equal(still.noChangeMs, 75 * 60_000, "running 75 minutes past its last change");
  assert.equal(pulseOf(thread([], "completed"), T0 + 200 * 60_000)!.noChangeMs, undefined, "a finished turn isn't 'not changing'");
});

test("different heredoc scripts that each fail once aren't one command failing again and again", () => {
  const script = (id: string, body: string) => tool(id, 6, { detail: `python3 - <<'PY'\n${body}\nPY`, status: "failed" });
  const varied = pulseOf(thread([script("h1", "print(1)"), script("h2", "print(2)"), script("h3", "print(3)")]), T0 + 12 * 60_000)!;
  assert.equal(varied.repeatFail, undefined);
  const same = pulseOf(thread([script("s1", "x()"), script("s2", "x()"), script("s3", "x()")]), T0 + 12 * 60_000)!;
  assert.deepEqual(same.repeatFail, { command: "python3 - <<'PY'", count: 3 });
});

test("edits made through the shell count as file changes", async () => {
  const { writesFiles } = await import("./pulse");
  for (const cmd of [`/bin/zsh -lc "sed -i '' 's/a/b/' x.ts"`, `bash -c "python3 - <<'EOF'"`, "cat > notes.md", "echo hi >> log.txt", "git commit -m wip", "cp a b"]) assert.ok(writesFiles(cmd), cmd);
  for (const cmd of ["npm test", "git status --short", "grep -n foo src/x.ts", "ls -la", "npx tsc -b 2>&1 | head", "node a.js 2>&1"]) assert.ok(!writesFiles(cmd), cmd);
  const edited = pulseOf(thread([tool("s1", 70, { itemType: "command_execution", status: "completed", exitCode: 0, detail: "sed -i '' 's/a/b/' x.ts" })]), T0 + 80 * 60_000)!;
  assert.equal(edited.lastChangeAt, T0 + 70 * 60_000);
  assert.equal(edited.noChangeMs, undefined);
});

test("a repeated command reads as typed, without the shell wrapper agents run it in", async () => {
  const { bareCommand } = await import("./pulse");
  assert.equal(bareCommand(`/bin/bash -lc "python3 check.py --all"`), "python3 check.py --all");
  assert.equal(bareCommand(`/bin/zsh -lc 'npm test'`), "npm test");
  assert.equal(bareCommand(`bash -c "python3 - <<'PY'`), "python3 - <<'PY'");
  assert.equal(bareCommand("npm test"), "npm test");
});
