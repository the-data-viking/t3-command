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

test('shared projects have directly attached nodes for each participating environment',()=>{
  const layout=computeFleetLayout(fixture());
  assert.equal(layout.stations.size,2);
  assert.equal(layout.environmentNodes.size,4); // three project memberships plus unassigned environment
  const occupied=[...layout.stations.values()].map(s=>s.bounds);
  for(const node of layout.environmentNodes.values()){
    const station=layout.stations.get(node.stationKey);
    if(station){
      assert.ok(station.members.some(m=>m.envId===node.envId&&m.projectId===node.projectId));
      assert.equal(node.links.length,1);
      assert.equal(node.links[0].stationKey,station.key);
      assert.equal(node.links[0].from.y,node.hull.y);
      assert.equal(node.links[0].to.y,station.bounds.y+station.bounds.h);
      assert.ok(node.links[0].to.x>=station.bounds.x&&node.links[0].to.x<=station.bounds.x+station.bounds.w);
    }else assert.equal(node.links.length,0);
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
