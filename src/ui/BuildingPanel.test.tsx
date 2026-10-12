import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { EnvSummary } from "../../shared/api";
import { updateEnv, useGame } from "../store";
import { EnvironmentClient, refreshEnvironments } from "../t3/environment";
import type { VcsLocalStatus, VcsStatusEvent } from "../t3/types";
import { BuildingPanel } from "./BuildingPanel";

test("project updates keep one git block and subscription; switching projects and closing clean up", async (t) => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const restoreGlobals: Array<() => void> = [];
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    restoreGlobals.push(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const summary: EnvSummary = { id: "panel-test", kind: "t3", label: "Station", url: "http://t3",
    status: "ok", addedAt: "2026-10-12T00:00:00Z" };
  const project = (id: string) => ({ id, title: id, workspaceRoot: `/repos/${id}`,
    defaultModelSelection: null, createdAt: summary.addedAt, updatedAt: summary.addedAt });
  let summaries = [summary];
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(summaries)));
  t.mock.method(EnvironmentClient.prototype, "start", function (this: EnvironmentClient) {
    useGame.setState({ envs: { [this.id]: { summary, connection: "live", synced: true,
      projects: { one: project("one"), two: project("two") }, threads: {}, providers: [] } } });
  });
  const status = (refName: string): VcsLocalStatus => ({ isRepo: true, refName, isDefaultRef: false,
    hasWorkingTreeChanges: true, workingTree: { files: [{ path: "src/a.ts", insertions: 2, deletions: 1 }], insertions: 2, deletions: 1 } });
  const watches: Array<{ cwd: string; emit: (event: VcsStatusEvent) => void; active: boolean }> = [];
  t.mock.method(EnvironmentClient.prototype, "watchVcs", (cwd: string, onEvent: (event: VcsStatusEvent) => void) => {
    const watch = { cwd, emit: onEvent, active: true };
    watches.push(watch);
    onEvent({ _tag: "snapshot", local: status("feature/one"), remote: null });
    return () => { watch.active = false; };
  });
  await refreshEnvironments();
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  t.after(async () => {
    await act(() => root.unmount());
    summaries = [];
    await refreshEnvironments();
    dom.window.close();
    restoreGlobals.forEach((restore) => restore());
  });
  await act(() => root.render(<BuildingPanel envId={summary.id} projectId="one" />));
  for (let i = 0; i < 12; i++) {
    // Shell/config/usage events replace the environment while the panel stays open.
    await act(() => updateEnv(summary.id, (env) => ({ ...env, projects: {
      ...env.projects, one: { ...env.projects.one, updatedAt: String(i) },
    } })));
    assert.equal(container.querySelectorAll(".git-status").length, 1, `update ${i} must not append a block`);
    assert.equal(watches.length, 1, "normal updates must keep the existing subscription");
  }
  await act(() => updateEnv(summary.id, (env) => ({ ...env, providers: [{
    instanceId: "codex", driver: "codex", enabled: true, installed: true, status: "ready",
    models: [{ slug: "model", name: "Model" }],
  }] })));
  assert.equal(container.querySelectorAll(".recruit").length, 1, "the form appears when providers become ready");
  assert.equal(container.querySelectorAll(".git-status").length, 1);
  assert.equal(watches.length, 1);
  await act(() => watches[0].emit({ _tag: "localUpdated", local: status("fix/new-branch") }));
  assert.match(container.querySelector(".git-status")!.textContent!, /fix\/new-branch/);
  assert.match(container.querySelector(".git-status")!.textContent!, /src\/a.ts/);
  await act(() => watches[0].emit({ _tag: "localUpdated", local: { ...status("fix/new-branch"),
    hasWorkingTreeChanges: false, workingTree: { files: [], insertions: 0, deletions: 0 } } }));
  assert.match(container.querySelector(".git-status")!.textContent!, /clean/);
  assert.equal(container.querySelectorAll(".turn-files li").length, 0);
  await act(() => root.render(<BuildingPanel envId={summary.id} projectId="two" />));
  assert.equal(container.querySelectorAll(".git-status").length, 1);
  assert.deepEqual(watches.map((watch) => [watch.cwd, watch.active]), [["/repos/one", false], ["/repos/two", true]]);
  await act(() => root.render(null));
  assert.equal(container.querySelectorAll(".git-status").length, 0);
  assert.ok(watches.every((watch) => !watch.active), "closing the panel cancels all subscriptions");
});
