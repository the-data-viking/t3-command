import assert from 'node:assert/strict';
import test from 'node:test';
import { CrewMotion, doorState } from './crew-motion';
import type { GameState } from "../store";
import { computeFleetLayout, roomAt, route, type CrewLayout, type Point, type RoomKind, type StationLayout } from './layout';

function station(): StationLayout {
  return {
    key: 'test', name: 'Test', members: [], interior: { x: 0, y: 0, w: 288, h: 192 },
    hull: [], consoles: [], archived: 0, settledHidden: 0, port: { x: 0, y: 0 },
    nameplate: { x: 0, y: 0 }, bounds: { x: 0, y: 0, w: 288, h: 192 },
    rooms: {
      terminal: { kind: 'terminal', rect: { x: 0, y: 0, w: 96, h: 64 } },
      files: { kind: 'files', rect: { x: 96, y: 0, w: 96, h: 64 } },
      comms: { kind: 'comms', rect: { x: 192, y: 0, w: 96, h: 64 } },
      bridge: { kind: 'bridge', rect: { x: 0, y: 64, w: 288, h: 64 } },
      quarters: { kind: 'quarters', rect: { x: 0, y: 128, w: 192, h: 64 } },
      archive: { kind: 'archive', rect: { x: 192, y: 128, w: 96, h: 64 } },
    },
    doors: [
      { x: 48, y: 64, vertical: false, rooms: ['terminal', 'bridge'] },
      { x: 144, y: 64, vertical: false, rooms: ['files', 'bridge'] },
      { x: 240, y: 64, vertical: false, rooms: ['comms', 'bridge'] },
      { x: 96, y: 32, vertical: true, rooms: ['terminal', 'files'] },
      { x: 192, y: 32, vertical: true, rooms: ['files', 'comms'] },
      { x: 96, y: 128, vertical: false, rooms: ['quarters', 'bridge'] },
      { x: 240, y: 128, vertical: false, rooms: ['archive', 'bridge'] },
      { x: 192, y: 160, vertical: true, rooms: ['quarters', 'archive'] },
    ],
    workstations: { terminal: { x: 64, y: 56 }, files: { x: 160, y: 56 }, comms: { x: 256, y: 56 } },
  };
}
const crew: CrewLayout = { key: 'crew', envId: 'env', threadId: 'thread', stationKey: 'test', color: 0,
  home: { x: 144, y: 104 }, homeRoom: 'bridge', sleeping: false };
const center = (s: StationLayout, kind: RoomKind) => {
  const r = s.rooms[kind]!.rect;
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
};

/** Independently sample segments: each wall crossing must hit a connecting door. */
function checkCrossings(s: StationLayout, from: RoomKind, start: Point, points: Point[]) {
  let current = start;
  let room = from;
  for (const next of points) {
    assert.ok(current.x === next.x || current.y === next.y, 'Axis-aligned walk');
    const length = Math.abs(current.x - next.x) + Math.abs(current.y - next.y);
    for (let step = 1; step <= Math.ceil(length); step++) {
      const t = Math.min(step / length, 1);
      const p = { x: current.x + (next.x - current.x) * t, y: current.y + (next.y - current.y) * t };
      const nextRoom = roomAt(s, p, room);
      if (nextRoom !== room) {
        assert.ok(s.doors.some(d => d.rooms.includes(room) && d.rooms.includes(nextRoom)
          && (d.vertical ? p.y === d.y && Math.abs(p.x - d.x) <= 1 : p.x === d.x && Math.abs(p.y - d.y) <= 1)),
        `Wall crossing ${room} → ${nextRoom} must use its door`);
        room = nextRoom;
      }
    }
    current = next;
  }
}

