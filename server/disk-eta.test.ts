import assert from "node:assert/strict";
import test from "node:test";
import { diskEta, etaLabel } from "../shared/storage.ts";

const H = 3_600_000;
const now = Date.UTC(2026, 9, 13, 12);
const series = (hours: number, start: number, perHour: number) =>
  Array.from({ length: hours * 12 + 1 }, (_, i) => ({ at: now - hours * H + i * 300_000, usedFraction: start + perHour * (i / 12) }));

test("a disk filling steadily is full when the line says", () => {
  // 80% → 86% over 6 hours: 1% an hour, 14% left → about 14 hours.
  const eta = diskEta(series(6, 0.8, 0.01), now)!;
  assert.ok(Math.abs(eta / H - 14) < 0.1, String(eta / H));
  assert.equal(etaLabel(eta), "14h");
});

test("no estimate when it isn't filling, or there's too little history", () => {
  assert.equal(diskEta(series(6, 0.8, 0), now), undefined);
  assert.equal(diskEta(series(6, 0.8, -0.01), now), undefined);
  assert.equal(diskEta(series(6, 0.8, 0.00001), now), undefined, "a trickle is noise");
  assert.equal(diskEta(series(6, 0.8, 0.01).slice(-3), now), undefined);
  assert.equal(diskEta([], now), undefined);
});

test("only the last six hours count, and one jump doesn't dominate", () => {
  const old = series(24, 0.5, 0.02).filter((p) => p.at < now - 6 * H);
  const flat = series(6, 0.9, 0);
  assert.equal(diskEta([...old, ...flat], now), undefined, "yesterday's growth has stopped");
  const jump = series(6, 0.8, 0).map((p, i, all) => (i === all.length - 1 ? { ...p, usedFraction: 0.85 } : p));
  const eta = diskEta(jump, now)!;
  assert.ok(eta > 12 * H, "a single late jump spreads over the window");
});

test("labels round to whole units", () => {
  assert.equal(etaLabel(25 * 60_000), "25m");
  assert.equal(etaLabel(5.4 * H), "5h");
  assert.equal(etaLabel(72 * H), "3d");
});
