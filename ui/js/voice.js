// The coach's voice: natural Kokoro voices (per coach), with Windows speech as an opt-in fallback.
import { invoke } from './api.js';
import { settings } from './settings.js';
import { COACHES } from './coaches.js';

let audio = null;
export const voiceLog = [];
window.__voiceLog = voiceLog;
let token = 0;
let kokoroReady = null; // null = unknown
let askedForVoice = false;
const listeners = new Set();
const cache = new Map(); // key -> Promise<base64 wav>

export function onSpeaking(f) {
  listeners.add(f);
}
function setSpeaking(v) {
  listeners.forEach((f) => f(v));
}

export function coachVoice(id = settings.coach) {
  return (COACHES[id] || COACHES.maya).voice;
}

export async function kokoroInstalled(refresh = false) {
  if (kokoroReady === null || refresh) {
    const st = await invoke('kokoro_status').catch(() => ({ installed: false }));
    kokoroReady = !!st.installed;
  }
  return kokoroReady;
}

// ------------------------------------------------------------ text preparation
const PIECE = { K: 'King', Q: 'Queen', R: 'Rook', B: 'Bishop', N: 'Knight' };

/** Turn SAN into something a voice can read naturally. */
export function sanToSpeech(san) {
  if (!san) return '';
  let s = san.replace(/[!?]+$/, '');
  const mate = s.endsWith('#');
  const check = s.endsWith('+');
  s = s.replace(/[+#]$/, '');
  let out;
  if (s === 'O-O') out = 'castles kingside';
  else if (s === 'O-O-O') out = 'castles queenside';
  else {
    const m = s.match(/^([KQRBN])?([a-h])?([1-8])?(x)?([a-h][1-8])(=([QRBN]))?$/);
    if (!m) out = s;
    else {
      const [, piece, df, dr, cap, to, , promo] = m;
      const parts = [];
      if (piece) parts.push(PIECE[piece]);
      else if (cap && df) parts.push(df.toUpperCase());
      if (piece && (df || dr)) parts.push((df || '').toUpperCase() + (dr || ''));
      if (cap) parts.push('takes');
      parts.push(to.toUpperCase());
      if (promo) parts.push('promotes to ' + PIECE[promo]);
      out = parts.join(' ');
    }
  }
  if (mate) out += ', checkmate';
  else if (check) out += ', check';
  return out;
}

/** Replace SAN tokens inside a sentence with spoken versions. */
export function speechText(text) {
  return String(text || '')
    .replace(/\b(O-O-O|O-O)([+#]?)/g, (m) => sanToSpeech(m))
    .replace(/\b([KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)(?=[\s.,!?:;)]|$)/g, (m) => sanToSpeech(m))
    .replace(/\+(\d+(\.\d+)?)/g, 'plus $1')
    .replace(/\s+/g, ' ')
    .trim();
}

const CLASS_WORDS = 'best|brilliant|great|excellent|good|forced|a book move|book|an inaccuracy|inaccurate|a mistake|a miss|a blunder';
/** The coach never reads out the move classification, only the explanation. */
export function stripClassification(text) {
  let t = String(text || '');
  t = t.replace(/^\s*(Great find!|A brilliant sacrifice!|Brilliant!)\s*/i, '');
  // Whole sentences like "Re4 was best." or "Kg2 is a mistake."
  t = t.replace(new RegExp(`[^.!?]*\\b(?:is|was)\\s+(?:${CLASS_WORDS})\\b[^.!?]*[.!?]\\s*`, 'gi'), '');
  return t.replace(/\s+/g, ' ').trim();
}

/** Split into sentences so the first one can start playing right away. */
function sentences(spoken) {
  const raw = spoken.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
  const out = [];
  for (const s of raw) {
    if (out.length && out[out.length - 1].split(' ').length < 3) out[out.length - 1] += ' ' + s;
    else out.push(s);
  }
  return out.filter((s) => s.trim());
}

// ------------------------------------------------------------ synthesis + cache
let busy = 0; // foreground synth requests in flight
function synth(sentence, voiceId = coachVoice()) {
  const key = voiceId + '|' + settings.voiceRate + '|' + sentence;
  if (!cache.has(key)) {
    const p = invoke('kokoro_speak', { voice: voiceId, text: sentence, speed: settings.voiceRate });
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    if (cache.size > 600) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}
const isCached = (sentence) => cache.has(coachVoice() + '|' + settings.voiceRate + '|' + sentence);

// Background pre-generation queue (one sentence at a time, yields to live speech).
let queue = [];
let working = false;
async function pump() {
  if (working) return;
  working = true;
  while (queue.length) {
    if (busy > 0) {
      await new Promise((r) => setTimeout(r, 60));
      continue;
    }
    const s = queue.shift();
    if (isCached(s)) continue;
    try {
      await synth(s);
    } catch {}
  }
  working = false;
}

/** Pre-generate text so it plays instantly later. `front` puts it first in line. */
export async function prefetch(texts, { front = false } = {}) {
  if (!settings.voiceOn || settings.voiceEngine !== 'kokoro') return;
  if (!(await kokoroInstalled())) return;
  const list = (Array.isArray(texts) ? texts : [texts]).flatMap((t) => sentences(speechText(stripClassification(t))));
  const fresh = list.filter((s) => !isCached(s));
  queue = front ? [...fresh, ...queue.filter((s) => !fresh.includes(s))] : [...queue, ...fresh.filter((s) => !queue.includes(s))];
  pump();
}

export function clearPrefetch() {
  queue = [];
}

// ------------------------------------------------------------ playback
export function stop() {
  token++;
  try {
    window.speechSynthesis?.cancel();
  } catch {}
  if (audio) {
    audio.pause();
    audio = null;
  }
  setSpeaking(false);
}

function playB64(b64, my) {
  return new Promise((resolve) => {
    if (my !== token) return resolve(false);
    audio = new Audio('data:audio/wav;base64,' + b64);
    audio.volume = Math.min(1, settings.voiceVolume);
    audio.onended = () => resolve(true);
    audio.onerror = () => resolve(false);
    audio.play().catch(() => resolve(false));
  });
}

export async function speak(text, { force = false, voice: voiceId, raw = false } = {}) {
  if (!force && !settings.voiceOn) return;
  stop();
  const my = token;
  const spoken = speechText(raw ? text : stripClassification(text));
  if (!spoken) return;

  if (settings.voiceEngine !== 'system') {
    if (!(await kokoroInstalled())) {
      if (!askedForVoice && window.app?.requireVoice) {
        askedForVoice = true;
        window.app.requireVoice();
      }
      return;
    }
    const parts = sentences(spoken);
    const vid = voiceId || coachVoice();
    setSpeaking(true);
    const fg = (sentence) => {
      const p = synth(sentence, vid);
      busy++;
      p.finally(() => busy--).catch(() => {});
      return p;
    };
    try {
      // Request sentence n+1 while sentence n plays.
      let next = fg(parts[0]);
      for (let i = 0; i < parts.length; i++) {
        const b64 = await next;
        if (my !== token) return;
        next = i + 1 < parts.length ? fg(parts[i + 1]) : null;
        voiceLog.push({ at: Math.round(performance.now()), token: my, cur: token, text: parts[i].slice(0, 40) });
        if (voiceLog.length > 80) voiceLog.shift();
        const ok = await playB64(b64, my);
        if (!ok || my !== token) return;
      }
    } catch (e) {
      console.warn('voice failed', e);
    } finally {
      if (my === token) setSpeaking(false);
    }
    return;
  }

  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(spoken);
  const v = bestSystemVoice();
  if (v) u.voice = v;
  u.rate = settings.voiceRate;
  u.pitch = settings.voicePitch;
  u.volume = Math.min(1, settings.voiceVolume);
  u.onstart = () => my === token && setSpeaking(true);
  u.onend = () => my === token && setSpeaking(false);
  u.onerror = () => my === token && setSpeaking(false);
  window.speechSynthesis.speak(u);
}

// ------------------------------------------------------------ Windows voices (fallback)
export function systemVoices() {
  return (window.speechSynthesis?.getVoices() || []).filter((v) => /^en/i.test(v.lang) || /english/i.test(v.name));
}

export function bestSystemVoice() {
  const vs = systemVoices();
  if (settings.systemVoice) {
    const v = vs.find((x) => x.name === settings.systemVoice);
    if (v) return v;
  }
  const rank = (v) => (/natural/i.test(v.name) ? 40 : 0) + (/online/i.test(v.name) ? 20 : 0) + (/en-US/i.test(v.lang) ? 5 : 0);
  return vs.sort((a, b) => rank(b) - rank(a))[0] || null;
}

if (window.speechSynthesis) window.speechSynthesis.getVoices();
