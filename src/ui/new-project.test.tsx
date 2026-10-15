import assert from "node:assert/strict";
import test from "node:test";
import type { EnvWorld } from "../store";
import type { ProjectClone } from "../t3/types";
import { cleanFolderName, cloneStatus, defaultParent, folderName, joinPath, repoName } from "./new-project";

test("a clone URL names its folder", () => {
  assert.equal(repoName("https://github.com/pingdotgg/t3code.git"), "t3code");
  assert.equal(repoName("https://github.com/pingdotgg/t3code/"), "t3code");
  assert.equal(repoName("git@github.com:njord/t3-command.git"), "t3-command");
  assert.equal(repoName("ssh://git@host.example/team/tool.git"), "tool");
  assert.equal(repoName("owner/repo"), "repo");
  assert.equal(repoName(""), "");
});

test("paths join and split on one slash", () => {
  assert.equal(joinPath("~/code/", "app"), "~/code/app");
  assert.equal(joinPath("~", "app"), "~/app");
  assert.equal(folderName("/Users/me/code/app/"), "app");
  assert.equal(cleanFolderName(" ../my/app "), "-my-app");
});

test("new projects go where most of the machine's projects already are", () => {
  const env = (roots: string[]) => ({
    projects: Object.fromEntries(roots.map((r, i) => [String(i), { id: String(i), title: folderName(r), workspaceRoot: r }])),
  }) as unknown as EnvWorld;
  assert.equal(defaultParent(env(["/u/GitHub/a", "/u/GitHub/b", "/u/other/c", "/u/.t3/scratch"])), "/u/GitHub");
  assert.equal(defaultParent(env([])), "~");
  assert.equal(defaultParent(undefined), "~");
});

test("clone progress reads as one line", () => {
  const base: ProjectClone = { projectId: "p", remoteUrl: "u", destinationPath: "d", phase: "running", stage: "receiving",
    percent: 42, detail: "12.3 MiB | 4.5 MiB/s", error: null, startedAt: "", endedAt: null };
  assert.equal(cloneStatus(base), "Receiving objects · 42% · 12.3 MiB | 4.5 MiB/s");
  assert.equal(cloneStatus({ ...base, stage: "connecting", percent: null, detail: null }), "Connecting");
  assert.equal(cloneStatus({ ...base, phase: "failed", error: "Repository not found." }), "Clone failed: Repository not found.");
  assert.equal(cloneStatus({ ...base, phase: "done" }), "Cloned");
});
