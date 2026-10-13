import assert from 'node:assert/strict';
import test from 'node:test';
import { RenderLoop } from './render-loop';

function harness(draw: (dt: number) => boolean) {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  const loop = new RenderLoop(draw, callback => { frames.set(++id, callback); return id; }, id => { frames.delete(id); });
  const advance = (now: number) => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
  };
  return { loop, frames, advance };
}

test('default animation APIs retain their Window receiver when scheduling and cancelling', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  let draws = 0;
  const browser = {
    requestAnimationFrame(callback: FrameRequestCallback) {
      if (this !== browser) throw new TypeError('Illegal invocation');
      frames.set(++id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) {
      if (this !== browser) throw new TypeError('Illegal invocation');
      frames.delete(id);
    },
  };
  const globals = { window: browser, requestAnimationFrame: browser.requestAnimationFrame, cancelAnimationFrame: browser.cancelAnimationFrame };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  try {
    const loop = new RenderLoop(() => { draws++; return true; });
    loop.invalidate();
    assert.equal(frames.size, 1);
    const callback = frames.get(id)!;
    frames.clear();
    callback(0);
    assert.equal(draws, 1);
    assert.equal(frames.size, 1);
    loop.setVisible(false);
    assert.equal(frames.size, 0);
    loop.setVisible(true);
    assert.equal(frames.size, 1);
    loop.destroy();
    assert.equal(frames.size, 0);
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('idle maps draw once, sleep, and coalesce new invalidations', () => {
  let draws = 0;
  const h = harness(() => { draws++; return false; });
  h.loop.invalidate(); h.loop.invalidate(); h.loop.invalidate();
  assert.equal(h.frames.size, 1);
  h.advance(0);
  assert.equal(draws, 1);
  assert.equal(h.frames.size, 0);
  h.advance(1000);
  assert.equal(draws, 1);
  h.loop.invalidate();
  h.advance(2000);
  assert.equal(draws, 2);
  assert.equal(h.frames.size, 0);
});

test('busy maps stay at 30 FPS on 60, 120 and 144 Hz displays', () => {
  for (const hz of [60, 120, 144]) {
    let draws = 0;
    const h = harness(() => { draws++; return true; });
    h.loop.invalidate();
    for (let n = 0; n < hz * 3; n++) h.advance(n * 1000 / hz);
    assert.ok(draws >= 89 && draws <= 91, `${hz} Hz produced ${draws} draws in 3 seconds`);
    h.loop.destroy();
    assert.equal(h.frames.size, 0);
  }
});

test('hidden maps ignore updates and resume without catching up hidden time', () => {
  const deltas: number[] = [];
  const h = harness(dt => { deltas.push(dt); return true; });
  h.loop.invalidate(); h.advance(0);
  h.loop.setVisible(false);
  h.loop.invalidate(); h.advance(60_000);
  assert.equal(deltas.length, 1);
  assert.equal(h.frames.size, 0);
  h.loop.setVisible(true); h.advance(120_000);
  assert.equal(deltas.length, 2);
  assert.ok(deltas[1] <= 1 / 30);
  h.loop.destroy(); h.loop.invalidate();
  assert.equal(h.frames.size, 0);
});

test('idle wake and slow frames keep movement deltas bounded', () => {
  const deltas: number[] = [];
  let animated = false;
  const h = harness(dt => { deltas.push(dt); return animated; });
  h.loop.invalidate(); h.advance(0);
  animated = true;
  h.loop.invalidate(); h.advance(120_000); h.advance(240_000);
  assert.ok(deltas[1] <= 1 / 30);
  assert.ok(deltas[2] <= 0.1);
});

test('an ambient draw keeps the loop alive at the low rate, and input cuts the wait short', () => {
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, () => void>();
  let id = 0, timerId = 0, draws = 0;
  const loop = new RenderLoop(() => { draws++; return 'ambient'; },
    callback => { frames.set(++id, callback); return id; }, id => { frames.delete(id); }, 30, 8,
    { set: (callback, ms) => { assert.equal(ms, 125); timers.set(++timerId, callback); return timerId; }, clear: (id) => { timers.delete(id as number); } });
  const advance = (now: number) => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(now); };
  loop.invalidate();
  advance(0);
  assert.equal(draws, 1);
  assert.equal(frames.size, 0, 'no full-rate frame is requested');
  assert.equal(timers.size, 1, 'an ambient tick is scheduled');
  [...timers.values()][0]();
  timers.clear();
  assert.equal(frames.size, 1, 'the ambient tick requests a frame');
  advance(200);
  assert.equal(draws, 2);
  // Input arrives while an ambient tick is pending: draw on the next frame instead of waiting.
  loop.invalidate();
  assert.equal(timers.size, 0);
  assert.equal(frames.size, 1);
  loop.destroy();
});
