import assert from 'node:assert/strict';
import test from 'node:test';
import type { GameState } from '../store';
import { isHistory, unitState } from '../t3/derive';
import { computeFleetLayout, fingerprint, nodeDrawKey, orderLanes, stationDrawKey, type Rect } from './layout';
import { linkPath } from './map-common';

function fixture(crewCount=1): GameState {
  const env=(id:string, projectNames:string[])=>({
    summary:{id,addedAt:`2026-01-0${id==='a'?1:2}`},
    projects:Object.fromEntries(projectNames.map(name=>[name,{id:name,title:name,workspaceRoot:`/${name}`,
      repositoryIdentity:{canonicalKey:`github.com/test/${name}`,name}}])),
    threads:Object.fromEntries(projectNames.flatMap(name=>Array.from({length:crewCount},(_,n)=>[`${name}-${n}`,{
      id:`${name}-${n}`,projectId:name,createdAt:`2026-01-${String(n+1).padStart(2,'0')}`,updatedAt:'2026-01-01',
      session:{status:'idle'},latestTurn:null,latestUserMessageAt:'2026-01-01',
    }]))),
  });
  return {envs:{a:env('a',['shared','other']),b:env('b',['shared']),empty:env('empty',[])},memory:{}} as unknown as GameState;
}
const intersects=(a:Rect,b:Rect)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;

test('finished subagents enter cryo and wake for follow-up work; ordinary crew keep their reports', () => {
  for (const creationSource of ['provider', 'mcp']) {
    const state = fixture();
    const child = state.envs.a.threads['shared-0'];
    child.creationSource = creationSource;
    child.lineage = { parentThreadId: 'parent', relationshipToParent: 'subagent', rootThreadId: 'parent' };
    child.latestTurn = { turnId: 'run', state: 'completed', requestedAt: '2026-10-19', startedAt: null, completedAt: '2026-10-19', assistantMessageId: null };
    const placement = () => computeFleetLayout(state).crew.get('a:shared-0')!;
    for (const outcome of ['completed', 'error', 'interrupted'] as const) {
      child.latestTurn.state = outcome;
      assert.equal(unitState(child), 'sleeping');
      assert.equal(placement().homeRoom, 'quarters');
      assert.equal(placement().sleeping, true);
    }
    child.latestTurn.state = 'running';
    assert.equal(placement().homeRoom, 'bridge');
    assert.equal(placement().sleeping, false);
    child.latestTurn.state = 'completed';
    child.hasPendingUserInput = true;
    assert.equal(unitState(child), 'question');
    child.hasPendingUserInput = false;
    child.hasPendingApprovals = true;
    assert.equal(unitState(child), 'alert');
    child.hasPendingApprovals = false;
    child.backgroundLiveness = 'working';
    assert.equal(unitState(child), 'working');
    child.backgroundLiveness = null;
    child.lineage.relationshipToParent = 'fork';
    assert.equal(unitState(child), 'done');
    child.lineage.relationshipToParent = 'subagent';
    child.latestTurn = null;
    child.session = null;
    child.latestUserMessageAt = null;
    assert.equal(isHistory(child), false, 'new app-delegated children are crew, not imported transcripts');
    assert.equal(unitState(child), 'idle', 'missing lifecycle is not proof of completion');
    child.settledAt = '2026-10-19';
    assert.equal(placement().homeRoom, 'quarters', 'released children rest even without a recorded turn');
  }
});

