import assert from "node:assert/strict";
import test from "node:test";
import type { EnvSummary } from "../../shared/api";
import { useGame } from "../store";
import { EnvironmentClient } from "./environment";
import type { ProjectShell, ThreadShell } from "./types";
import { latestWorktree, type RecruitWorkspace, type VcsRef } from "./workspace";

const refs: VcsRef[] = [
  { name: "feature", current: true, isDefault: false, worktreePath: "/repo" },
  { name: "main", current: false, isDefault: true, worktreePath: null },
  { name: "fix/one", current: false, isDefault: false, worktreePath: "/worktrees/one" },
  { name: "fix/two", current: false, isDefault: false, worktreePath: "/worktrees/two" },
];
const thread = (overrides: Partial<ThreadShell> = {}): ThreadShell => ({
  id: "thread", projectId: "project", branch: "fix/one", worktreePath: "/worktrees/one", archivedAt: null,
  updatedAt: "2026-10-11T12:00:00Z", ...overrides,
} as ThreadShell);

function setup(kind: "t3" | "hermes" = "t3", failSwitch = false) {
  const summary = { id: "workspace-test", label: "Station", kind } as EnvSummary;
  useGame.setState({ envs: { [summary.id]: {
    summary, connection: "live", synced: true, providers: [],
    projects: { project: { id: "project", workspaceRoot: "/repo" } as ProjectShell },
    threads: { one: thread(), two: thread({ id: "two", branch: "fix/two", worktreePath: "/worktrees/two", updatedAt: "2026-10-11T13:00:00Z" }) },
  } } });
  const client = new EnvironmentClient(summary);
  const calls: Array<{ tag: string; payload: Record<string, unknown> }> = [];
  Object.defineProperty(client, "rpc", { value: { isOpen: true,
    request: async (tag: string, payload: Record<string, unknown>) => {
      calls.push({ tag, payload });
      if (tag === "vcs.listRefs") return { refs, isRepo: true, nextCursor: null };
      if (tag === "vcs.switchRef") {
        if (failSwitch) throw new Error("Local changes would be overwritten");
        return { refName: payload.refName };
      }
      return { sequence: 1 };
    },
  } });
  const recruit = (workspace: RecruitWorkspace) => client.recruit({ projectId: "project", text: "Fix the issue",
    modelSelection: { instanceId: "codex", model: "model" }, runtimeMode: "full-access", workspace });
  const bootstrap = () => calls.find((c) => c.tag === "orchestration.dispatchCommand")!.payload.bootstrap as {
    createThread: { branch: string | null; worktreePath: string | null };
    prepareWorktree?: Record<string, unknown>; runSetupScript?: boolean;
  };
  return { client, calls, recruit, bootstrap };
}

test("latest worktree follows T3's updatedAt ordering and excludes archived, other projects, and root checkout", () => {
  const expected = thread({ updatedAt: "2026-10-11T13:00:00Z" });
  assert.equal(latestWorktree([thread(), expected,
    thread({ archivedAt: "2026-10-11", updatedAt: "2026-10-12" }),
    thread({ projectId: "other", updatedAt: "2026-10-12" }),
    thread({ worktreePath: "/repo", updatedAt: "2026-10-12" }),
    thread({ updatedAt: "invalid" }),
  ], "project", "/repo"), expected);
});

test("recruiting in current checkout retains its branch without switching refs", async () => {
  const s = setup();
  await s.recruit({ mode: "local" });
  assert.deepEqual(s.bootstrap().createThread.branch, "feature");
  assert.equal(s.bootstrap().createThread.worktreePath, null);
  assert.equal(s.bootstrap().prepareWorktree, undefined);
  assert.equal(s.calls.some((c) => c.tag === "vcs.switchRef"), false);
});

