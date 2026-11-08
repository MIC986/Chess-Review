// Synthesised board sounds (no external audio files needed).
import { settings } from './settings.js';

let ctx = null;
function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function noiseBuffer(c, dur) {
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  return buf;
}

// A short "wooden" knock: filtered noise + a damped low sine.
function knock(t, { freq = 1900, q = 1.1, body = 210, gain = 0.9, dur = 0.07 } = {}) {
  const c = ac();
  const vol = (settings.volume ?? 0.7) * gain;
  const out = c.createGain();
  out.gain.value = vol;
  out.connect(c.destination);

  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, dur);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = q;
  const ng = c.createGain();
  ng.gain.setValueAtTime(0.9, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(bp).connect(ng).connect(out);
  src.start(t);

  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(body, t);
  osc.frequency.exponentialRampToValueAtTime(body * 0.55, t + 0.09);
  const og = c.createGain();
  og.gain.setValueAtTime(0.55, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
  osc.connect(og).connect(out);
  osc.start(t);
  osc.stop(t + 0.12);
}

function tone(t, f, dur, { type = 'sine', gain = 0.25, attack = 0.01 } = {}) {
  const c = ac();
  const o = c.createOscillator();
  o.type = type;
  o.frequency.value = f;
  const g = c.createGain();
  const vol = (settings.volume ?? 0.7) * gain;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export function play(kind) {
  if (!settings.sound) return;
  try {
    const c = ac();
    const t = c.currentTime + 0.005;
    switch (kind) {
      case 'move':
        knock(t);
        break;
      case 'capture':
        knock(t, { freq: 2600, q: 0.8, body: 260, gain: 1.0, dur: 0.05 });
        knock(t + 0.045, { freq: 1500, q: 1.2, body: 170, gain: 0.8, dur: 0.07 });
        break;
      case 'castle':
        knock(t);
        knock(t + 0.11, { freq: 1700, body: 190, gain: 0.8 });
        break;
      case 'check':
        knock(t, { freq: 2200, body: 240 });
        tone(t + 0.01, 880, 0.18, { type: 'triangle', gain: 0.12 });
        break;
      case 'promote':
        knock(t);
        tone(t + 0.02, 660, 0.12, { type: 'triangle', gain: 0.12 });
        tone(t + 0.1, 990, 0.18, { type: 'triangle', gain: 0.12 });
        break;
      case 'end':
        tone(t, 523.25, 0.5, { type: 'triangle', gain: 0.16 });
        tone(t + 0.12, 659.25, 0.5, { type: 'triangle', gain: 0.16 });
        tone(t + 0.24, 783.99, 0.7, { type: 'triangle', gain: 0.16 });
        break;
      case 'correct':
        tone(t, 784, 0.16, { type: 'sine', gain: 0.22 });
        tone(t + 0.09, 1175, 0.3, { type: 'sine', gain: 0.22 });
        break;
      case 'wrong':
        tone(t, 220, 0.22, { type: 'sawtooth', gain: 0.06 });
        tone(t + 0.11, 185, 0.26, { type: 'sawtooth', gain: 0.06 });
        break;
      case 'click':
        knock(t, { freq: 3200, body: 400, gain: 0.35, dur: 0.03 });
        break;
      case 'brilliant':
        [784, 988, 1175, 1568].forEach((f, i) => tone(t + i * 0.07, f, 0.35, { type: 'sine', gain: 0.13 }));
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