test('all 36 room-pair routes cross only real doors and reach the target', () => {
  const s = station();
  for (const from of Object.keys(s.rooms) as RoomKind[]) for (const to of Object.keys(s.rooms) as RoomKind[]) {
    const start = center(s, from), target = center(s, to);
    const points = route(s, from, to, target, start);
    checkCrossings(s, from, start, points);
    assert.deepEqual(points.at(-1) ?? start, target);
  }
});
test('adjacent chambers use their side doors in both directions', () => {
  const s = station();
  for (const [a, b] of [['terminal', 'files'], ['files', 'comms'], ['quarters', 'archive']] as const) {
    for (const [from, to] of [[a, b], [b, a]]) {
      const points = route(s, from, to, center(s, to), center(s, from));
      assert.ok(points.every(p => p.y === center(s, from).y));
    }
  }
});
test('disconnected rooms cannot fall back to walking through a wall', () => {
  const s = station(); s.doors = [];
  assert.deepEqual(route(s, 'terminal', 'files', center(s, 'files'), center(s, 'terminal')), []);
});
test('retargeting uses the actual room instead of a stale departure room', () => {
  const s = station(), start = { x: 104, y: 32 }, target = center(s, 'comms');
  const points = route(s, 'terminal', 'comms', target, start);
  checkCrossings(s, 'files', start, points);
  assert.ok(points.every(p => p.x >= start.x && p.y === 32));
});
test('initial crew and first activity hydration place immediately without walking', () => {
  const s = station(), motion = new CrewMotion(crew);
  motion.step(crew, s, { room: 'bridge', point: crew.home }, 0, 100);
  motion.hydrate();
  motion.step(crew, s, { room: 'comms', point: s.workstations.comms }, 0, 100);
  assert.deepEqual(motion.pos, s.workstations.comms); assert.equal(motion.room, 'comms'); assert.equal(motion.moving, false);
});
test('seat reshuffles snap rather than drift', () => {
  const s = station(), motion = new CrewMotion(crew);
  motion.step(crew, s, { room: 'bridge', point: crew.home }, 0, 100);
  const moved = { ...crew, home: { x: 200, y: 104 } };
  motion.step(moved, s, { room: 'bridge', point: moved.home }, 0, 100);
  assert.deepEqual(motion.pos, moved.home); assert.equal(motion.moving, false); assert.equal(motion.arrived, true);
});
test('settling walks to quarters through the door, and waking walks back to the seat', () => {
  const s = station(), motion = new CrewMotion(crew);
  motion.step(crew, s, { room: 'bridge', point: crew.home }, 0, 100);
  const sleeper = { ...crew, home: { x: 48, y: 168 }, homeRoom: 'quarters' as const, sleeping: true };
  motion.step(sleeper, s, { room: 'quarters', point: sleeper.home }, 0, 100);
  assert.deepEqual(motion.pos, crew.home, 'sets off from the seat rather than appearing in the bunk');
  assert.equal(motion.arrived, false);
  const walked: Point[] = [];
  for (let i = 0; i < 60 && !motion.arrived; i++) { motion.step(sleeper, s, { room: 'quarters', point: sleeper.home }, 0.05, 100); walked.push({ ...motion.pos }); }
  assert.deepEqual(motion.pos, sleeper.home); assert.equal(motion.room, 'quarters'); assert.equal(motion.arrived, true);
  // Frame samples cut corners, so check each room change happens beside a connecting door.
  let room: RoomKind = 'bridge';
  for (const p of walked) {
    const next = roomAt(s, p, room);
    if (next !== room) assert.ok(s.doors.some(d => d.rooms.includes(room) && d.rooms.includes(next) && Math.hypot(d.x - p.x, d.y - p.y) <= 6), `${room} → ${next} away from a door`);
    room = next;
  }
  motion.step(crew, s, { room: 'bridge', point: crew.home }, 0.05, 100);
  assert.equal(motion.moving, true, 'waking walks back');
});
test('settling while the rooms resize snaps into the bunk', () => {
  const s = station(), motion = new CrewMotion(crew);
  motion.step(crew, s, { room: 'bridge', point: crew.home }, 0, 100);
  const bigger = { ...s, rooms: { ...s.rooms, quarters: { ...s.rooms.quarters!, rect: { ...s.rooms.quarters!.rect, w: 224 } } } };
  const sleeper = { ...crew, home: { x: 48, y: 168 }, homeRoom: 'quarters' as const, sleeping: true };
  motion.step(sleeper, bigger, { room: 'quarters', point: sleeper.home }, 0, 100);
  assert.deepEqual(motion.pos, sleeper.home); assert.equal(motion.arrived, true);
});
test('live activity changes walk, track crossings mid-route, and safely retarget', () => {
  const s = station(), motion = new CrewMotion(crew);
  motion.step(crew, s, { room: 'terminal', point: center(s, 'terminal') }, 0, 100);
  motion.step(crew, s, { room: 'files', point: center(s, 'files') }, 0.6, 100);
  assert.equal(motion.room, 'files'); assert.equal(motion.moving, true);
  const start = { ...motion.pos };
  motion.step(crew, s, { room: 'comms', point: center(s, 'comms') }, 0.1, 100);
  assert.ok(motion.pos.x > start.x); assert.equal(motion.pos.y, 32);
  motion.step(crew, s, { room: 'comms', point: center(s, 'comms') }, 5, 100);
  assert.deepEqual(motion.pos, center(s, 'comms')); assert.equal(motion.room, 'comms');
});

