// Sound effects and music, synthesised with the Web Audio API (no audio files). Nothing is
// created until the first user gesture, as browsers require.

import { settings } from "./settings.js";

let ctx: AudioContext | null = null;
let sfxBus: GainNode, musicBus: GainNode, master: GainNode;
let noiseBuf: AudioBuffer;
let musicTimer: number | undefined;
let musicStep = 0;
let nextNoteTime = 0;
let musicOn = false;
let intensity = 0; // 0 normal, 1 sudden death (faster hats, alarm)

export function unlockAudio(): void {
  if (ctx) { if (ctx.state === "suspended") void ctx.resume(); return; }
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.connect(ctx.destination);
  sfxBus = ctx.createGain();
  musicBus = ctx.createGain();
  // a gentle compressor keeps chain explosions from clipping
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  sfxBus.connect(comp).connect(master);
  musicBus.connect(master);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  applyVolumes();
}

export function applyVolumes(): void {
  if (!ctx) return;
  sfxBus.gain.value = settings.sfx * 0.9;
  musicBus.gain.value = settings.music * 0.32;
}

function now() { return ctx!.currentTime; }

function tone(freq: number, dur: number, type: OscillatorType, vol: number, at = 0, slideTo?: number, bus = sfxBus) {
  if (!ctx) return;
  const t = now() + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(bus);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur: number, vol: number, filterFreq: number, at = 0, type: BiquadFilterType = "lowpass", bus = sfxBus, sweepTo?: number) {
  if (!ctx) return;
  const t = now() + at;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(filterFreq, t);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(bus);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

let lastBoom = 0;

export const sfx = {
  place() { tone(180, 0.12, "triangle", 0.5, 0, 90); noise(0.06, 0.25, 900); },
  fuse() { noise(0.12, 0.05, 5000, 0, "highpass"); },
  explode(size = 1) {
    if (!ctx) return;
    // several blasts on one tick merge into one bigger boom
    const t = now();
    if (t - lastBoom < 0.03) return;
    lastBoom = t;
    noise(0.55 + size * 0.1, 0.7, 1800, 0, "lowpass", sfxBus, 120);
    tone(90, 0.45, "sine", 0.8, 0, 32);
    tone(55, 0.6, "sine", 0.5, 0.02, 28);
  },
  crate() { noise(0.18, 0.25, 2500, 0.02, "bandpass"); tone(220, 0.08, "square", 0.08, 0.02, 120); },
  pickup() { [660, 880, 1320].forEach((f, i) => tone(f, 0.1, "square", 0.12, i * 0.06)); },
  kick() { tone(300, 0.08, "triangle", 0.35, 0, 140); noise(0.05, 0.2, 2000); },
  death() { tone(520, 0.45, "sawtooth", 0.18, 0, 70); tone(390, 0.45, "square", 0.08, 0.05, 50); },
  count() { tone(660, 0.14, "square", 0.18); },
  go() { tone(990, 0.3, "square", 0.2); tone(1320, 0.3, "square", 0.12, 0.05); },
  drop() { tone(70, 0.2, "sine", 0.35, 0, 40); noise(0.12, 0.2, 600); },
  alarm() { for (let i = 0; i < 3; i++) { tone(880, 0.16, "square", 0.14, i * 0.32); tone(660, 0.16, "square", 0.14, i * 0.32 + 0.16); } },
  win() { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, i === 5 ? 0.5 : 0.14, "square", 0.16, i * 0.11)); },
  draw() { [523, 494, 466].forEach((f, i) => tone(f, 0.22, "triangle", 0.2, i * 0.18)); },
  click() { tone(1200, 0.04, "square", 0.06); },
};

// ---------------------------------------------------------------------------------------------
// music: an original, laid-back 8-bar loop. Bass, chord stabs and hats, scheduled ahead.

const BPM = 112;
const STEP = 60 / BPM / 4; // sixteenth notes
// chord roots (semitones from A2) and qualities for each bar
const BARS = [[0, "m"], [8, "M"], [3, "M"], [10, "M"], [0, "m"], [8, "M"], [5, "m"], [7, "M"]] as const;
const A2 = 110;
const semis = (n: number) => A2 * Math.pow(2, n / 12);

function scheduleStep(stepIndex: number, t: number) {
  if (!ctx) return;
  const bar = Math.floor(stepIndex / 16) % BARS.length;
  const s = stepIndex % 16;
  const [root, q] = BARS[bar];
  const third = q === "m" ? 3 : 4;
  const at = t - now();
  // bass: root on 1, octave pops
  if (s === 0 || s === 6 || s === 10) tone(semis(root - 12) * (s === 6 ? 2 : 1), STEP * 2.4, "triangle", 0.5, at, undefined, musicBus);
  // chord stabs on the off-beats
  if (s === 4 || s === 12) for (const n of [root, root + third, root + 7]) tone(semis(n + 12), STEP * 1.6, "square", 0.05, at, undefined, musicBus);
  // a little lead phrase every other bar
  if (bar % 2 === 1 && (s === 2 || s === 3 || s === 8)) tone(semis(root + 24 + (s === 8 ? 7 : third)), STEP * 1.2, "triangle", 0.08, at, undefined, musicBus);
  // hats; doubled in sudden death
  if (s % (intensity ? 1 : 2) === 0) noise(0.03, s % 4 === 2 ? 0.08 : 0.04, 7000, at, "highpass", musicBus);
  if (s === 8) noise(0.12, 0.18, 1800, at, "bandpass", musicBus);
}

function scheduler() {
  if (!ctx || !musicOn) return;
  while (nextNoteTime < now() + 0.12) {
    scheduleStep(musicStep++, nextNoteTime);
    nextNoteTime += intensity ? STEP * 0.88 : STEP;
  }
}

export function startMusic(): void {
  if (!ctx || musicOn) return;
  musicOn = true;
  nextNoteTime = now() + 0.05;
  musicStep = 0;
  musicTimer = window.setInterval(scheduler, 25);
}

export function stopMusic(): void {
  musicOn = false;
  if (musicTimer !== undefined) window.clearInterval(musicTimer);
  musicTimer = undefined;
}

export function setMusicIntensity(level: number): void {
  intensity = level;
}
