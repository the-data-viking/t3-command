// Synthesized sound effects (WebAudio), so there are no audio assets to ship. Everything goes
// through one master gain (the volume setting). Repeats and bursts are thinned so a reconnect or a
// wave of finished turns doesn't play ten alarms on top of each other.

import { useGame } from "../store";

let ctx: AudioContext | undefined;
let master: GainNode | undefined;

function audio(): { ac: AudioContext; out: GainNode } | undefined {
  const { muted, volume } = useGame.getState();
  if (muted || volume <= 0) return undefined;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    if (!master) { master = ctx.createGain(); master.connect(ctx.destination); }
    master.gain.setValueAtTime(volume, ctx.currentTime);
    return { ac: ctx, out: master };
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
  const a = audio();
  if (!a) return;
  const { ac, out } = a;
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
    osc.connect(gain).connect(out);
    osc.start(now + n.at);
    osc.stop(now + n.at + n.dur + 0.02);
  }
}

export type SoundName = "select" | "building" | "order" | "recruit" | "done" | "alert" | "question" | "error" | "deny";

/** Announcements that want your attention; they take turns instead of overlapping. */
const ANNOUNCE: Partial<Record<SoundName, number>> = { alert: 4, question: 3, error: 2, done: 1 };
/** The same sound again within this long is dropped. */
const REPEAT_MS = 350;
/** Announcements are at least this far apart; a more urgent one can cut in early. */
const ANNOUNCE_GAP_MS = 900;

export interface GateState { last: Partial<Record<SoundName, number>>; announcedAt: number; announcedRank: number }

export function newGate(): GateState {
  return { last: {}, announcedAt: -Infinity, announcedRank: 0 };
}

/** Whether a sound should play now, recording it if so. */
export function admit(gate: GateState, name: SoundName, now: number): boolean {
  if (now - (gate.last[name] ?? -Infinity) < REPEAT_MS) return false;
  const rank = ANNOUNCE[name];
  if (rank !== undefined) {
    const busy = now - gate.announcedAt < ANNOUNCE_GAP_MS;
    if (busy && rank <= gate.announcedRank) return false;
    gate.announcedAt = now;
    gate.announcedRank = rank;
  }
  gate.last[name] = now;
  return true;
}

const gate = newGate();

const SOUNDS: Record<SoundName, Note[]> = {
  select: [{ freq: 660, at: 0, dur: 0.06, gain: 0.04 }],
  building: [{ freq: 330, at: 0, dur: 0.08, type: "triangle", gain: 0.08 }],
  order: [
    { freq: 523, at: 0, dur: 0.07 },
    { freq: 784, at: 0.07, dur: 0.1 },
  ],
  recruit: [
    { freq: 392, at: 0, dur: 0.08, type: "triangle", gain: 0.08 },
    { freq: 523, at: 0.08, dur: 0.08, type: "triangle", gain: 0.08 },
    { freq: 659, at: 0.16, dur: 0.16, type: "triangle", gain: 0.08 },
  ],
  done: [
    { freq: 523, at: 0, dur: 0.1, type: "triangle", gain: 0.08 },
    { freq: 659, at: 0.1, dur: 0.1, type: "triangle", gain: 0.08 },
    { freq: 784, at: 0.2, dur: 0.1, type: "triangle", gain: 0.08 },
    { freq: 1047, at: 0.3, dur: 0.22, type: "triangle", gain: 0.08 },
  ],
  // Approval: an urgent klaxon, the one sound that means "blocked until you act".
  alert: [
    { freq: 880, at: 0, dur: 0.12, gain: 0.05 },
    { freq: 660, at: 0.14, dur: 0.12, gain: 0.05 },
    { freq: 880, at: 0.28, dur: 0.12, gain: 0.05 },
  ],
  // Question: a softer rising "hm?", inviting rather than alarming.
  question: [
    { freq: 587, at: 0, dur: 0.1, type: "triangle", gain: 0.08 },
    { freq: 880, at: 0.12, dur: 0.2, type: "triangle", gain: 0.08, slideTo: 988 },
  ],
  error: [{ freq: 220, at: 0, dur: 0.35, type: "sawtooth", gain: 0.05, slideTo: 110 }],
  deny: [{ freq: 300, at: 0, dur: 0.12, type: "sawtooth", gain: 0.04, slideTo: 200 }],
};

function sound(name: SoundName): () => void {
  return () => { if (admit(gate, name, performance.now())) play(SOUNDS[name]); };
}

export const sfx = Object.fromEntries((Object.keys(SOUNDS) as SoundName[]).map((name) => [name, sound(name)])) as Record<SoundName, () => void>;

/** A short preview at the current volume (the volume slider), bypassing the repeat gate. */
export function previewVolume(): void {
  play(SOUNDS.select);
}
