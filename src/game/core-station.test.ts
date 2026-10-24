import assert from 'node:assert/strict';
import test from 'node:test';
import { FLEET_PRESETS, makeFleet } from '../lab/fleet-fixture';
import { unitState } from '../t3/derive';
import type { ThreadShell } from '../t3/types';
import { computeFleetLayout, groupProjects, sortedEnvs, type Rect } from './layout';
import { ACTIVE_GRACE_MS, COMPACT, computeCoreStation, fitZoom, isBusy, type CoreOptions, type CoreStation } from './core-station';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const LAPTOP = { w: 1600, h: 1000 }, DESKTOP = { w: 2560, h: 1440 };
const opts = (patch: Partial<CoreOptions> = {}): CoreOptions => ({ tiers: true, viewport: LAPTOP, now: NOW, ...patch });
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const fleets = [
  ...FLEET_PRESETS.map((p) => ({ name: p.name, state: makeFleet(p.spec, NOW) })),
  { name: 'one machine, no Hermes', state: makeFleet({ machines: 1, projects: 3, active: 1, resting: 1, hermes: false }, NOW) },
];
const layouts = fleets.flatMap(({ name, state }) => [LAPTOP, DESKTOP].map((viewport) => ({ name: `${name} @${viewport.w}`, state, layout: computeCoreStation(state, opts({ viewport })) })));
const moduleRect = (m: CoreStation['modules'] extends Map<string, infer M> ? M : never): Rect =>
  ({ x: m.hull.x, y: m.labelBelow ? m.hull.y : m.hull.y - COMPACT.plate, w: m.hull.w, h: m.hull.h + COMPACT.plate });

test('busy means crew awake or active in the last half hour', () => {
  const t = (updatedAgo: number, extra: Partial<ThreadShell> = {}) => ({ updatedAt: new Date(NOW - updatedAgo).toISOString(), latestTurn: { state: 'completed' }, session: { status: 'ready' }, latestUserMessageAt: 'x', settledAt: 'x', ...extra }) as unknown as ThreadShell;
  assert.equal(isBusy([t(ACTIVE_GRACE_MS * 100, { settledAt: null, session: { status: 'running' } as ThreadShell['session'] })], NOW), true);
  assert.equal(isBusy([t(ACTIVE_GRACE_MS / 2)], NOW), true);
  assert.equal(isBusy([t(ACTIVE_GRACE_MS * 2)], NOW), false);
  assert.equal(isBusy([], NOW), false);
});

test('every project is aboard exactly once; quiet ones as cryo modules, never hidden', () => {
  for (const { name, state, layout } of layouts) {
    const keys = [...layout.stations.keys(), ...layout.modules.keys()];
    const groups = groupProjects(sortedEnvs(state)).map((g) => g.key);
    assert.deepEqual([...keys].sort(), [...groups].sort(), name);
    for (const key of keys) assert.ok(layout.berths.has(key), `${name}: ${key} has no berth`);
  }
  for (const { name, state } of fleets) {
    const flat = computeCoreStation(state, opts({ tiers: false }));
    assert.equal(flat.modules.size, 0, name);
  }
});

test('nothing overlaps: the frame, the hall, the decks and every docked project', () => {
  for (const { name, layout } of layouts) {
    const solid: Array<[string, Rect]> = [
      ...layout.decks.map((d) => [`deck ${d.envId}`, d.rect] as [string, Rect]),
      ...[...layout.stations.values()].map((s) => [`station ${s.key}`, s.bounds] as [string, Rect]),
      ...[...layout.modules.values()].map((m) => [`module ${m.key}`, moduleRect(m)] as [string, Rect]),
    ];
    const frame: Array<[string, Rect]> = [
      ['core', layout.core], ...layout.arms.map((a, i) => [`arm ${i}`, a.rect] as [string, Rect]), ...layout.hubs.map((h, i) => [`hub ${i}`, h] as [string, Rect]),
      ...(layout.manifold ? [['manifold', layout.manifold] as [string, Rect]] : []),
      ...(layout.hall ? [['hall', layout.hall.hull] as [string, Rect]] : []),
    ];
    for (let i = 0; i < solid.length; i++) {
      for (let j = i + 1; j < solid.length; j++) assert.ok(!overlap(solid[i][1], solid[j][1]), `${name}: ${solid[i][0]} overlaps ${solid[j][0]}`);
      for (const [label, r] of frame) assert.ok(!overlap(solid[i][1], r), `${name}: ${solid[i][0]} overlaps ${label}`);
    }
  }
});

