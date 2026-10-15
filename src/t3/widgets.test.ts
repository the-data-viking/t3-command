import assert from "node:assert/strict";
import test from "node:test";
import type { EnvWorld } from "../store";
import type { ThreadShell } from "./types";
import { DEFAULT_SIZE, WIDGET_CSP, dataUpdatedAt, isStale, pinSize, widgetDocument, widgetMeta, widgetWorkspaces, workspaceThreads } from "./widgets";

test("a page names and sizes itself through its title and meta tags", () => {
  const html = `<!doctype html><html><head><title> Synthbench &amp; runs </title>
    <meta name="t3-widget-size" content="420x260"><meta content="120" name="t3-widget-stale-after"></head><body></body></html>`;
  assert.deepEqual(widgetMeta(html), { title: "Synthbench & runs", size: { w: 420, h: 260 }, staleAfter: 120 });
  assert.deepEqual(widgetMeta("<p>hi</p>"), {});
  assert.deepEqual(widgetMeta(`<meta name="t3-widget-size" content="huge">`), {});
  assert.deepEqual(pinSize({}), DEFAULT_SIZE);
});

test("the policy and t3widget API go ahead of the page, after any doctype", () => {
  const withHead = widgetDocument(`<!doctype html><html><head lang="en"><script>early()</script></head></html>`, { n: 1 }, undefined);
  assert.ok(withHead.startsWith(`<!doctype html><html><head lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}">`));
  assert.ok(withHead.indexOf("window.t3widget") < withHead.indexOf("early()"));
  const doctypeOnly = widgetDocument(`<!DOCTYPE html><body>x</body>`, undefined, undefined);
  assert.ok(doctypeOnly.startsWith(`<!DOCTYPE html><meta charset="utf-8">`));
  assert.ok(widgetDocument(`<p>bare</p>`, null, undefined).startsWith(`<meta charset="utf-8">`));
  assert.match(WIDGET_CSP, /connect-src 'none'/);
});

test("data embedded in the page can't close its script", () => {
  const doc = widgetDocument("<p></p>", { note: "</script><script>alert(1)</script>" }, "2026-10-14T00:00:00.000Z");
  assert.equal(doc.match(/<\/script>/g)?.length, 1);
  assert.match(doc, /\\u003c\/script>/);
  assert.match(doc, /at="2026-10-14T00:00:00.000Z"/);
});

test("the data's own updatedAt dates it, as ISO or epoch seconds or ms", () => {
  assert.equal(dataUpdatedAt({ updatedAt: "2026-10-14T10:00:00Z" }), Date.parse("2026-10-14T10:00:00Z"));
  assert.equal(dataUpdatedAt({ updatedAt: 1_760_000_000 }), 1_760_000_000_000);
  assert.equal(dataUpdatedAt({ updatedAt: 1_760_000_000_123 }), 1_760_000_000_123);
  assert.equal(dataUpdatedAt({ updatedAt: "soon" }), undefined);
  assert.equal(dataUpdatedAt([1, 2]), undefined);
  assert.equal(dataUpdatedAt(undefined), undefined);
});

test("data goes stale after the page's limit, ten minutes by default", () => {
  assert.equal(isStale({ meta: {}, dataAt: 0 }, 9 * 60_000), false);
  assert.equal(isStale({ meta: {}, dataAt: 0 }, 11 * 60_000), true);
  assert.equal(isStale({ meta: { staleAfter: 30 }, dataAt: 0 }, 31_000), true);
  assert.equal(isStale({ meta: {} }, 1e12), false);
});

const thread = (id: string, over: Partial<ThreadShell> = {}): ThreadShell => ({
  id, projectId: "p1", title: id, worktreePath: null, archivedAt: null, updatedAt: "2026-10-14T00:00:00Z",
  session: { status: "ready" }, latestTurn: { turnId: "x", state: "completed" }, ...over,
} as unknown as ThreadShell);

const env = (id: string, threads: ThreadShell[], over: Partial<EnvWorld> = {}): EnvWorld => ({
  summary: { id, label: id, kind: "t3" }, connection: "live", synced: true, providers: [],
  projects: { p1: { id: "p1", title: "Repo", workspaceRoot: "/work/repo" } },
  threads: Object.fromEntries(threads.map((t) => [t.id, t])), ...over,
} as unknown as EnvWorld);

test("widgets are looked for in each live thread's workspace, once per workspace", () => {
  const envs = {
    e1: env("e1", [
      thread("main-1"), thread("main-2"),
      thread("wt", { worktreePath: "/work/wt" }),
      thread("old", { worktreePath: "/work/old", archivedAt: "2026-10-01T00:00:00Z" }),
    ]),
    off: env("off", [thread("x")], { connection: "offline" }),
    hermes: env("hermes", [thread("h")], { summary: { id: "hermes", label: "Hermes", kind: "hermes" } as EnvWorld["summary"] }),
  };
  assert.deepEqual(widgetWorkspaces(envs), [{ envId: "e1", cwd: "/work/repo" }, { envId: "e1", cwd: "/work/wt" }]);
  assert.deepEqual(workspaceThreads(envs.e1, "/work/repo").map((t) => t.id).sort(), ["main-1", "main-2"]);
});