test('each environment has one engineering node connected to every project it serves',()=>{
  const layout=computeFleetLayout(fixture());
  assert.equal(layout.stations.size,2);
  assert.equal(layout.environmentNodes.size,3);
  assert.equal(new Set([...layout.environmentNodes.values()].map(n=>n.envId)).size,3);
  assert.equal(layout.environmentNodes.get('a')!.links.length,2);
  assert.equal(layout.environmentNodes.get('b')!.links.length,1);
  assert.equal(layout.environmentNodes.get('empty')!.links.length,0);
  const occupied=[...layout.stations.values()].map(s=>s.bounds);
  for(const node of layout.environmentNodes.values()){
    const expected=[...layout.stations.values()].filter(s=>s.members.some(m=>m.envId===node.envId)).map(s=>s.key).sort();
    assert.deepEqual(node.links.map(l=>l.stationKey).sort(),expected);
    for(const link of node.links){
      const station=layout.stations.get(link.stationKey)!;
      // Every line leaves its deck from the bottom, down onto the keel's bus.
      assert.equal(link.from.y,node.hull.y+node.hull.h);
      assert.equal(link.from.x,node.hull.x+node.hull.w/2);
      assert.equal(link.to.x,station.port.x);
      assert.ok(link.to.y>=station.bounds.y&&link.to.y<=station.bounds.y+station.bounds.h);
    }
    occupied.push(node.hull);
  }
  for(let i=0;i<occupied.length;i++)for(let j=i+1;j<occupied.length;j++)assert.equal(intersects(occupied[i],occupied[j]),false,'Facilities never overlap');
  for(const r of occupied){assert.ok(r.x>=layout.bounds.x&&r.y>=layout.bounds.y);assert.ok(r.x+r.w<=layout.bounds.x+layout.bounds.w&&r.y+r.h<=layout.bounds.y+layout.bounds.h);}
});
test('large commons retain every crew seat inside its actual room',()=>{
  const layout=computeFleetLayout(fixture(36));
  assert.equal(layout.crew.size,108);
  for(const crew of layout.crew.values()){
    const r=layout.stations.get(crew.stationKey)!.rooms[crew.homeRoom]!.rect;
    assert.ok(crew.home.x>r.x&&crew.home.x<r.x+r.w&&crew.home.y>r.y&&crew.home.y<r.y+r.h);
  }
});

test('Hermes occupies one control center across workspaces and never becomes a project or engineering node', () => {
  const state = fixture();
  for (const id of ['hermes-a', 'hermes-b']) state.envs[id] = {
    ...state.envs.a, summary: { ...state.envs.a.summary, id, kind: 'hermes' },
    // Deliberately matching a real repository must not merge a bot into its crew.
  };
  state.hermesCatalog = { envId: 'hermes-a', loaded: true, bots: Array.from({ length: 9 }, (_, i) => ({
    name: `bot-${i}`, title: `Bot ${i}`, description: '', model: null, provider: null, skillCount: 0, isDefault: false,
  })) };
  const layout = computeFleetLayout(state);
  assert.equal(layout.stations.size, 2);
  assert.equal(layout.environmentNodes.size, 3);
  assert.equal(layout.crew.size, 3, 'only T3 project sessions become project crew');
  assert.deepEqual(layout.controlCenter?.envIds, ['hermes-a', 'hermes-b']);
  const center = layout.controlCenter!;
  assert.equal(center.links.length, 3, 'uplinks end at engineering nodes, including nodes without projects');
  for (const link of center.links) {
    assert.ok(layout.environmentNodes.has(link.envId));
    for (const station of layout.stations.values()) {
      assert.ok(link.to.y < station.bounds.y,
        'docking collars stay above repository-defined project modules');
    }
  }
  for (const station of layout.stations.values()) assert.ok(station.members.every(m => !m.envId.startsWith('hermes')));
  for (const facility of [...layout.stations.values()].map(s => s.bounds).concat([...layout.environmentNodes.values()].map(n => n.hull))) {
    assert.equal(intersects(center.hull, facility), false);
  }
  for (const { workstation } of center.operators) {
    assert.ok(workstation.x >= center.hull.x && workstation.y >= center.hull.y);
    assert.ok(workstation.x + workstation.w <= center.hull.x + center.hull.w
      && workstation.y + workstation.h <= center.hull.y + center.hull.h);
  }
  assert.ok(layout.bounds.y <= center.hull.y);
});