test('every project docks onto its arm through a collar touching both hull and arm', () => {
  for (const { name, layout } of layouts) {
    for (const [key, berth] of layout.berths) {
      const collar = layout.collars.find((c) => c.stationKey === key)?.rect;
      assert.ok(collar, `${name}: ${key} has no collar`);
      const arm = layout.arms.find((a) => a.level === berth.level)!.rect;
      assert.ok(collar.x >= arm.x && collar.x + collar.w <= arm.x + arm.w, `${name}: ${key}'s collar is off the end of its arm`);
      assert.equal(berth.up ? collar.y + collar.h : collar.y, berth.up ? arm.y : arm.y + arm.h, `${name}: ${key}'s collar doesn't meet its arm`);
      const port = layout.stations.get(key)?.port ?? layout.modules.get(key)!.port;
      assert.equal(berth.up ? collar.y : collar.y + collar.h, port.y, `${name}: ${key}'s collar doesn't meet its hull`);
      assert.equal(Math.sign(port.x), berth.side, `${name}: ${key} is on the wrong side of the core`);
    }
  }
});

test('the station is mirrored about its core', () => {
  for (const { name, layout } of layouts) {
    for (const r of [layout.core, ...layout.arms.map((a) => a.rect), ...layout.hubs, ...(layout.manifold ? [layout.manifold] : []), ...(layout.hall ? [layout.hall.hull] : [])]) {
      assert.equal(r.x + r.w / 2, 0, `${name}: ${JSON.stringify(r)} is off the axis`);
    }
  }
});

test('lanes: one per machine per arm side, lit exactly while it has crew awake there, reaching every collar it serves', () => {
  for (const { name, state, layout } of layouts) {
    const groups = new Map(groupProjects(sortedEnvs(state)).map((g) => [g.key, g]));
    for (const [key, berth] of layout.berths) {
      const port = layout.stations.get(key)?.port ?? layout.modules.get(key)!.port;
      for (const m of groups.get(key)!.members) {
        const lane = layout.lanes.find((l) => l.kind === 'arm' && l.envId === m.env.summary.id && l.arm === berth.arm);
        assert.ok(lane, `${name}: no ${m.env.summary.id} lane to ${key}`);
        assert.ok(Math.abs(lane.b.x) >= Math.abs(port.x), `${name}: ${m.env.summary.id}'s lane stops short of ${key}`);
      }
    }
    for (const lane of layout.lanes.filter((l) => l.kind === 'arm')) {
      const keys = [...layout.berths].filter(([, b]) => b.arm === lane.arm).map(([k]) => k);
      const awake = keys.some((k) => groups.get(k)!.members.some((m) => m.env.summary.id === lane.envId
        && Object.values(m.env.threads).some((t) => t.projectId === m.project.id && unitState(t) !== 'sleeping')));
      assert.equal(lane.lit, awake, `${name}: ${lane.envId} on arm ${lane.arm}`);
    }
  }
});

test('the engine room: deck collars rise to the manifold without crossing another deck', () => {
  for (const { name, layout } of layouts) {
    for (const [i, collar] of layout.deckCollars.entries()) {
      assert.equal(collar.y, layout.manifold!.y + layout.manifold!.h, name);
      for (const [j, d] of layout.decks.entries()) if (i !== j) assert.ok(!overlap(collar, d.rect), `${name}: ${layout.decks[i].envId}'s collar crosses ${d.envId}`);
    }
  }
});

test('the station never fits a screen at a smaller zoom than the live layout', () => {
  for (const { name, state } of fleets) for (const viewport of [LAPTOP, DESKTOP]) {
    const live = fitZoom(computeFleetLayout(state).bounds, viewport);
    const study = fitZoom(computeCoreStation(state, opts({ viewport })).bounds, viewport);
    assert.ok(study >= live, `${name} ${viewport.w}: ${study} < ${live}`);
  }
});