test('real fleet layouts expose side doors and valid routes for every generated room', () => {
  const active = { id: 'awake', projectId: 'project', createdAt: '2026-01-01', updatedAt: '2026-01-01', session: { status: 'idle' }, latestTurn: null, latestUserMessageAt: '2026-01-01' };
  const state = { envs: { env: {
    summary: { id: 'env', addedAt: '2026-01-01' },
    projects: { project: { id: 'project', title: 'Project', workspaceRoot: '/project' } },
    threads: {
      awake: active,
      asleep: { ...active, id: 'asleep', settledAt: '2026-01-02' },
      archive: { ...active, id: 'archive', session: null, latestUserMessageAt: null },
    },
  } } } as unknown as GameState;
  const s = [...computeFleetLayout(state).stations.values()][0];
  assert.equal(Object.keys(s.rooms).length, 6);
  assert.equal(s.doors.filter(door => door.vertical).length, 5);
  for (const from of Object.keys(s.rooms) as RoomKind[]) for (const to of Object.keys(s.rooms) as RoomKind[]) {
    const start = center(s, from), target = center(s, to);
    const points = route(s, from, to, target, start);
    checkCrossings(s, from, start, points);
    assert.deepEqual(points.at(-1) ?? start, target);
  }
});
test('room geometry changes place active crew without animating from the old station', () => {
  const s = station(), motion = new CrewMotion(crew);
  motion.step(crew, s, { room: 'files', point: s.workstations.files }, 0, 100);
  const expanded = { ...s, rooms: { ...s.rooms, files: { ...s.rooms.files!, rect: { ...s.rooms.files!.rect, w: 128 } } } };
  const target = { x: 180, y: 56 };
  motion.step(crew, expanded, { room: 'files', point: target }, 0, 100);
  assert.deepEqual(motion.pos, target); assert.equal(motion.moving, false);
});
test('doors open for crew walking through them and close once nobody is near', () => {
  const s = station(), motion = new CrewMotion(crew);
  motion.step(crew, s, { room: 'bridge', point: crew.home }, 0, 100);
  motion.step(crew, s, { room: 'files', point: center(s, 'files') }, 0, 100);
  const door = s.doors.find(d => d.rooms.includes('files') && d.rooms.includes('bridge'))!;
  const states = new Set<string>();
  for (let i = 0; i < 40 && !motion.arrived; i++) {
    motion.step(crew, s, { room: 'files', point: center(s, 'files') }, 0.02, 100);
    states.add(doorState(motion.moving ? Math.hypot(motion.pos.x - door.x, motion.pos.y - door.y) : Infinity));
  }
  assert.deepEqual([...states].sort(), ['closed', 'half', 'open']);
  assert.equal(doorState(Infinity), 'closed', 'a crew member standing still never holds a door open');
});
