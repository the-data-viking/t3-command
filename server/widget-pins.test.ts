import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { MAX_PINS, sanitizePin, widgetIds, type WidgetPin } from "../shared/widgets.ts";
import { WidgetPins } from "./widget-pins.ts";

const pin = (id: string, over: Partial<WidgetPin> = {}): WidgetPin =>
  ({ id, envId: "e1", threadId: "t1", cwd: "/work/repo", widget: "runs", mode: "map", x: 10, y: 20, w: 380, h: 240, ...over });

test("pins persist owner-only, move in place, and come off", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "widget-pins-"));
  try {
    const pins = new WidgetPins(dir);
    await pins.load();
    const heard: WidgetPin[][] = [];
    pins.subscribe((list) => heard.push(list));
    pins.put(pin("a"));
    pins.put(pin("b", { mode: "screen" }));
    pins.put(pin("a", { x: 99 }));
    assert.deepEqual(pins.all().map((p) => [p.id, p.x]), [["b", 10], ["a", 99]]);
    assert.equal(heard.length, 3);
    assert.throws(() => pins.put({ id: "c" }));
    pins.remove("b");
    pins.remove("nope");
    await pins.flush();
    assert.equal((await fs.stat(path.join(dir, "widget-pins.json"))).mode & 0o777, 0o600);
    const again = new WidgetPins(dir);
    await again.load();
    assert.deepEqual(again.all(), [pin("a", { x: 99 })]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** A store in a throwaway folder (its writes land there). */
async function scratch(t: TestContext): Promise<WidgetPins> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "widget-pins-"));
  const pins = new WidgetPins(dir);
  t.after(async () => { await pins.flush(); await fs.rm(dir, { recursive: true, force: true }); });
  return pins;
}

test("a pin goes with its thread's archiving or removal, and with its machine", async (t) => {
  const pins = await scratch(t);
  pins.put(pin("a", { threadId: "t1" }));
  pins.put(pin("b", { threadId: "t2" }));
  pins.put(pin("c", { threadId: "t3" }));
  pins.put(pin("d", { envId: "e2", threadId: "t9" }));
  pins.observe("e1", [{ id: "t1", archivedAt: null }, { id: "t2", archivedAt: "2026-10-14T00:00:00Z" }]);
  assert.deepEqual(pins.all().map((p) => p.id), ["a", "d"]);
  pins.forget("e2");
  assert.deepEqual(pins.all().map((p) => p.id), ["a"]);
});

test("pins are validated and clamped, and kept to a limit", async (t) => {
  assert.equal(sanitizePin(null), undefined);
  assert.equal(sanitizePin(pin("a", { widget: "Bad Name" })), undefined);
  assert.equal(sanitizePin(pin("a", { mode: "floating" as never })), undefined);
  assert.equal(sanitizePin({ ...pin("a"), x: Number.NaN }), undefined);
  assert.deepEqual(sanitizePin({ ...pin("a"), w: 5, h: 99_999, x: 1.6, extra: 1 }), pin("a", { w: 200, h: 1200, x: 2 }));
  const pins = await scratch(t);
  for (let i = 0; i < MAX_PINS + 5; i++) pins.put(pin(`p${i}`));
  assert.equal(pins.all().length, MAX_PINS);
  assert.equal(pins.all()[0].id, "p5");
});

test("widget ids come from each .html in the listing", () => {
  assert.deepEqual(widgetIds([
    { path: ".t3/widgets/runs.html", kind: "file" },
    { path: ".t3/widgets/runs.json", kind: "file" },
    { path: ".t3/widgets/gpu-load.html", kind: "file" },
    { path: ".t3/widgets/Bad Name.html", kind: "file" },
    { path: ".t3/widgets/sub.html", kind: "directory" },
  ]), ["gpu-load", "runs"]);
});
