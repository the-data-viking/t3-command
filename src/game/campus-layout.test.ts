import assert from 'node:assert/strict';
import test from 'node:test';
import type { GameState } from '../store';
import { computeFleetLayout, type Rect } from './layout';

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
  return {envs:{a:env('a',['shared','other']),b:env('b',['shared']),empty:env('empty',[])}} as unknown as GameState;
}
const intersects=(a:Rect,b:Rect)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;

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
      assert.equal(link.from.y,node.hull.y+node.hull.h/2);
      assert.ok(link.from.x===node.hull.x||link.from.x===node.hull.x+node.hull.w);
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
      assert.ok(link.laneX < station.bounds.x || link.laneX > station.bounds.x + station.bounds.w,
        'operator uplinks stay out of repository-defined project modules');
    }
  }
  for (const station of layout.stations.values()) assert.ok(station.members.every(m => !m.envId.startsWith('hermes')));
  for (const facility of [...layout.stations.values()].map(s => s.bounds).concat([...layout.environmentNodes.values()].map(n => n.hull))) {
    assert.equal(intersects(center.hull, facility), false);
  }
  for (const { card } of center.operators) {
    assert.ok(card.x >= center.hull.x && card.y >= center.hull.y);
    assert.ok(card.x + card.w <= center.hull.x + center.hull.w && card.y + card.h <= center.hull.y + center.hull.h);
  }
  assert.ok(layout.bounds.y <= center.hull.y);
});