test("choosing main switches the shared checkout before the first turn; failed switches never start a worker", async () => {
  const s = setup();
  await s.recruit({ mode: "local", branch: "main" });
  assert.deepEqual(s.calls.map((c) => c.tag), ["vcs.listRefs", "vcs.switchRef", "orchestration.dispatchCommand"]);
  assert.equal(s.bootstrap().createThread.branch, "main");
  const failing = setup("t3", true);
  await assert.rejects(failing.recruit({ mode: "local", branch: "main" }), /Local changes/);
  assert.equal(failing.calls.some((c) => c.tag === "orchestration.dispatchCommand"), false);
});

test("latest and explicitly chosen worktrees use their live ref and path without creating or switching worktrees", async () => {
  for (const workspace of [{ mode: "latest" }, { mode: "existing", path: "/worktrees/one" }] as RecruitWorkspace[]) {
    const s = setup();
    await s.recruit(workspace);
    assert.equal(s.bootstrap().createThread.worktreePath, workspace.mode === "latest" ? "/worktrees/two" : "/worktrees/one");
    assert.equal(s.bootstrap().createThread.branch, workspace.mode === "latest" ? "fix/two" : "fix/one");
    assert.equal(s.bootstrap().prepareWorktree, undefined);
    assert.deepEqual(s.calls.map((c) => c.tag), ["vcs.listRefs", "orchestration.dispatchCommand"]);
  }
});

test("new worktrees use native required-worktree bootstrap with a unique branch, origin option, and setup scripts", async () => {
  const s = setup();
  await s.recruit({ mode: "worktree", branch: "main", startFromOrigin: false });
  const bootstrap = s.bootstrap();
  assert.equal(bootstrap.createThread.branch, "main");
  assert.equal(bootstrap.createThread.worktreePath, null);
  assert.equal(bootstrap.prepareWorktree?.projectCwd, "/repo");
  assert.equal(bootstrap.prepareWorktree?.baseBranch, "main");
  assert.equal(bootstrap.prepareWorktree?.requireWorktree, true);
  assert.equal(bootstrap.prepareWorktree?.startFromOrigin, false);
  assert.match(String(bootstrap.prepareWorktree?.branch), /^t3code-[0-9a-f]{8}$/);
  assert.equal(bootstrap.runSetupScript, true);
  const defaultBase = setup();
  await defaultBase.recruit({ mode: "worktree" });
  assert.equal(defaultBase.bootstrap().prepareWorktree?.baseBranch, "feature");
  assert.equal(defaultBase.bootstrap().prepareWorktree?.startFromOrigin, true);
  assert.notEqual(defaultBase.bootstrap().prepareWorktree?.branch, bootstrap.prepareWorktree?.branch);
});

test("stale worktrees and branches reject instead of falling back to the main checkout", async () => {
  for (const workspace of [{ mode: "existing", path: "/deleted" }, { mode: "worktree", branch: "deleted" },
    { mode: "local", branch: "fix/one" }] as RecruitWorkspace[]) {
    const s = setup();
    await assert.rejects(s.recruit(workspace));
    assert.equal(s.calls.some((c) => c.tag === "orchestration.dispatchCommand"), false);
  }
});

test("Hermes keeps its configured checkout and rejects unsupported worktree requests", async () => {
  const s = setup("hermes");
  await s.recruit({ mode: "local" });
  assert.deepEqual(s.calls.map((c) => c.tag), ["orchestration.dispatchCommand"]);
  await assert.rejects(s.recruit({ mode: "worktree" }), /only its configured workspace/);
});

test("project refs paginate on the correct host and preserve worktrees from later pages", async () => {
  const s = setup();
  const cursors: unknown[] = [];
  Object.defineProperty(s.client, "rpc", { value: { isOpen: true, request: async (_tag: string, payload: Record<string, unknown>) => {
    assert.equal(payload.cwd, "/repo");
    cursors.push(payload.cursor);
    return { refs: payload.cursor === 0 ? refs.slice(0, 2) : refs.slice(2), isRepo: true, nextCursor: payload.cursor === 0 ? 2 : null };
  } }, configurable: true });
  assert.deepEqual((await s.client.projectRefs("project")).refs, refs);
  assert.deepEqual(cursors, [0, 2]);
});
