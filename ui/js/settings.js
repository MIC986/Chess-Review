import { invoke } from './api.js';

export const BOARD_THEMES = {
  green: { name: 'Green', light: '#ebecd0', dark: '#739552' },
  brown: { name: 'Brown', light: '#f0d9b5', dark: '#b58863' },
  blue: { name: 'Blue', light: '#dee3e6', dark: '#8ca2ad' },
  ice: { name: 'Icy Sea', light: '#d9e4e8', dark: '#7a9db2' },
  purple: { name: 'Purple', light: '#efefef', dark: '#8877b7' },
  coral: { name: 'Coral', light: '#b1e4b9', dark: '#70a2a3' },
  dusk: { name: 'Dusk', light: '#ccb7ae', dark: '#706677' },
  wheat: { name: 'Wheat', light: '#eaf0ce', dark: '#bbbe8e' },
  sand: { name: 'Sandcastle', light: '#e3c16f', dark: '#b88b4a' },
  tournament: { name: 'Tournament', light: '#ebece8', dark: '#316549' },
  marine: { name: 'Marine', light: '#9dacff', dark: '#6f74d2' },
  gray: { name: 'Graphite', light: '#c8c8c8', dark: '#7a7a7a' },
  night: { name: 'Night', light: '#9ea8b8', dark: '#4b5568' },
  cherry: { name: 'Cherry', light: '#f2d7c9', dark: '#b45c4c' },
};

export const PIECE_SETS = {
  cburnett: 'Classic',
  staunty: 'Staunty',
  maestro: 'Maestro',
  merida: 'Merida',
  cardinal: 'Cardinal',
  tatiana: 'Tatiana',
  california: 'California',
  chessnut: 'Chessnut',
  alpha: 'Alpha',
  companion: 'Companion',
  fantasy: 'Fantasy',
  celtic: 'Celtic',
};

export const ACCENTS = {
  green: ['#81b64c', '#a3d160', '#45753c'],
  blue: ['#3d8fd6', '#5aa6ea', '#245b8c'],
  purple: ['#8f6bd6', '#a786ea', '#5a3f94'],
  orange: ['#e8913a', '#f5a956', '#9a5a1c'],
  red: ['#d9534f', '#ea6f6b', '#8e2e2b'],
  teal: ['#26b3a0', '#3fcab7', '#17786b'],
};

export const STRENGTH = {
  fast: { label: 'Fast', depth: 12 },
  balanced: { label: 'Balanced', depth: 16 },
  deep: { label: 'Deep', depth: 20 },
  max: { label: 'Maximum', depth: 24 },
};

const cores = navigator.hardwareConcurrency || 8;

export const DEFAULTS = {
  username: '',
  boardTheme: 'green',
  pieceSet: 'cburnett',
  coords: 'inside',
  showLegal: true,
  highlightLast: true,
  animMs: 180,
  showArrows: true,
  showBadges: true,
  classHighlight: true,
  evalBar: true,
  figurine: true,
  showClocks: true,
  autoFlip: true,
  uiTheme: 'default',
  accent: 'green',
  uiScale: 1,
  sound: true,
  volume: 0.7,
  voiceOn: true,
  voiceEngine: 'kokoro',
  kokoroVoice: 'heart',
  settingsVersion: 4,
  systemVoice: '',
  neuralVoice: 'en_US-lessac-medium',
  voiceRate: 1.0,
  voicePitch: 1.0,
  voiceVolume: 1.0,
  speakBest: false,
  coachName: 'Coach',
  coachAvatar: 'knight',
  coach: 'leo',
  engineStrength: 'balanced',
  depth: 16,
  threads: 1,
  instances: Math.max(1, Math.min(8, Math.floor(cores / 2))),
  hash: 64,
  reviewMultipv: 2,
  liveLines: 3,
  liveThreads: Math.max(1, Math.min(4, Math.floor(cores / 4))),
  customEngine: '',
  autoplayMs: 1600,
  retryDepth: 16,
  showBestInBubble: true,
  confetti: true,
};

let state = { ...DEFAULTS };
const subs = new Set();
let saveTimer = null;

export const settings = new Proxy(
  {},
  {
    get: (_, k) => state[k],
    set: (_, k, v) => {
      state[k] = v;
      persist();
      apply();
      subs.forEach((f) => f(k, v));
      return true;
    },
  },
);

export function onSettings(f) {
  subs.add(f);
  return () => subs.delete(f);
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => invoke('settings_save', { settings: state }).catch(() => {}), 250);
}

export async function loadSettings() {
  try {
    const s = await invoke('settings_load');
    state = { ...DEFAULTS, ...(s || {}) };
    if (((s && s.settingsVersion) || 1) < 2) {
      // v2: natural Kokoro voice by default; coach reads only the explanation.
      state.voiceEngine = 'kokoro';
      state.speakBest = false;
      state.settingsVersion = 2;
      persist();
    }
    if ((state.settingsVersion || 1) < 3) {
      // v3: three coaches with their own natural voices.
      state.voiceEngine = 'kokoro';
      state.coach = state.coach || 'leo';
      state.voicePromptSeen = false;
      state.settingsVersion = 3;
      persist();
    }
    if ((state.settingsVersion || 1) < 4) {
      // v4: Leo is the default coach.
      state.coach = 'leo';
      state.settingsVersion = 4;
      persist();
    }
  } catch {
    state = { ...DEFAULTS };
  }
  apply();
}

export function engineOpts() {
  return {
    depth: state.depth,
    threads: state.threads,
    hash: state.hash,
    instances: state.instances,
    multipv: state.reviewMultipv,
  };
}

export function pieceUrl(color, role, set = state.pieceSet) {
  return `pieces/${set}/${color}${role.toUpperCase()}.svg`;
}

export function apply() {
  const r = document.documentElement;
  const t = BOARD_THEMES[state.boardTheme] || BOARD_THEMES.green;
  r.style.setProperty('--sq-light', t.light);
  r.style.setProperty('--sq-dark', t.dark);
  r.style.setProperty('--anim', `${state.animMs}ms`);
  const a = ACCENTS[state.accent] || ACCENTS.green;
  r.style.setProperty('--accent', a[0]);
  r.style.setProperty('--accent-hover', a[1]);
  r.style.setProperty('--accent-shadow', a[2]);
  r.style.setProperty('--ui-scale', state.uiScale);
  if (state.uiTheme && state.uiTheme !== 'default') r.dataset.ui = state.uiTheme;
  else delete r.dataset.ui;
}