test('docked engineering scales without changing projects or routing through facilities', () => {
  for (let count = 0; count <= 10; count++) {
    const state = fixture();
    for (const id of Object.keys(state.envs).slice(count)) delete state.envs[id];
    for (let i = 3; i < count; i++) state.envs[`extra-${i}`] = {
      ...state.envs.a, summary: { ...state.envs.a.summary, id: `extra-${i}` }, projects: {}, threads: {},
    };
    const before = computeFleetLayout(state);
    state.envs.hermes = { summary: { id: 'hermes', kind: 'hermes', addedAt: '2026-02-01' },
      projects: {}, threads: {} } as unknown as GameState['envs'][string];
    state.hermesCatalog = { envId: 'hermes', loaded: true, bots: Array.from({ length: 13 }, (_, i) => ({
      name: `bot-${i}`, title: `Bot ${i}`, description: '', model: null, provider: null, skillCount: 0, isDefault: false,
    })) };
    const layout = computeFleetLayout(state);
    const center = layout.controlCenter!;
    assert.deepEqual(layout.stations, before.stations, 'project hulls and rooms retain their existing layout');
    assert.deepEqual(layout.crew, before.crew, 'T3 project crew retain their existing seats');
    assert.equal(layout.environmentNodes.size, count);
    const facilities = [center.hull, ...layout.environmentNodes.values()].map(r => 'hull' in r ? r.hull : r)
      .concat([...layout.stations.values()].map(s => s.bounds));
    for (let i = 0; i < facilities.length; i++) for (let j = i + 1; j < facilities.length; j++) {
      assert.equal(intersects(facilities[i], facilities[j]), false, `${count} bays: facilities never overlap`);
    }
    for (const node of layout.environmentNodes.values()) {
      assert.ok(node.hull.x >= center.bounds.x && node.hull.x + node.hull.w <= center.bounds.x + center.bounds.w);
      assert.ok(node.hull.y >= center.bounds.y && node.hull.y + node.hull.h <= center.bounds.y + center.bounds.h);
      for (const link of node.links) {
        assert.ok(link.via);
        const points = [link.from, ...link.via, link.to];
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1], b = points[i];
          assert.ok(a.x === b.x || a.y === b.y, 'conduits use axis-aligned segments');
          for (const r of facilities) {
            const crosses = a.x === b.x
              ? a.x > r.x && a.x < r.x + r.w && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.h
              : a.y > r.y && a.y < r.y + r.h && Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.w;
            assert.equal(crosses, false, `${count} bays: project conduits never cross facility interiors`);
          }
        }
      }
    }
  }
});

test('streamed thread churn keeps every facility drawing, while real layout changes redraw', () => {
  const state = fixture(2);
  const keys = (s: GameState) => {
    const layout = computeFleetLayout(s);
    return { stations: [...layout.stations.values()].map(st => stationDrawKey(s, st)),
      nodes: [...layout.environmentNodes.values()].map(n => nodeDrawKey(s, n)), bounds: fingerprint(layout.bounds) };
  };
  const before = keys(state);
  // A reply streaming into a thread changes its shell timestamps on every chunk.
  const churned = structuredClone(state);
  Object.assign(churned.envs.a.threads['shared-0'], { updatedAt: '2026-01-09T10:00:00Z', latestUserMessageAt: '2026-01-09T10:00:00Z' });
  churned.envs.b = { ...churned.envs.b, usage: { error: 'refreshed' } } as typeof churned.envs.b;
  assert.deepEqual(keys(churned), before);
  // Renaming a machine changes its chassis and its project's nameplate.
  const renamed = structuredClone(state);
  renamed.envs.b.summary = { ...renamed.envs.b.summary, label: 'Renamed' };
  assert.notDeepEqual(keys(renamed).nodes, before.nodes);
  // Switching art style redraws everything.
  const restyled = { ...state, artStyle: 'flightdeck' } as GameState;
  assert.ok(keys(restyled).stations.every((key, i) => key !== keys({ ...state, artStyle: 'flightdeck-nightshift' } as GameState).stations[i]));
});

