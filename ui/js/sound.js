// Board sounds, synthesised on the fly (no audio files): a physically modelled wooden piece
// knock for moves, a sharper double knock for captures, and soft marimba chimes for events.
import { settings } from './settings.js';

let ctx = null;
let master = null;
function ac() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Gentle bus compression keeps overlapping hits clean.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 3;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    master = ctx.createGain();
    master.connect(comp).connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  master.gain.value = settings.volume ?? 0.7;
  return ctx;
}

let noise = null;
function noiseBuf(c) {
  if (noise) return noise;
  const len = Math.floor(c.sampleRate * 0.05);
  noise = c.createBuffer(1, len, c.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return noise;
}

/** A decaying sine partial. */
function partial(t, f, amp, decay, dest) {
  const c = ctx;
  const o = c.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(f, t);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(amp, t + 0.0015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + decay + 0.02);
}

/** Short filtered noise burst: the "contact" of wood on wood. */
function click(t, { freq = 3800, q = 0.9, amp = 0.5, dur = 0.012 } = {}, dest) {
  const c = ctx;
  const src = c.createBufferSource();
  src.buffer = noiseBuf(c);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(amp, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp).connect(g).connect(dest);
  src.start(t);
  src.stop(t + dur + 0.01);
}

/**
 * A wooden piece set down on a wooden board. The board resonates with a few inharmonic
 * modes (like a small wood block); the piece adds a crisp contact click.
 */
function wood(t, { pitch = 1, gain = 1, bright = 1, decay = 1 } = {}) {
  const c = ac();
  const out = c.createGain();
  out.gain.value = gain;
  const tone = c.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 5200 * bright;
  tone.Q.value = 0.4;
  tone.connect(out).connect(master);
  const f0 = 560 * pitch;
  partial(t, f0, 0.55, 0.075 * decay, tone);
  partial(t, f0 * 2.31, 0.32, 0.045 * decay, tone);
  partial(t, f0 * 3.93, 0.16, 0.028 * decay, tone);
  partial(t, f0 * 0.5, 0.22, 0.05 * decay, tone); // low thump of the board
  click(t, { freq: 3400 * bright, amp: 0.55 * bright, dur: 0.01 }, tone);
}

/** A soft mallet note (marimba-like) for chimes. */
function mallet(t, f, { gain = 0.32, decay = 0.9 } = {}) {
  const c = ac();
  const out = c.createGain();
  out.gain.value = gain;
  out.connect(master);
  partial(t, f, 0.7, decay, out);
  partial(t, f * 4, 0.12, decay * 0.25, out);
  partial(t, f * 9.9, 0.04, decay * 0.08, out);
  click(t, { freq: 2400, amp: 0.05, dur: 0.008 }, out);
}

export function play(kind) {
  if (!settings.sound) return;
  try {
    const c = ac();
    const t = c.currentTime + 0.004;
    switch (kind) {
      case 'move':
        wood(t);
        break;
      case 'capture':
        // The captured piece is knocked away, then the capturing piece lands harder.
        wood(t, { pitch: 1.18, gain: 0.55, bright: 1.25, decay: 0.6 });
        wood(t + 0.028, { pitch: 1.05, gain: 1.1, bright: 1.15 });
        break;
      case 'castle':
        wood(t, { pitch: 0.97 });
        wood(t + 0.085, { pitch: 1.08, gain: 0.85 });
        break;
      case 'check':
        wood(t, { pitch: 1.04 });
        mallet(t + 0.02, 1318.5, { gain: 0.16, decay: 0.32 });
        mallet(t + 0.02, 1975.5, { gain: 0.07, decay: 0.22 });
        break;
      case 'promote':
        wood(t);
        mallet(t + 0.05, 1046.5, { gain: 0.18, decay: 0.35 });
        mallet(t + 0.13, 1568, { gain: 0.18, decay: 0.45 });
        break;
      case 'start':
        mallet(t, 784, { gain: 0.26, decay: 0.7 });
        mallet(t + 0.12, 1046.5, { gain: 0.26, decay: 0.9 });
        break;
      case 'end':
        mallet(t, 1046.5, { gain: 0.24, decay: 0.8 });
        mallet(t + 0.13, 784, { gain: 0.24, decay: 0.8 });
        mallet(t + 0.26, 1046.5, { gain: 0.2, decay: 1.1 });
        mallet(t + 0.26, 1318.5, { gain: 0.14, decay: 1.1 });
        break;
      case 'correct':
        mallet(t, 1046.5, { gain: 0.26, decay: 0.45 });
        mallet(t + 0.09, 1568, { gain: 0.26, decay: 0.7 });
        break;
      case 'wrong':
        mallet(t, 392, { gain: 0.3, decay: 0.35 });
        mallet(t + 0.11, 349.2, { gain: 0.3, decay: 0.5 });
        break;
      case 'illegal':
        wood(t, { pitch: 0.55, gain: 0.7, bright: 0.6, decay: 0.8 });
        break;
      case 'click':
        click(t, { freq: 4200, amp: 0.25, dur: 0.008 }, master);
        break;
      case 'brilliant':
        [1046.5, 1318.5, 1568, 2093].forEach((f, i) => mallet(t + i * 0.075, f, { gain: 0.17, decay: 0.7 }));
        break;
    }
  } catch {}
}

export function soundForMove(m) {
  if (!m) return 'move';
  if (m.mate) return 'end';
  if (m.check) return 'check';
  if (m.promotion) return 'promote';
  if (m.castle) return 'castle';
  if (m.capture) return 'capture';
  return 'move';
}
