import assert from "node:assert/strict";
import test from "node:test";
import { fleetSpend, historyWindow, todayWindow, type UsageSummary } from "./usage";

const window = { sinceDay: "2026-10-11", untilDay: "2026-10-11", timeZone: "America/Chicago" };
const summary = (costUsd: number, overrides: Partial<UsageSummary> = {}): UsageSummary => ({
  contractVersion: 6, readAt: "2026-10-11T21:00:00Z", ...window,
  sources: [{ fingerprint: { hostId: "host", provider: "codex", resolvedHomePath: "/home/user/.codex", volumeId: "1:2" }, status: "ok", message: null }],
  buckets: [{ day: window.sinceDay, provider: "codex", model: "test-model", sourcePath: "/home/user/.codex", costUsd, unpricedRecords: 0 }],
  pricing: { status: "fresh", fetchedAt: "2026-10-11T20:00:00Z" }, ...overrides,
});
const station = (id: string, s?: UsageSummary, connection = "live") => ({ id, label: id, connection, usage: s ? { summary: s } : undefined });

test("today uses the viewer's calendar day across midnight and DST", () => {
  assert.equal(todayWindow(new Date("2026-10-12T02:00:00Z"), "America/Chicago").sinceDay, "2026-10-11");
  assert.equal(todayWindow(new Date("2026-11-01T05:30:00Z"), "America/Chicago").sinceDay, "2026-11-01");
  assert.equal(todayWindow(new Date("2026-11-01T07:30:00Z"), "America/Chicago").sinceDay, "2026-11-01");
});

test("shared physical transcript directories count once using the newest scan", () => {
  const old = summary(10);
  const latest = summary(12, { readAt: "2026-10-11T21:01:00Z" });
  const spend = fleetSpend([station("a", old), station("b", latest)], window);
  assert.equal(spend.costUsd, 12);
  assert.equal(spend.rows[0].costUsd, 0);
  assert.equal(spend.rows[0].sharedSources, 1);
  assert.equal(spend.rows[1].costUsd, 12);
});

test("different filesystem identities remain separate even with identical hostnames and paths", () => {
  const first = summary(10);
  const second = summary(12, { sources: [{ ...first.sources[0], fingerprint: { ...first.sources[0].fingerprint, volumeId: "3:4" } }] });
  assert.equal(fleetSpend([station("a", first), station("b", second)], window).costUsd, 22);
});

test("healthy source wins over a newer failed scan; gaps stay visible", () => {
  const healthy = summary(10);
  const failed = summary(0, { readAt: "2026-10-11T21:02:00Z", sources: [{ ...healthy.sources[0], status: "failed", message: "Scan failed" }] });
  const spend = fleetSpend([station("a", healthy), station("b", failed)], window);
  assert.equal(spend.costUsd, 10);
  assert.equal(spend.partial, true);
  assert.match(spend.rows[1].notes.join(" "), /Scan failed/);
});

test("missing stations are not treated as zero and offline values are marked last known", () => {
  assert.equal(fleetSpend([station("missing")], window).costUsd, undefined);
  const spend = fleetSpend([station("offline", summary(5), "reconnecting"), station("missing")], window);
  assert.equal(spend.costUsd, 5);
  assert.equal(spend.rows[1].costUsd, undefined);
  assert.equal(spend.partial, true);
  assert.match(spend.rows[0].notes.join(" "), /Last known/);
});

test("unpriced usage is disclosed and previous days, zones and unknown contracts are excluded", () => {
  const s = summary(5);
  const unpriced = summary(5, { buckets: [{ ...s.buckets[0], unpricedRecords: 3 }] });
  const spend = fleetSpend([station("today", unpriced), station("yesterday", summary(50, { sinceDay: "2026-10-10", untilDay: "2026-10-10", buckets: [{ ...s.buckets[0], day: "2026-10-10" }] })),
    station("other-zone", summary(70, { timeZone: "UTC" })), station("future", summary(90, { contractVersion: 7 }))], window);
  assert.equal(spend.costUsd, 5);
  assert.equal(spend.rows[0].unpricedRecords, 3);
  assert.equal(spend.available, 1);
  assert.equal(spend.partial, true);
});

test("sourcePath attributes multi-home buckets and legacy single-home buckets still work", () => {
  const a = summary(5);
  const b = summary(7, { sources: [{ ...a.sources[0], fingerprint: { ...a.sources[0].fingerprint, resolvedHomePath: "/other", volumeId: "5:6" } }],
    buckets: [{ ...a.buckets[0], costUsd: 7, sourcePath: "/other" }] });
  const merged = summary(12, { sources: [...a.sources, ...b.sources], buckets: [...a.buckets, ...b.buckets] });
  assert.equal(fleetSpend([station("multi", merged)], window).costUsd, 12);
  assert.equal(fleetSpend([station("legacy", summary(5, { buckets: [{ ...a.buckets[0], sourcePath: undefined }] }))], window).costUsd, 5);
  const ambiguous = summary(5, { sources: merged.sources, buckets: [{ ...a.buckets[0], sourcePath: undefined }] });
  assert.equal(fleetSpend([station("ambiguous", ambiguous)], window).partial, true);
});

test("seven-day history uses calendar dates across DST and year boundaries", () => {
  assert.deepEqual(historyWindow(new Date("2026-11-01T07:30:00Z"), "America/Chicago"), { sinceDay: "2026-10-26", untilDay: "2026-11-01", timeZone: "America/Chicago" });
  assert.equal(historyWindow(new Date("2027-01-02T02:00:00Z"), "America/Chicago").sinceDay, "2026-12-26");
});

test("a history scan supplies today's estimate without including earlier days", () => {
  const s = summary(5);
  const history = summary(5, { sinceDay: "2026-10-05", buckets: [{ ...s.buckets[0], day: "2026-10-05", costUsd: 10 }, s.buckets[0]] });
  assert.equal(fleetSpend([station("a", history)], window).costUsd, 5);
  const spend = fleetSpend([station("a", history)], { ...window, sinceDay: "2026-10-05" });
  assert.equal(spend.costUsd, 15);
  assert.deepEqual(spend.daily.map((d) => d.costUsd), [10, 0, 0, 0, 0, 0, 5]);
});

test("cache tokens and server-calculated savings deduplicate with their physical source", () => {
  const s = summary(5);
  const cached = summary(5, { buckets: [{ ...s.buckets[0], cacheSavingsUsd: 20, totals: { uncachedInputTokens: 100, cachedInputTokens: 800, cacheCreationTokens: 100, outputTokens: 400, reasoningTokens: 200 } }] });
  const spend = fleetSpend([station("a", cached), station("b", { ...cached, readAt: "2026-10-11T21:01:00Z" })], window);
  assert.equal(spend.cachedInputTokens, 800);
  assert.equal(spend.inputTokens, 1000);
  assert.equal(spend.cacheSavingsUsd, 20);
  assert.equal(spend.cacheAvailable, true);
  assert.equal(fleetSpend([station("legacy", s)], window).cacheAvailable, false);
});
