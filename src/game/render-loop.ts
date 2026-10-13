/**
 * A capped, demand-driven map loop. Live data keeps flowing while rendering is paused. While
 * something moves it draws at full rate; when only ambient life remains (deck lights, sleepers,
 * twinkling stars) the draw returns "ambient" and the loop ticks at a low rate instead of stopping.
 */
export type DrawResult = boolean | "ambient";

export interface Timer {
  set: (callback: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
}

export class RenderLoop {
  private frame?: number;
  private timer?: unknown;
  private lastFrame?: number;
  private lastUpdate?: number;
  private visible = true;
  private destroyed = false;
  private readonly draw: (dt: number) => DrawResult;
  private readonly request: (callback: FrameRequestCallback) => number;
  private readonly cancel: (id: number) => void;
  private readonly fps: number;
  private readonly ambientFps: number;
  private readonly timers: Timer;

  constructor(
    draw: (dt: number) => DrawResult,
    // Native animation APIs require Window as their receiver, even when stored on a loop.
    request: (callback: FrameRequestCallback) => number = callback => window.requestAnimationFrame(callback),
    cancel: (id: number) => void = id => window.cancelAnimationFrame(id),
    fps = 30,
    ambientFps = 8,
    timers: Timer = { set: (callback, ms) => setTimeout(callback, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) },
  ) {
    this.draw = draw;
    this.request = request;
    this.cancel = cancel;
    this.fps = fps;
    this.ambientFps = ambientFps;
    this.timers = timers;
  }

  /** Draw on the next frame (input and data changes call this; it cuts an ambient wait short). */
  invalidate = (): void => {
    if (!this.visible || this.destroyed) return;
    if (this.timer !== undefined) { this.timers.clear(this.timer); this.timer = undefined; }
    if (this.frame === undefined) this.frame = this.request(this.tick);
  };

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.invalidate();
    else this.stop();
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
  }

  private stop(): void {
    if (this.frame !== undefined) this.cancel(this.frame);
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.frame = this.timer = undefined;
    this.lastFrame = this.lastUpdate = undefined;
  }

  private tick = (now: number): void => {
    this.frame = undefined;
    const interval = 1000 / this.fps;
    const elapsed = this.lastFrame === undefined ? interval : now - this.lastFrame;
    if (elapsed + 0.1 < interval) {
      this.invalidate();
      return;
    }
    this.lastFrame = this.lastFrame === undefined ? now : this.lastFrame + Math.floor((elapsed + 0.1) / interval) * interval;
    // Idle/hidden time must never become a giant crew movement step on wake.
    const dt = this.lastUpdate === undefined ? 1 / this.fps : Math.min(0.1, (now - this.lastUpdate) / 1000);
    this.lastUpdate = now;
    const result = this.draw(dt);
    if (result === true) this.invalidate();
    else if (result === "ambient") this.timer = this.timers.set(() => { this.timer = undefined; this.invalidate(); }, 1000 / this.ambientFps);
    else this.lastUpdate = undefined;
  };
}
