import assert from 'node:assert/strict';
import test from 'node:test';
import { FLEET_PRESETS, makeFleet } from '../lab/fleet-fixture';
import { unitState } from '../t3/derive';
import type { ThreadShell } from '../t3/types';
import { computeFleetLayout, groupProjects, sortedEnvs, type Rect } from './layout';
import { ACTIVE_GRACE_MS, COMPACT, computeTieredLayout, fitZoom, RESTING_MS, stationTier, type TierOptions } from './fleet-tiers';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const opts = (patch: Partial<TierOptions> = {}): TierOptions => ({ tiers: true, lines: 'lit', shape: true, viewport: { w: 1600, h: 1000 }, now: NOW, ...patch });
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const fleets = FLEET_PRESETS.map((p) => ({ name: p.name, state: makeFleet(p.spec, NOW) }));

test('tiers: awake crew or recent activity keep a station full; then cryo; then the dock', () => {
  const t = (updatedAgo: number, extra: Partial<ThreadShell> = {}) => ({ updatedAt: new Date(NOW - updatedAgo).toISOString(), latestTurn: { state: 'completed' }, session: { status: 'ready' }, latestUserMessageAt: 'x', settledAt: 'x', ...extra }) as unknown as ThreadShell;
  assert.equal(stationTier([t(RESTING_MS * 4, { settledAt: null, session: { status: 'running' } as ThreadShell['session'] })], NOW), 'active');
  assert.equal(stationTier([t(ACTIVE_GRACE_MS / 2)], NOW), 'active');
  assert.equal(stationTier([t(ACTIVE_GRACE_MS * 2)], NOW), 'resting');
  assert.equal(stationTier([t(RESTING_MS * 2)], NOW), 'dormant');
  assert.equal(stationTier([], NOW), 'dormant');
});

test('every project is placed exactly once, in whichever tier', () => {
  for (const { name, state } of fleets) for (const tiers of [true, false]) {
    const layout = computeTieredLayout(state, opts({ tiers }));
    const keys = [...layout.stations.keys(), ...layout.modules.keys(), ...layout.capsules.keys()];
    const groups = groupProjects(sortedEnvs(state)).map((g) => g.key);
    assert.deepEqual([...keys].sort(), [...groups].sort(), `${name} tiers=${tiers}`);
    if (!tiers) assert.equal(layout.modules.size + layout.capsules.size, 0);
  }
});

test('nothing overlaps: decks, stations, modules and the dock', () => {
  for (const { name, state } of fleets) for (const viewport of [{ w: 1600, h: 1000 }, { w: 2560, h: 1440 }]) {
    const layout = computeTieredLayout(state, opts({ viewport }));
    const rects: Array<[string, Rect]> = [
      ...layout.decks.map((d) => [`deck ${d.envId}`, d.rect] as [string, Rect]),
      ...[...layout.stations.values()].map((s) => [`station ${s.key}`, s.bounds] as [string, Rect]),
      ...[...layout.modules.values()].map((s) => [`module ${s.key}`, { ...s.hull, y: s.hull.y - COMPACT.plate, h: s.hull.h + COMPACT.plate }] as [string, Rect]),
      ...(layout.rack ? [['rack', layout.rack] as [string, Rect]] : []),
    ];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      assert.ok(!overlap(rects[i][1], rects[j][1]), `${name} ${viewport.w}: ${rects[i][0]} overlaps ${rects[j][0]}`);
    }
    for (const c of layout.capsules.values()) assert.ok(layout.rack && c.hull.x >= layout.rack.x && c.hull.x + c.hull.w <= layout.rack.x + layout.rack.w && c.hull.y + c.hull.h <= layout.rack.y + layout.rack.h, `${name}: capsule ${c.key} outside the dock`);
  }
});

test('lines are lit exactly where a machine has crew awake in the station', () => {
  for (const { name, state } of fleets) {
    const layout = computeTieredLayout(state, opts());
    for (const link of layout.links) {
      const awake = Object.values(state.envs[link.envId].threads).some((t) => {
        const group = groupProjects(sortedEnvs(state)).find((g) => g.key === link.stationKey)!;
        return group.members.some((m) => m.env.summary.id === link.envId && m.project.id === t.projectId) && unitState(t) !== 'sleeping';
      });
      assert.equal(link.lit, awake, `${name}: ${link.envId} → ${link.stationKey}`);
    }
    // Every machine-project pair still has a route (drawn on hover), and "all" lights them all.
    const pairs = [...computeFleetLayout(state).environmentNodes.values()].reduce((n, node) => n + node.links.length, 0);
    assert.equal(layout.links.length, pairs, name);
    assert.ok(computeTieredLayout(state, opts({ lines: 'all' })).links.every((l) => l.lit));
  }
});

test('the brick keel: every deck drops to the bus without crossing another deck', () => {
  for (const { name, state } of fleets) {
    const layout = computeTieredLayout(state, opts());
    for (const link of layout.links) {
      const [from, down] = link.points;
      for (const deck of layout.decks) {
        if (deck.envId === link.envId) continue;
        const crosses = from.x > deck.rect.x && from.x < deck.rect.x + deck.rect.w && Math.max(from.y, down.y) > deck.rect.y && Math.min(from.y, down.y) < deck.rect.y + deck.rect.h;
        assert.ok(!crosses, `${name}: ${link.envId}'s drop crosses ${deck.envId}`);
      }
    }
  }
});

test('the study never fits a screen at a smaller zoom than the live layout', () => {
  for (const { name, state } of fleets) for (const viewport of [{ w: 1600, h: 1000 }, { w: 2560, h: 1440 }]) {
    const live = fitZoom(computeFleetLayout(state).bounds, viewport);
    const study = fitZoom(computeTieredLayout(state, opts({ viewport })).bounds, viewport);
    assert.ok(study >= live, `${name} ${viewport.w}: ${study} < ${live}`);
  }
});
