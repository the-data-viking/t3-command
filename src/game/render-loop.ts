/** A capped, demand-driven map loop. Live data keeps flowing while rendering is paused. */
export class RenderLoop {
  private frame?: number;
  private lastFrame?: number;
  private lastUpdate?: number;
  private visible = true;
  private destroyed = false;
  private readonly draw: (dt: number) => boolean;
  private readonly request: (callback: FrameRequestCallback) => number;
  private readonly cancel: (id: number) => void;
  private readonly fps: number;

  constructor(
    draw: (dt: number) => boolean,
    // Native animation APIs require Window as their receiver, even when stored on a loop.
    request: (callback: FrameRequestCallback) => number = callback => window.requestAnimationFrame(callback),
    cancel: (id: number) => void = id => window.cancelAnimationFrame(id),
    fps = 30,
  ) {
    this.draw = draw;
    this.request = request;
    this.cancel = cancel;
    this.fps = fps;
  }

  invalidate = (): void => {
    if (this.visible && !this.destroyed && this.frame === undefined) this.frame = this.request(this.tick);
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
    this.frame = undefined;
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
    if (this.draw(dt)) this.invalidate();
    else this.lastUpdate = undefined;
  };
}