test('scratch projects never become stations; their awake crew stand in the engineering bay', () => {
  const state = fixture();
  const scratch = (envId: string, root: string, threads: Array<[string, string, string?]>) => {
    const env = state.envs[envId];
    env.projects = { ...env.projects, [`${envId}-scratch`]: { id: `${envId}-scratch`, title: 'No project', workspaceRoot: root, repositoryIdentity: null, createdAt: '2026-01-01' } as never };
    for (const [id, createdAt, settledAt] of threads) env.threads[id] = { ...env.threads['shared-0'], id, projectId: `${envId}-scratch`, createdAt,
      session: { status: settledAt ? 'idle' : 'running' }, settledAt: settledAt ?? null } as never;
  };
  scratch('a', '/home/a/.t3/scratch', [['s1', '2026-01-01'], ['s2', '2026-01-02'], ['s3', '2026-01-03']]);
  scratch('b', 'C:\\Users\\b\\.t3\\scratch\\', []);
  const layout = computeFleetLayout(state);
  assert.equal(layout.stations.size, 2, 'scratch folders on two machines never form a shared or local station');
  assert.equal(layout.environmentNodes.get('empty')!.scratch, undefined);
  const a = layout.environmentNodes.get('a')!;
  assert.equal(a.links.length, 2, 'no conduit to a scratch project');
  assert.deepEqual(a.scratch?.overflow, ['s3']);
  assert.deepEqual(layout.environmentNodes.get('b')!.scratch?.overflow, []);
  const bay = layout.bays.get(a.scratch!.stationKey)!;
  for (const id of ['s1', 's2']) {
    const crew = layout.crew.get(`a:${id}`)!;
    assert.equal(crew.stationKey, bay.key);
    assert.ok(crew.home.x > a.bay.x && crew.home.x < a.bay.x + a.bay.w && crew.home.y > a.bay.y && crew.home.y <= a.bay.y + a.bay.h);
    assert.ok(crew.home.x > a.hull.x && crew.home.x < a.hull.x + a.hull.w);
  }
  assert.equal(layout.crew.has('a:s3'), false);
});

test('the Hermes hall is sized to its operators, and each dock takes its collar where the hall is', () => {
  const hall = (bots: number) => {
    const state = fixture();
    state.envs.hermes = { summary: { id: 'hermes', kind: 'hermes', addedAt: '2026-02-01' }, projects: {}, threads: {} } as unknown as GameState['envs'][string];
    state.hermesCatalog = { envId: 'hermes', loaded: true, bots: Array.from({ length: bots }, (_, i) => ({
      name: `bot-${i}`, title: `Bot ${i}`, description: '', model: null, provider: null, skillCount: 0, isDefault: false,
    })) };
    return computeFleetLayout(state);
  };
  const two = hall(2), many = hall(13);
  assert.deepEqual([two.controlCenter!.hull.w, two.controlCenter!.hull.h], [2 * 166 - 8 + 280, 224], 'two operators: the reviewers\' ~600×220');
  assert.equal(many.controlCenter!.hull.w, 4 * 166 - 8 + 280, 'four bays a row, with the archive and routines beside them');
  assert.equal(many.controlCenter!.hull.h, 86 + 4 * 124 + 14);
  for (const layout of [two, many]) {
    const center = layout.controlCenter!;
    for (const link of center.links) {
      const node = layout.environmentNodes.get(link.envId)!;
      assert.equal(link.laneX, node.hatchX, 'the collar lands on the dock\'s hatch');
      assert.ok(node.hatchX - 20 >= node.hull.x && node.hatchX + 20 <= node.hull.x + node.hull.w, 'the hatch is on the dock\'s roof');
    }
    // The collars hang from the keel's spine, which leaves the hall clear of its stepped corners
    // and reaches every deck in the top row, however wide the row and however small the hall.
    const spine = center.manifold!;
    assert.ok(spine.stemX - 20 >= center.hull.x + 40 && spine.stemX + 20 <= center.hull.x + center.hull.w - 40, 'clear of the hall\'s stepped corners');
    assert.equal(spine.top, center.hull.y + center.hull.h);
    for (const link of center.links.slice(0, 3)) {
      assert.equal(link.from.y, spine.y);
      assert.ok(link.from.x >= spine.x0 && link.from.x <= spine.x1);
    }
  }
});

