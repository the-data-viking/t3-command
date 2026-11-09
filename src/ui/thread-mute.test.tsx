import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { loadDemoFleet } from "../demo";
import { useGame } from "../store";
import { UnitPanel } from "./UnitPanel";
import { installTitleBadge, notifyAttention } from "./attention";
import { CrewRoster } from "./CrewRoster";
import { EventLog } from "./EventLog";

// Exercise the actual panel toggle and client notification surfaces together.
test("thread mute saves from the panel, updates badges/ticker, and blocks desktop alerts; failures stay visible", async (t) => {
  const dom = new JSDOM("<div id='root'></div><div id='log'></div>", { url: "http://localhost" });
  const restore: Array<() => void> = [];
  let notifications = 0;
  class DesktopNotification {
    static permission = "granted";
    constructor() { notifications++; }
  }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    localStorage: dom.window.localStorage, Notification: DesktopNotification, IS_REACT_ACT_ENVIRONMENT: true })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    restore.push(() => previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key));
  }
  // The open panel's order box needn't scroll or focus in this DOM.
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  t.mock.method(dom.window.HTMLCanvasElement.prototype, "getContext", () => ({
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {},
  }) as never);
  t.mock.method(dom.window.HTMLCanvasElement.prototype, "toDataURL", () => "data:image/png;base64,AA==");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const logRoot = createRoot(dom.window.document.getElementById("log")!);
  loadDemoFleet();
  useGame.setState({ prefs: { models: {}, routing: {} }, readReports: {}, notify: true, jumpedAt: performance.now() });
  const offBadge = installTitleBadge();
  t.after(async () => {
    offBadge();
    await act(() => { root.unmount(); logRoot.unmount(); });
    dom.window.close();
    restore.forEach((fn) => fn());
  });
  let fail = false;
  const requests: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const patch = JSON.parse(String(init?.body));
    requests.push(patch);
    if (fail) return new Response("Cannot save", { status: 500 });
    return new Response(JSON.stringify({ models: {}, routing: {}, mutedThreads: patch.mutedThreads["mini:a2"] ? { "mini:a2": true } : {} }));
  });
  const thread = useGame.getState().envs.mini.threads.a2;
  const child = { ...thread, id: "child", lineage: { parentThreadId: thread.id, rootThreadId: thread.id, relationshipToParent: "subagent" } };
  notifyAttention("mini", child, "alert");
  assert.equal(notifications, 0, "subagents never create a desktop alert");
  notifyAttention("mini", thread, "alert");
  assert.equal(notifications, 1, "ordinary approvals still notify");
  const beforeTitle = dom.window.document.title;
  useGame.setState({ log: [
    { id: "s1", at: Date.now(), kind: "approval", tone: "alert", envId: "mini", threadId: "a2", text: "Approval ticker" },
    { id: "s2", at: Date.now(), kind: "long-turn", tone: "alert", text: "Old duration alert" },
  ] });
  await act(() => { root.render(<UnitPanel envId="mini" threadId="a2" />); logRoot.render(<><EventLog /><CrewRoster /></>); });
  const container = dom.window.document.getElementById("root")!;
  assert.match(dom.window.document.getElementById("log")!.textContent!, /Approval ticker/);
  assert.doesNotMatch(dom.window.document.getElementById("log")!.textContent!, /Old duration alert/);
  const click = async (label: string) => {
    const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    assert.ok(button, label);
    await act(async () => { button.click(); });
  };
  await click("Mute thread notifications");
  assert.deepEqual(requests[0], { mutedThreads: { "mini:a2": true } });
  assert.equal(container.querySelector('[aria-label="Unmute thread notifications"]')?.getAttribute("aria-pressed"), "true");
  assert.notEqual(dom.window.document.title, beforeTitle, "muting immediately updates the badge");
  const mutedRow = [...dom.window.document.querySelectorAll(".crew-row")].find((el) => el.textContent?.includes(thread.title));
  assert.ok(mutedRow, "a muted thread remains accessible in the roster");
  assert.equal(mutedRow.closest("ol")?.previousElementSibling?.textContent, "On duty", "muted requests leave Needs you");
  assert.doesNotMatch(dom.window.document.getElementById("log")!.textContent!, /Approval ticker/);
  notifyAttention("mini", thread, "alert");
  assert.equal(notifications, 1, "muted desktop alerts never reach Notification");
  fail = true;
  await click("Unmute thread notifications");
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /Couldn't save/);
  assert.equal(useGame.getState().prefs.mutedThreads?.["mini:a2"], true, "a failed unmute keeps the saved state");
  fail = false;
  await click("Unmute thread notifications");
  assert.equal(dom.window.document.title, beforeTitle);
  notifyAttention("mini", thread, "alert");
  assert.equal(notifications, 2);
});
