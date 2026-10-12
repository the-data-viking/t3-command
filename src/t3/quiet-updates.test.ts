import assert from "node:assert/strict";
import test from "node:test";
import type { EnvSummary } from "../../shared/api";
import { updateEnv, useGame, type EnvWorld } from "../store";
import { refreshHermesBots } from "./hermes";

const env = (id: string, kind: "t3" | "hermes" = "t3") => ({
  summary: { id, label: id, kind } as EnvSummary, connection: "live", synced: true, providers: [], projects: {}, threads: {},
}) as unknown as EnvWorld;

test("updates that return the same environment notify nobody; real changes still do", () => {
  useGame.setState({ envs: { a: env("a") } });
  let notified = 0;
  const off = useGame.subscribe(() => notified++);
  const before = useGame.getState().envs;
  updateEnv("a", (e) => e);
  updateEnv("missing", (e) => ({ ...e, synced: false }));
  assert.equal(notified, 0);
  assert.equal(useGame.getState().envs, before);
  updateEnv("a", (e) => ({ ...e, synced: false }));
  assert.equal(notified, 1);
  assert.equal(useGame.getState().envs.a.synced, false);
  off();
});

test("an unchanged Hermes profile refresh keeps the catalog identity, so the map does not redraw", async () => {
  const bots = [{ name: "default", title: "Default", description: "", model: null, provider: null, skillCount: 0, isDefault: true }];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(bots), { status: 200 })) as typeof fetch;
  try {
    useGame.setState({ envs: { h: env("h", "hermes") }, hermesCatalog: undefined });
    await refreshHermesBots();
    const first = useGame.getState().hermesCatalog;
    assert.deepEqual(first?.bots, bots);
    await refreshHermesBots();
    assert.equal(useGame.getState().hermesCatalog, first);
    bots.push({ ...bots[0], name: "money", title: "Money Guy", isDefault: false });
    await refreshHermesBots();
    assert.notEqual(useGame.getState().hermesCatalog, first);
    assert.equal(useGame.getState().hermesCatalog?.bots.length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