// A fleet of `machines`, each serving some of `projects` (the first two shared by all).
function fleet(machines: number, projects: number): GameState {
  const envs: Record<string, unknown> = {};
  for (let m = 0; m < machines; m++) {
    const names = Array.from({ length: projects }, (_, p) => `p${p}`).filter((_, p) => p % machines === m || p < 2 || (p * 7 + m) % 5 === 0);
    envs[`m${m}`] = { summary: { id: `m${m}`, addedAt: `2026-01-${String(m + 1).padStart(2, '0')}` },
      projects: Object.fromEntries(names.map(n => [n, { id: n, title: n, workspaceRoot: `/${n}`, repositoryIdentity: { canonicalKey: `gh/${n}`, name: n } }])),
      threads: {} };
  }
  return { envs, memory: {} } as unknown as GameState;
}

test('the keel: a lone project sits on the axis under the decks, and a big fleet spreads wide, not tall', () => {
  const one = computeFleetLayout(fleet(1, 1));
  const station = [...one.stations.values()][0];
  assert.equal(station.bounds.x + station.bounds.w / 2, 0);
  const deck = [...one.environmentNodes.values()][0].hull;
  assert.equal(deck.x + deck.w / 2, 0);
  assert.ok(station.bounds.y > deck.y + deck.h);
  const big = computeFleetLayout(fleet(6, 15));
  assert.equal(big.stations.size, 15);
  assert.ok(big.bounds.w > big.bounds.h, `6 machines × 15 projects: ${big.bounds.w}×${big.bounds.h}`);
});

test('supply lines cross only on the bus; below it each runs its own lane into its port', () => {
  for (const [machines, projects] of [[2, 3], [5, 3], [5, 5], [6, 15]]) {
    const layout = computeFleetLayout(fleet(machines, projects));
    const decksBottom = Math.max(...[...layout.environmentNodes.values()].map(n => n.hull.y + n.hull.h));
    const busBottom = decksBottom + 28 + (machines - 1) * 8;
    const segments: Array<{ env: string; a: { x: number; y: number }; b: { x: number; y: number } }> = [];
    for (const node of layout.environmentNodes.values()) for (const link of node.links) {
      const points = linkPath(link.from, link.to, link.via);
      for (let i = 1; i < points.length; i++) segments.push({ env: node.envId, a: points[i - 1], b: points[i] });
    }
    for (const s of segments) for (const t of segments) {
      if (s.env === t.env || s.a.x !== s.b.x || t.a.y !== t.b.y || t.a.y <= busBottom) continue;
      const crosses = s.a.x > Math.min(t.a.x, t.b.x) && s.a.x < Math.max(t.a.x, t.b.x)
        && t.a.y > Math.min(s.a.y, s.b.y) && t.a.y < Math.max(s.a.y, s.b.y);
      assert.equal(crosses, false, `${machines}×${projects}: ${s.env} and ${t.env} cross below the bus at ${s.a.x},${t.a.y}`);
    }
  }
});

test('bus lanes stack in the order with fewest crossings', () => {
  // A drops at 0 and runs to 100; B drops at 50 and runs to 150. With B under A, B's drop and
  // A's line down both cross the other's lane; with B on top, neither does.
  const a = { drop: 0, downs: [100], lo: 0, hi: 100 }, b = { drop: 50, downs: [150], lo: 50, hi: 150 };
  assert.deepEqual(orderLanes([a, b]), [1, 0]);
  assert.deepEqual(orderLanes([b, a]), [0, 1]);
});

test('each wing gets a junction box, every deck a flange under its hatch, every line one at its port', () => {
  for (const [machines, projects] of [[1, 1], [5, 5], [6, 15]]) {
    const layout = computeFleetLayout(fleet(machines, projects));
    assert.ok(layout.junctions.length >= 1, `${machines}×${projects}: a junction box`);
    const near = (x: number, y: number, vertical: boolean) => layout.flanges.some(f => f.vertical === vertical && Math.abs(f.x - x) <= 12 && Math.abs(f.y - y) <= 8);
    for (const node of layout.environmentNodes.values()) {
      if (!node.links.length) continue;
      assert.ok(near(node.links[0].from.x, node.links[0].from.y, true), `${node.envId}: a flange under its hatch`);
      for (const link of node.links) assert.ok(near(link.to.x, link.to.y, false), `${node.envId} → ${link.stationKey}: a flange at its port`);
    }
  }
});
