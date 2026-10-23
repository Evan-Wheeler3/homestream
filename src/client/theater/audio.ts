// The theater's sounds, made on the spot with the Web Audio API (no sound
// files): footsteps, popcorn popping, the cash register, crunching and
// slurping, the countdown and arcade bleeps. Quiet, and they can be muted.

export type Sound =
  | 'step'
  | 'jump'
  | 'land'
  | 'pop'
  | 'register'
  | 'crunch'
  | 'slurp'
  | 'beep'
  | 'go'
  | 'blip'
  | 'coin'
  | 'over'
  | 'toss'
  | 'ticket';

const MUTE_KEY = 'wh-theater-muted';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let muted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
})();

/** Browsers only allow sound after a tap or key press: call this from one. */
export function unlockAudio() {
  if (ctx || typeof window === 'undefined') {
    void ctx?.resume().catch(() => undefined);
    return;
  }
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.35;
  master.connect(ctx.destination);
  noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
}

export function isMuted() {
  return muted;
}

export function setMuted(next: boolean) {
  muted = next;
  if (master) master.gain.value = next ? 0 : 0.35;
  try {
    localStorage.setItem(MUTE_KEY, next ? '1' : '0');
  } catch {
    // Remembered for this visit only.
  }
}

function tone(
  freq: number,
  start: number,
  length: number,
  type: OscillatorType,
  gain: number,
  to?: number,
) {
  if (!ctx || !master) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  if (to) o.frequency.exponentialRampToValueAtTime(to, start + length);
  g.gain.setValueAtTime(gain, start);
  g.gain.exponentialRampToValueAtTime(0.0001, start + length);
  o.connect(g).connect(master);
  o.start(start);
  o.stop(start + length + 0.02);
}

function noise(
  start: number,
  length: number,
  gain: number,
  filter: number,
  q = 1,
  sweepTo?: number,
) {
  if (!ctx || !master || !noiseBuffer) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.setValueAtTime(filter, start);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, start + length);
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, start);
  g.gain.exponentialRampToValueAtTime(0.0001, start + length);
  src.connect(f).connect(g).connect(master);
  src.start(start, Math.random() * 0.3);
  src.stop(start + length + 0.02);
}

export function play(sound: Sound) {
  if (!ctx || muted) return;
  const t = ctx.currentTime;
  switch (sound) {
    case 'step':
      noise(t, 0.06, 0.25, 180 + Math.random() * 80, 2);
      break;
    case 'jump':
      tone(220, t, 0.12, 'square', 0.05, 440);
      break;
    case 'land':
      noise(t, 0.08, 0.35, 120, 1.5);
      break;
    case 'pop':
      noise(t, 0.03, 0.18, 1800 + Math.random() * 1200, 4);
      break;
    case 'register':
      tone(1318, t, 0.08, 'square', 0.06);
      tone(1760, t + 0.09, 0.25, 'square', 0.06);
      noise(t + 0.02, 0.15, 0.12, 4000, 1);
      break;
    case 'crunch':
      for (let i = 0; i < 4; i++) noise(t + i * 0.05, 0.05, 0.3, 900 + Math.random() * 1500, 3);
      break;
    case 'slurp':
      noise(t, 0.35, 0.25, 500, 6, 1600);
      noise(t + 0.15, 0.25, 0.15, 900, 8, 2200);
      break;
    case 'beep':
      tone(880, t, 0.15, 'sine', 0.12);
      break;
    case 'go':
      tone(1320, t, 0.4, 'sine', 0.12);
      break;
    case 'blip':
      tone(660, t, 0.05, 'square', 0.05);
      break;
    case 'coin':
      tone(988, t, 0.07, 'square', 0.06);
      tone(1319, t + 0.07, 0.2, 'square', 0.06);
      break;
    case 'over':
      tone(440, t, 0.18, 'square', 0.06, 220);
      tone(220, t + 0.2, 0.35, 'square', 0.06, 110);
      break;
    case 'toss':
      noise(t, 0.12, 0.2, 300, 1, 120);
      break;
    case 'ticket':
      for (let i = 0; i < 5; i++) tone(2400, t + i * 0.03, 0.02, 'square', 0.03);
      break;
  }
}
