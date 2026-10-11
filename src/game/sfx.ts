// Synthesized sound effects (WebAudio), so there are no audio assets to ship.

import { useGame } from "../store";

let ctx: AudioContext | undefined;

function audio(): AudioContext | undefined {
  if (useGame.getState().muted) return undefined;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return undefined;
  }
}

interface Note {
  freq: number;
  at: number; // seconds from now
  dur: number;
  type?: OscillatorType;
  gain?: number;
  slideTo?: number;
}

function play(notes: Note[]): void {
  const ac = audio();
  if (!ac) return;
  const now = ac.currentTime;
  for (const n of notes) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = n.type ?? "square";
    osc.frequency.setValueAtTime(n.freq, now + n.at);
    if (n.slideTo) osc.frequency.exponentialRampToValueAtTime(n.slideTo, now + n.at + n.dur);
    const peak = n.gain ?? 0.06;
    gain.gain.setValueAtTime(0, now + n.at);
    gain.gain.linearRampToValueAtTime(peak, now + n.at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + n.at + n.dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(now + n.at);
    osc.stop(now + n.at + n.dur + 0.02);
  }
}

export const sfx = {
  select: () => play([{ freq: 660, at: 0, dur: 0.06, gain: 0.04 }]),
  building: () => play([{ freq: 330, at: 0, dur: 0.08, type: "triangle", gain: 0.08 }]),
  order: () =>
    play([
      { freq: 523, at: 0, dur: 0.07 },
      { freq: 784, at: 0.07, dur: 0.1 },
    ]),
  recruit: () =>
    play([
      { freq: 392, at: 0, dur: 0.08, type: "triangle", gain: 0.08 },
      { freq: 523, at: 0.08, dur: 0.08, type: "triangle", gain: 0.08 },
      { freq: 659, at: 0.16, dur: 0.16, type: "triangle", gain: 0.08 },
    ]),
  done: () =>
    play([
      { freq: 523, at: 0, dur: 0.1, type: "triangle", gain: 0.08 },
      { freq: 659, at: 0.1, dur: 0.1, type: "triangle", gain: 0.08 },
      { freq: 784, at: 0.2, dur: 0.1, type: "triangle", gain: 0.08 },
      { freq: 1047, at: 0.3, dur: 0.22, type: "triangle", gain: 0.08 },
    ]),
  alert: () =>
    play([
      { freq: 880, at: 0, dur: 0.12, gain: 0.05 },
      { freq: 660, at: 0.14, dur: 0.12, gain: 0.05 },
      { freq: 880, at: 0.28, dur: 0.12, gain: 0.05 },
    ]),
  error: () => play([{ freq: 220, at: 0, dur: 0.35, type: "sawtooth", gain: 0.05, slideTo: 110 }]),
  deny: () => play([{ freq: 300, at: 0, dur: 0.12, type: "sawtooth", gain: 0.04, slideTo: 200 }]),
};
