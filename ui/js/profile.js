// Profile Review page: looks at many of a player's games and explains how to improve.
import { invoke, listen, h, esc, toast, timeAgo } from './api.js';
import { icons, clsIcon } from './icons.js';
import { settings, pieceUrl } from './settings.js';
import { COACHES } from './coaches.js';
import { parseFen } from './board.js';
import { chesscomGame } from './home.js';
import * as voice from './voice.js';
import { buildReport, gameRecord, HOW, PHASE_NAME, TAGS } from './profile-stats.js';

const MODES = [
  ['all', 'All games', null],
  ['bullet', 'Bullet', 'bullet'],
  ['blitz', 'Blitz', 'bolt'],
  ['rapid', 'Rapid', 'timer'],
  ['daily', 'Daily', 'sun'],
];
const RANGES = [
  [1, 'Last month'],
  [3, 'Last 3 months'],
  [6, 'Last 6 months'],
  [12, 'Last year'],
  [0, 'All time'],
];
const DEEP = [
  [25, '25 games'],
  [50, '50 games'],
  [100, '100 games'],
  [200, '200 games'],
];
const QUALITY = [
  [10, 'Fast'],
  [12, 'Balanced'],
  [15, 'Deep'],
];
const CLS_COLOR = { brilliant: '--c-brilliant', great: '--c-great', best: '--c-best', excellent: '--c-excellent', good: '--c-good', book: '--c-book', inaccuracy: '--c-inaccuracy', mistake: '--c-mistake', miss: '--c-miss', blunder: '--c-blunder' };
const CLS_LABEL = { brilliant: 'Brilliant', great: 'Great', best: 'Best', excellent: 'Excellent', good: 'Good', book: 'Book', inaccuracy: 'Inaccuracy', mistake: 'Mistake', miss: 'Miss', blunder: 'Blunder' };

const fmtDate = (sec) => new Date(sec * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const resWord = { W: 'Won', D: 'Drew', L: 'Lost' };

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

function monthsBack(n) {
  const d = new Date();
  const total = d.getFullYear() * 12 + d.getMonth() - (n - 1);
  return `${Math.floor(total / 12)}/${String((total % 12) + 1).padStart(2, '0')}`;
}

// ------------------------------------------------------------ visual helpers
function miniBoard(fen, { flip = false, played, best, playedGood = false } = {}) {
  const map = parseFen(fen);
  const wrap = h('div', { class: 'pr-board' });
  const grid = h('div', { class: 'pr-sqs' });
  const hl = new Set([played?.slice(0, 2), played?.slice(2, 4)].filter(Boolean));
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const file = flip ? 7 - f : f;
      const rank = flip ? r + 1 : 8 - r;
      const sq = 'abcdefgh'[file] + rank;
      const dark = (file + rank) % 2 === 1;
      const cell = h('div', { class: 'pr-sq' + (dark ? ' d' : ' l') + (hl.has(sq) ? ' hl' : '') });
      const p = map.get(sq);
      if (p) cell.append(h('img', { src: pieceUrl(p[0], p[1]), alt: '', draggable: 'false' }));
      grid.append(cell);
    }
  }
  wrap.append(grid);
  const xy = (sq) => {
    const fi = 'abcdefgh'.indexOf(sq[0]);
    const ra = +sq[1];
    const x = flip ? 7 - fi : fi;
    const y = flip ? ra - 1 : 8 - ra;
    return [x + 0.5, y + 0.5];
  };
  const arrow = (uci, cls) => {
    if (!uci || uci.length < 4) return '';
    const [x1, y1] = xy(uci.slice(0, 2));
    const [x2, y2] = xy(uci.slice(2, 4));
    const len = Math.hypot(x2 - x1, y2 - y1);
    const k = (len - 0.32) / len;
    return `<line class="${cls}" x1="${x1}" y1="${y1}" x2="${x1 + (x2 - x1) * k}" y2="${y1 + (y2 - y1) * k}" marker-end="url(#ah-${cls})"/>`;
  };
  wrap.insertAdjacentHTML(
    'beforeend',
    `<svg class="pr-arrows" viewBox="0 0 8 8"><defs>
      <marker id="ah-bad" viewBox="0 0 10 10" refX="3" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker>
      <marker id="ah-good" viewBox="0 0 10 10" refX="3" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker>
    </defs>${arrow(best, 'good')}${arrow(played, playedGood ? 'good' : 'bad')}</svg>`,
  );
  return wrap;
}

function donut(wdl, size = 120) {
  const total = wdl.W + wdl.D + wdl.L || 1;
  const r = 15.915;
  let off = 25;
  const seg = (v, cls) => {
    const len = (v / total) * 100;
    const s = `<circle class="${cls}" cx="21" cy="21" r="${r}" fill="none" stroke-width="5.2" stroke-dasharray="${Math.max(0, len - 0.6)} ${100 - Math.max(0, len - 0.6)}" stroke-dashoffset="${off}"/>`;
    off -= len;
    return s;
  };
  return h('div', {
    class: 'pr-donut',
    style: { width: size + 'px', height: size + 'px' },
    html: `<svg viewBox="0 0 42 42"><circle cx="21" cy="21" r="${r}" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="5.2"/>${seg(wdl.W, 'w')}${seg(wdl.D, 'd')}${seg(wdl.L, 'l')}</svg>`,
  });
}

function bar(value, max = 100, cls = '') {
  return h('div', { class: 'pr-bar ' + cls }, h('i', { style: { width: `${Math.max(0, Math.min(100, (value / max) * 100))}%` } }));
}

function wdlBar(o) {
  const n = o.W + o.D + o.L || 1;
  return h('div', { class: 'pr-wdl' }, h('i', { class: 'w', style: { width: `${(o.W / n) * 100}%` } }), h('i', { class: 'd', style: { width: `${(o.D / n) * 100}%` } }), h('i', { class: 'l', style: { width: `${(o.L / n) * 100}%` } }));
}

function ratingChart(series) {
  const W = 640;
  const H = 170;
  const P = { l: 40, r: 10, t: 12, b: 22 };
  if (series.length < 2) return h('div', { class: 'pr-empty-chart' }, 'Not enough games for a chart');
  const xs = series.map((p) => p[0]);
  const ys = series.map((p) => p[1]);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  const pad = Math.max(10, (y1 - y0) * 0.12);
  y0 = Math.floor((y0 - pad) / 10) * 10;
  y1 = Math.ceil((y1 + pad) / 10) * 10;
  const x = (i) => P.l + (i / (series.length - 1)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - y0) / (y1 - y0)) * (H - P.t - P.b);
  const pts = series.map((p, i) => `${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`);
  const ticks = [y0, Math.round((y0 + y1) / 2), y1];
  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs><linearGradient id="prg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    ${ticks.map((t) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${P.l - 6}" y="${y(t) + 4}" class="lbl" text-anchor="end">${t}</text>`).join('')}
    <path d="M${pts[0]} L${pts.join(' L')} L${x(series.length - 1)},${H - P.b} L${P.l},${H - P.b} Z" fill="url(#prg)"/>
    <polyline points="${pts.join(' ')}" class="line"/>
    <text x="${P.l}" y="${H - 5}" class="lbl">${fmtDate(xs[0])}</text>
    <text x="${W - P.r}" y="${H - 5}" class="lbl" text-anchor="end">${fmtDate(xs[xs.length - 1])}</text>
    <circle class="dot" r="4" cx="-10" cy="-10"/>
  </svg>`;
  const el = h('div', { class: 'pr-chart', html: svg });
  const tip = h('div', { class: 'pr-tip' });
  el.append(tip);
  const dot = el.querySelector('.dot');
  el.addEventListener('mousemove', (e) => {
    const rect = el.getBoundingClientRect();
    const fx = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(series.length - 1, Math.round(((fx - P.l) / (W - P.l - P.r)) * (series.length - 1))));
    dot.setAttribute('cx', x(i));
    dot.setAttribute('cy', y(series[i][1]));
    tip.style.display = 'block';
    tip.style.left = `${(x(i) / W) * 100}%`;
    tip.style.top = `${(y(series[i][1]) / H) * 100}%`;
    tip.innerHTML = `<b>${series[i][1]}</b> · ${fmtDate(series[i][0])}`;
  });
  el.addEventListener('mouseleave', () => {
    tip.style.display = 'none';
    dot.setAttribute('cx', -10);
  });
  return el;
}

function accuracyChart(list, avgAcc, onPick) {
  const el = h('div', { class: 'pr-acc-chart' });
  const lineY = 100 - avgAcc;
  el.append(h('div', { class: 'avg-line', style: { top: `${lineY}%` } }, h('span', {}, `avg ${avgAcc}%`)));
  const bars = h('div', { class: 'bars' });
  list.forEach((g, i) =>
    bars.append(
      h(
        'button',
        { class: 'b ' + g.res, style: { height: `${Math.max(4, g.acc)}%`, animationDelay: `${Math.min(i, 60) * 8}ms` }, 'data-tip': `${g.acc}% · ${resWord[g.res]} vs ${g.opp} · ${fmtDate(g.end)}`, onclick: () => onPick(g) },
      ),
    ),
  );
  el.append(bars);
  return el;
}

function coachAvatar(big = false) {
  const c = COACHES[settings.coach] || COACHES.leo;
  return h('div', { class: 'coach-avatar' + (big ? ' big' : ''), style: { background: c.gradient } }, h('img', { src: pieceUrl('w', c.piece, 'cburnett'), alt: '' }));
}

// ====================================================================== page
export class ProfilePage {
  constructor(app) {
    this.app = app;
    this.el = h('div', { class: 'view-page pr-page' });
    this.user = settings.username || settings.lastSearch || '';
    this.mode = settings.profileMode || 'all';
    this.range = settings.profileRange ?? 3;
    this.deep = settings.profileDeep || 50;
    this.depth = settings.profileDepth || 12;
    this.state = 'idle';
    this.report = null;
    this.run = 0;
    this.unsubs = [];
    voice.onSpeaking((v) => this.el.querySelectorAll('.pr-coach .coach-avatar').forEach((a) => a.classList.toggle('talking', v)));
    this.render();
    if (this.user) this.loadSaved();
  }

  destroy() {
    voice.stop();
  }

  async loadSaved() {
    const saved = await invoke('profile_load', { username: this.user }).catch(() => null);
    if (saved && saved.report && this.state === 'idle') {
      this.report = saved.report;
      this.state = 'done';
      this.renderBody();
    }
  }

  // ---------------------------------------------------------------- controls
  render() {
    const input = h('input', { class: 'input', placeholder: 'chess.com username', value: this.user, spellcheck: 'false', onkeydown: (e) => e.key === 'Enter' && this.start() });
    this.input = input;
    const sel = (opts, cur, on) => h('select', { class: 'input', onchange: (e) => on(+e.target.value) }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === cur ? true : null }, l)));
    const modeChips = h('div', { class: 'seg pr-modes' });
    const drawModes = () => {
      modeChips.replaceChildren(
        ...MODES.map(([id, label, ico]) =>
          h('button', { class: this.mode === id ? 'on' : '', onclick: () => { this.mode = id; settings.profileMode = id; drawModes(); }, html: (ico ? icons[ico] : '') + `<span>${label}</span>` }),
        ),
      );
    };
    drawModes();
    this.runBtn = h('button', { class: 'btn primary', onclick: () => this.start(), html: `${icons.sparkle} Review profile` });
    const controls = h(
      'div',
      { class: 'pr-controls' },
      h('div', { class: 'pr-row' }, h('div', { class: 'input-wrap', html: icons.user }, input), this.runBtn),
      h(
        'div',
        { class: 'pr-row opts' },
        modeChips,
        h('label', { class: 'pr-opt' }, h('span', {}, 'Period'), sel(RANGES, this.range, (v) => { this.range = v; settings.profileRange = v; })),
        h('label', { class: 'pr-opt', 'data-tip': 'How many of your most recent games the engine checks move by move' }, h('span', {}, 'Engine checks'), sel(DEEP, this.deep, (v) => { this.deep = v; settings.profileDeep = v; })),
        h('label', { class: 'pr-opt' }, h('span', {}, 'Quality'), sel(QUALITY, this.depth, (v) => { this.depth = v; settings.profileDepth = v; })),
      ),
    );
    this.body = h('div', { class: 'pr-body' });
    this.el.replaceChildren(
      h(
        'div',
        { class: 'page-wrap pr-wrap' },
        h('div', { class: 'pr-head' }, h('div', {}, h('h1', {}, 'Profile Review'), h('p', {}, 'Your games, your patterns, and exactly what to work on next.')), controls),
        this.body,
      ),
    );
    this.renderBody();
  }

  renderBody() {
    const b = this.body;
    if (!b) return;
    b.replaceChildren();
    this.runBtn.disabled = this.state === 'loading' || this.state === 'analyzing';
    if (this.state === 'idle') b.append(this.introEl());
    else if (this.state === 'error') b.append(h('div', { class: 'pr-card pr-msg', html: `${icons.info}<h3>Something went wrong</h3><div>${esc(this.error)}</div>` }));
    else if (this.state === 'loading' || this.state === 'analyzing' || this.state === 'building') b.append(this.progressEl());
    else if (this.state === 'done' && this.report) this.renderReport(b, this.report);
  }

  introEl() {
    const feat = (ico, t, d) => h('div', { class: 'pr-feat' }, h('span', { html: icons[ico] }), h('b', {}, t), h('p', {}, d));
    return h(
      'div',
      { class: 'pr-card pr-intro' },
      h('div', { class: 'pr-intro-top' }, coachAvatar(true), h('div', {}, h('h2', {}, 'Find out what is really holding you back'), h('p', {}, 'Your coach goes through your recent games, checks every move with Stockfish and turns it into a clear picture of your play.'))),
      h(
        'div',
        { class: 'pr-feats' },
        feat('eye', 'Mistake patterns', 'Hanging pieces, missed tactics, king safety, and which of them costs you the most.'),
        feat('timer', 'Clock and habits', 'Time trouble, rushed moves, tilt after losses and your best time of day.'),
        feat('book', 'Openings', 'Which openings win you games and which leave you worse after move 10.'),
        feat('bulb', 'A training plan', 'The few things to work on that will gain you the most rating.'),
      ),
    );
  }

  progressEl() {
    const p = this.prog || {};
    const step = (id, label, sub) => {
      const order = ['loading', 'analyzing', 'building'];
      const cur = order.indexOf(this.state);
      const me = order.indexOf(id);
      const st = me < cur ? 'done' : me === cur ? 'now' : '';
      return h('div', { class: 'pr-step ' + st }, h('span', { class: 'dot', html: st === 'done' ? icons.check : '' }), h('div', {}, h('b', {}, label), sub ? h('small', {}, sub) : null));
    };
    const frac = this.state === 'loading' ? (p.months ? p.monthsDone / p.months : 0) : this.state === 'analyzing' ? (p.total ? p.done / p.total : 0) : 1;
    const eta = this.state === 'analyzing' && p.done - (p.d0 || 0) >= 2 && p.total > p.done ? Math.round(((performance.now() - p.t0) / (p.done - (p.d0 || 0))) * (p.total - p.done) / 1000) : null;
    const bar = h('div', { class: 'progress' }, h('i', { style: { width: `${Math.round(frac * 100)}%` } }));
    this.progBar = bar;
    this.progLabel = h('div', { class: 'pr-prog-label' }, this.progressText(eta));
    return h(
      'div',
      { class: 'pr-card pr-progress' },
      h('div', { class: 'pr-prog-top' }, coachAvatar(true), h('div', { class: 'grow' }, h('h2', {}, `Reviewing ${this.user}'s games`), this.progLabel, bar)),
      h('div', { class: 'pr-steps' }, step('loading', 'Collecting games', p.games ? `${p.games} games found` : null), step('analyzing', 'Checking every move', p.total ? `${p.done || 0} of ${p.total}` : null), step('building', 'Finding your patterns', null)),
      h('div', { class: 'pr-prog-foot' }, h('button', { class: 'btn ghost small', onclick: () => this.cancel() }, 'Cancel')),
    );
  }

  progressText(eta) {
    const p = this.prog || {};
    if (this.state === 'loading') return p.months ? `Loading games from chess.com · ${p.monthsDone} of ${p.months} months` : 'Contacting chess.com…';
    if (this.state === 'analyzing') return `Analyzing game ${Math.min(p.total, (p.done || 0) + 1)} of ${p.total}${eta != null ? ` · about ${eta < 60 ? eta + ' s' : Math.ceil(eta / 60) + ' min'} left` : ''}`;
    return 'Putting it all together…';
  }

  updateProgress() {
    if (!this.progBar || !this.body.contains(this.progBar)) return this.renderBody();
    const p = this.prog;
    const frac = this.state === 'analyzing' ? (p.total ? p.done / p.total : 0) : p.months ? p.monthsDone / p.months : 0;
    this.progBar.firstChild.style.width = `${Math.round(frac * 100)}%`;
    const eta = this.state === 'analyzing' && p.done - (p.d0 || 0) >= 2 && p.total > p.done ? Math.round(((performance.now() - p.t0) / (p.done - (p.d0 || 0))) * (p.total - p.done) / 1000) : null;
    this.progLabel.textContent = this.progressText(eta);
    const sub = this.body.querySelectorAll('.pr-step small');
    if (this.state === 'analyzing' && sub[1]) sub[1].textContent = `${p.done} of ${p.total}`;
  }

  cancel() {
    this.run++;
    invoke('profile_cancel').catch(() => {});
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.state = this.report ? 'done' : 'idle';
    this.renderBody();
  }

  // ---------------------------------------------------------------- pipeline
  async start() {
    const user = this.input.value.trim();
    if (!user) return this.input.focus();
    voice.stop();
    const run = ++this.run;
    this.user = user;
    this.state = 'loading';
    this.prog = { months: 0, monthsDone: 0 };
    this.renderBody();
    try {
      const [profile, archives] = await Promise.all([invoke('cc_profile', { username: user }), invoke('cc_archives', { username: user })]);
      if (run !== this.run) return;
      this.user = profile.username;
      this.input.value = profile.username;
      const cutoff = this.range ? monthsBack(this.range) : '0000/00';
      const months = archives.filter((m) => m >= cutoff);
      if (!months.length) throw `${profile.username} has no games in this period.`;
      this.prog.months = months.length;
      this.renderBody();
      const all = (
        await pool(months, 4, async (m) => {
          const gs = await invoke('cc_month', { username: profile.username, month: m }).catch(() => []);
          if (run === this.run) {
            this.prog.monthsDone++;
            this.updateProgress();
          }
          return gs;
        })
      ).flat();
      if (run !== this.run) return;
      const games = all.filter((g) => (!g.rules || g.rules === 'chess') && (this.mode === 'all' || g.timeClass === this.mode));
      const records = games.map((g) => gameRecord(g, profile.username)).filter(Boolean);
      if (!records.length) throw `No ${this.mode === 'all' ? '' : this.mode + ' '}games found for ${profile.username} in this period.`;
      this.prog.games = records.length;

      // Engine pass over the most recent games.
      const recent = [...records].sort((a, b) => b.end - a.end).filter((r) => r.moves >= 6).slice(0, this.deep);
      const digests = await this.analyze(run, recent);
      if (run !== this.run) return;
      this.state = 'building';
      this.renderBody();
      await new Promise((r) => setTimeout(r, 60));
      const rangeLabel = RANGES.find((r) => r[0] === this.range)?.[1] || '';
      const report = buildReport({ user: profile.username, profile, mode: this.mode, rangeLabel, records, digests });
      if (run !== this.run) return;
      this.report = report;
      this.state = 'done';
      invoke('profile_save', { username: profile.username, report: { report } }).catch(() => {});
      this.renderBody();
      this.el.scrollTop = 0;
      if (settings.voiceOn) setTimeout(() => voice.speak(report.coachText), 500);
    } catch (e) {
      if (run !== this.run) return;
      if (String(e) === 'engine-missing') {
        this.state = 'idle';
        this.renderBody();
        this.app.requireEngine(() => this.start());
        return;
      }
      this.state = 'error';
      this.error = String(e);
      this.renderBody();
    }
  }

  async analyze(run, recent) {
    const digests = new Map();
    if (!recent.length) return digests;
    this.state = 'analyzing';
    this.prog.total = recent.length;
    this.prog.done = 0;
    this.prog.t0 = performance.now();
    this.prog.d0 = 0;
    this.renderBody();
    return new Promise(async (resolve, reject) => {
      const done = () => {
        this.unsubs.forEach((u) => u());
        this.unsubs = [];
      };
      this.unsubs.push(
        await listen('profile-game', (p) => {
          if (p.run !== run) return;
          digests.set(p.digest.id, p.digest);
          this.prog.done = p.done;
          // Cached games arrive in a burst at the start; time the estimate from real work only.
          if (performance.now() - this.prog.t0 < 400) {
            this.prog.t0 = performance.now();
            this.prog.d0 = p.done;
          }
          this.updateProgress();
        }),
        await listen('profile-done', (p) => {
          if (p.run !== run) return;
          done();
          resolve(digests);
        }),
        await listen('profile-error', (p) => {
          if (p.run !== run) return;
          done();
          if (p.error === 'cancelled') resolve(digests);
          else reject(p.error);
        }),
      );
      invoke('profile_analyze', {
        run,
        games: recent.map((r) => ({ id: r.id, pgn: r.g.pgn })),
        depth: this.depth,
        workers: Math.max(1, settings.instances || 4),
        customEngine: settings.customEngine || null,
      }).catch((e) => {
        done();
        reject(e);
      });
    });
  }

  openExample(x, game) {
    if (!game) return;
    const g = chesscomGame(game, { viewer: this.report.user });
    g.startPly = x.idx != null ? x.idx + 1 : null;
    this.app.openReview(g);
  }

  // ---------------------------------------------------------------- report
  renderReport(b, R) {
    if (!R.games) {
      b.append(h('div', { class: 'pr-card pr-msg', html: `${icons.board}<h3>No games found</h3>` }));
      return;
    }
    const E = R.engine;
    const gameById = new Map((E?.list || []).map((x) => [x.id, x.g]));
    const sec = (title, sub, ...kids) => h('section', { class: 'pr-sec' }, h('div', { class: 'pr-sec-head' }, h('h2', {}, title), sub ? h('span', {}, sub) : null), ...kids);
    const card = (cls, ...kids) => h('div', { class: 'pr-card ' + cls }, ...kids);
    const stat = (label, value, note, cls = '') => h('div', { class: 'pr-stat ' + cls }, h('small', {}, label), h('b', {}, value), note ? h('span', {}, note) : null);

    // ---- hero
    const modeLbl = MODES.find((m) => m[0] === R.mode)?.[1] || 'All games';
    const change = R.rating.change;
    b.append(
      card(
        'pr-hero',
        h(
          'div',
          { class: 'pr-id' },
          R.avatar ? h('img', { class: 'avatar', src: R.avatar }) : h('div', { class: 'avatar avatar-fallback', style: { fontSize: '26px' } }, R.user[0].toUpperCase()),
          h(
            'div',
            {},
            h('div', { class: 'pname' }, R.title ? h('span', { class: 'title-badge' }, R.title) : null, R.user),
            h('div', { class: 'psub' }, `${modeLbl} · ${R.rangeLabel} · ${R.games} games`),
            h('div', { class: 'psub small' }, `Updated ${timeAgo(R.at)}`, ' · ', h('button', { class: 'link-btn', onclick: () => this.start() }, 'Refresh')),
          ),
        ),
        h(
          'div',
          { class: 'pr-hero-stats' },
          h(
            'div',
            { class: 'pr-score' },
            donut(R.wdl, 108),
            h('div', { class: 'pr-score-txt' }, h('b', {}, `${Math.round(R.score)}%`), h('small', {}, 'score')),
            h('div', { class: 'pr-legend' }, h('span', { class: 'w' }, `${R.wdl.W} won`), h('span', { class: 'd' }, `${R.wdl.D} drawn`), h('span', { class: 'l' }, `${R.wdl.L} lost`)),
          ),
          h(
            'div',
            { class: 'pr-kpis' },
            E ? stat('Accuracy', `${E.acc}%`, `${E.games} games checked`) : null,
            E ? stat('Plays like', `${E.estRating}`, 'based on accuracy') : null,
            stat(`${R.ratingClass[0].toUpperCase() + R.ratingClass.slice(1)} rating`, `${R.rating.last}`, change ? `${change > 0 ? '+' : '−'}${Math.abs(change)} in this period` : 'no change', change > 0 ? 'up' : change < 0 ? 'down' : ''),
            stat('Performance', `${R.performance}`, `avg. opponent ${R.avgOpp}`),
          ),
        ),
      ),
    );

    // ---- coach summary
    const c = COACHES[settings.coach] || COACHES.leo;
    const playBtn = h('button', { class: 'btn small', html: `${icons.speaker} Listen`, onclick: () => voice.speak(R.coachText, { force: true }) });
    b.append(card('pr-coach', h('div', { class: 'coach-col' }, coachAvatar(), h('div', { class: 'coach-name' }, c.name)), h('div', { class: 'bubble' }, h('p', {}, R.coachText), h('div', { class: 'pr-coach-act' }, playBtn))));

    // ---- focus areas
    if (R.focus?.length) {
      b.append(
        sec(
          'What to work on',
          'Ranked by how many points each one costs you',
          h('div', { class: 'pr-focus' }, ...R.focus.map((f, i) => this.focusCard(f, i, gameById))),
        ),
      );
    }
    if (R.strengths?.length) {
      b.append(
        sec(
          'Your strengths',
          null,
          h(
            'div',
            { class: 'pr-strengths' },
            ...R.strengths.map((s) => h('div', { class: 'pr-strength' }, h('span', { class: 'ico', html: icons[s.icon] || icons.star }), h('div', {}, h('b', {}, s.title), h('p', {}, s.detail)))),
          ),
        ),
      );
    }
    if (R.plan?.length) {
      b.append(
        sec(
          'Your training plan',
          null,
          card('pr-plan', ...R.plan.map((p, i) => h('div', { class: 'pr-plan-row' }, h('span', { class: 'n' }, i + 1), h('div', { class: 'grow' }, h('b', {}, p.text), p.from ? h('small', {}, `For: ${p.from}`) : null), h('span', { class: 'freq' }, p.freq)))),
        ),
      );
    }

    // ---- rating & accuracy
    const charts = h('div', { class: 'pr-grid two' });
    charts.append(card('pr-chart-card', h('div', { class: 'pr-card-title' }, `${R.ratingClass[0].toUpperCase() + R.ratingClass.slice(1)} rating`, h('span', {}, `peak ${R.rating.peak}`)), ratingChart(R.rating.series)));
    if (E) charts.append(card('pr-chart-card', h('div', { class: 'pr-card-title' }, 'Accuracy per game', h('span', {}, E.trend ? `${E.trend > 0 ? '+' : ''}${E.trend} trend` : 'click a bar to review')), accuracyChart(E.list, E.acc, (g) => this.openExample({}, g.g))));
    b.append(sec('Rating and accuracy', null, charts));

    // ---- engine sections
    if (E) {
      const ph = E.phases;
      const phaseCard = card(
        'pr-phases',
        h('div', { class: 'pr-card-title' }, 'Accuracy by phase'),
        ...['o', 'm', 'e'].map((k) =>
          h(
            'div',
            { class: 'pr-phase' },
            h('span', { class: 'nm' }, PHASE_NAME[k]),
            bar(ph[k].acc || 0, 100, ph[k].acc >= 85 ? 'good' : ph[k].acc >= 72 ? 'ok' : 'bad'),
            h('b', {}, ph[k].acc != null ? `${ph[k].acc}%` : '–'),
            h('small', {}, ph[k].n ? `${ph[k].errPerGame} err/game` : ''),
          ),
        ),
        h('div', { class: 'pr-foot-note' }, 'Errors are mistakes, misses and blunders, averaged per game.'),
      );
      const accRes = card(
        'pr-mini-stats',
        h('div', { class: 'pr-card-title' }, 'Accuracy by result'),
        h('div', { class: 'pr-three' }, stat('Wins', E.accWin ? `${E.accWin}%` : '–', null, 'w'), stat('Draws', E.accDraw ? `${E.accDraw}%` : '–', null, 'd'), stat('Losses', E.accLoss ? `${E.accLoss}%` : '–', null, 'l')),
        h('div', { class: 'pr-card-title', style: { marginTop: '16px' } }, 'Critical moments'),
        h(
          'div',
          { class: 'pr-three' },
          stat('Winning positions won', E.conv.rate != null ? `${E.conv.rate}%` : '–', E.conv.chances ? `${E.conv.W} of ${E.conv.chances}` : 'none yet'),
          stat('Lost positions saved', E.back.rate != null ? `${E.back.rate}%` : '–', E.back.chances ? `${E.back.saved} of ${E.back.chances}` : 'none yet'),
          stat('Mistakes punished', E.punish.rate != null ? `${E.punish.rate}%` : '–', E.punish.chances ? `${E.punish.ok} of ${E.punish.chances}` : 'none yet'),
        ),
      );
      b.append(sec('How you play', `${E.games} games checked move by move`, h('div', { class: 'pr-grid two' }, phaseCard, accRes)));

      // move quality per game
      const q = h('div', { class: 'pr-quality' });
      for (const k of ['brilliant', 'great', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'miss', 'blunder']) {
        const total = E.counts[k] || 0;
        const rare = total && E.perGame[k] < 0.1;
        q.append(h('div', { class: 'pr-q', style: { '--cc': `var(${CLS_COLOR[k]})` } }, h('span', { class: 'ico', html: clsIcon(k, 'cls-ico') }), h('b', {}, rare ? String(total) : String(E.perGame[k])), h('small', {}, CLS_LABEL[k] + (rare ? ' · total' : ''))));
      }
      // mistake anatomy
      const maxLost = Math.max(1, ...E.tagList.map((t) => t.lost));
      const anatomy = card(
        'pr-anatomy',
        h('div', { class: 'pr-card-title' }, 'Where your advantage goes', h('span', {}, 'share of win chances lost')),
        ...E.tagList
          .filter((t) => t.n)
          .slice(0, 8)
          .map((t) => h('div', { class: 'pr-tag' }, h('span', { class: 'nm' }, t.label), bar(t.lost, maxLost, 'g-' + t.group), h('b', {}, `${Math.round(t.share)}%`), h('small', {}, `${t.n}×`))),
        E.roleList.length ? h('div', { class: 'pr-foot-note' }, 'Pieces you lose most: ', E.roleList.slice(0, 4).map(([r, n]) => `${r} (${n})`).join(', ')) : null,
      );
      b.append(sec('Move quality', 'average per game', card('pr-q-card', q), anatomy));

      // biggest mistakes
      const ex = [];
      const seen = new Set();
      for (const x of E.examples) {
        if (seen.has(x.gid)) continue;
        seen.add(x.gid);
        ex.push(x);
        if (ex.length >= 6) break;
      }
      if (ex.length) b.append(sec('Your costliest moves', 'Click one to review that game', h('div', { class: 'pr-examples' }, ...ex.map((x) => this.exampleCard(x, gameById)))));
      if (E.greats?.length) b.append(sec('Moves to be proud of', null, h('div', { class: 'pr-examples' }, ...E.greats.slice(0, 3).map((x) => this.exampleCard(x, gameById, true)))));
    }

    // ---- results
    const howCard = (title, obj, cls) => {
      const total = Object.values(obj).reduce((a, b) => a + b, 0) || 1;
      const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]);
      return h(
        'div',
        { class: 'pr-how' },
        h('div', { class: 'pr-card-title' }, title),
        rows.length ? rows.map(([k, n]) => h('div', { class: 'pr-tag' }, h('span', { class: 'nm' }, HOW[k] || k), bar(n, total, cls), h('b', {}, `${Math.round((n / total) * 100)}%`), h('small', {}, String(n)))) : h('div', { class: 'pr-foot-note' }, 'None'),
      );
    };
    const colorRow = (label, o, cls) => h('div', { class: 'pr-color-row' }, h('span', { class: 'sqc ' + cls }), h('span', { class: 'nm' }, label), wdlBar(o), h('b', {}, `${Math.round(o.score)}%`), h('small', {}, `${o.n} games`));
    const strengthRows = R.vsStrength
      .filter((x) => x.n)
      .map((x) => h('div', { class: 'pr-vs' }, h('span', { class: 'nm' }, x.label), h('div', { class: 'pr-bar dual' }, h('i', { style: { width: `${x.score}%` } }), h('em', { style: { left: `${x.exp}%` }, 'data-tip': `Expected ${Math.round(x.exp)}%` })), h('b', {}, `${Math.round(x.score)}%`), h('small', {}, `${x.n}`)));
    b.append(
      sec(
        'Results',
        null,
        h(
          'div',
          { class: 'pr-grid two' },
          card('', h('div', { class: 'pr-card-title' }, 'By color'), colorRow('White', R.white, 'w'), colorRow('Black', R.black, 'b'), h('div', { class: 'pr-card-title', style: { marginTop: '18px' } }, 'Against opponents rated…', h('span', {}, 'score · ▏expected')), ...strengthRows),
          card('pr-hows', howCard('How you win', R.winHow, 'good'), howCard('How you lose', R.lossHow, 'bad')),
        ),
      ),
    );

    // ---- openings
    const openTable = (title, list) =>
      card(
        'pr-open',
        h('div', { class: 'pr-card-title' }, title),
        list.length
          ? list.map((o) => {
              const ew = E?.openFams?.find((x) => x.name === o.name && x.color === (title.includes('White') ? 'w' : 'b'));
              return h('div', { class: 'pr-open-row' }, h('div', { class: 'nm' }, h('b', {}, o.name), h('small', {}, `${o.n} games${ew ? ` · ${Math.round(ew.win)}% win chance after move 10` : ''}`)), wdlBar(o), h('b', { class: 'sc ' + (o.score >= 55 ? 'up' : o.score < 45 ? 'down' : '') }, `${Math.round(o.score)}%`));
            })
          : h('div', { class: 'pr-foot-note' }, 'No games'),
      );
    const firstLine = [
      R.whiteFirst.length ? `As White you open with ${R.whiteFirst.map((x) => `${x.mv} (${x.n}, ${Math.round(x.score)}%)`).join(', ')}.` : '',
      R.blackVs.length ? `As Black you answer ${R.blackVs.map((x) => `1.${x.mv} with ${x.reply || '…'} (${Math.round(x.score)}%)`).join(', ')}.` : '',
    ].filter(Boolean).join(' ');
    b.append(sec('Openings', firstLine || null, h('div', { class: 'pr-grid two' }, openTable('As White', R.openWhite), openTable('As Black', R.openBlack))));

    // ---- time & habits
    const T = E?.time;
    const timeCard = card(
      'pr-mini-stats',
      h('div', { class: 'pr-card-title' }, 'Clock'),
      h(
        'div',
        { class: 'pr-three' },
        stat('Lost on time', String(R.clock.timeoutLosses), R.wdl.L ? `${Math.round((R.clock.timeoutLosses / R.wdl.L) * 100)}% of losses` : ''),
        stat('Games in time trouble', String(R.clock.lowGames), R.clock.lowGames ? `${Math.round(R.clock.lowScore)}% score in them` : 'under 10% of your clock'),
        stat('Clock used by move 10', R.clock.openingTime ? `${Math.round(R.clock.openingTime)}%` : '–', 'of your starting time'),
      ),
      T && T.low.n ? h('div', { class: 'pr-three', style: { marginTop: '12px' } }, stat('Errors, plenty of time', T.norm.badRate != null ? `${T.norm.badRate}%` : '–', 'of moves'), stat('Errors when low', `${T.low.badRate}%`, `${T.low.n} moves`, T.low.badRate > (T.norm.badRate || 0) * 1.4 ? 'down' : ''), stat('Errors on instant moves', T.fast.n ? `${T.fast.badRate}%` : '–', T.fast.n ? `${T.fast.n} sharp positions` : 'not enough data')) : null,
    );
    const maxDay = 100;
    const habits = card(
      'pr-mini-stats',
      h('div', { class: 'pr-card-title' }, 'Habits'),
      h('div', { class: 'pr-three' }, stat('After a win', `${Math.round(R.tilt.afterWin.score)}%`, `${R.tilt.afterWin.n} games`), stat('After a loss', `${Math.round(R.tilt.afterLoss.score)}%`, `${R.tilt.afterLoss.n} games`, R.tilt.afterWin.score - R.tilt.afterLoss.score >= 10 ? 'down' : ''), stat('Longest streak', `${R.streaks.win} W`, `worst run ${R.streaks.loss} L`)),
      h('div', { class: 'pr-card-title', style: { marginTop: '16px' } }, 'Score by time of day'),
      h('div', { class: 'pr-days' }, ...R.dayparts.map((d) => h('div', { class: 'pr-day' + (d.n < 5 ? ' few' : '') }, h('div', { class: 'col' }, h('i', { style: { height: `${d.n ? Math.max(6, (d.score / maxDay) * 100) : 0}%` } })), h('b', {}, d.n ? `${Math.round(d.score)}%` : '–'), h('small', {}, d.label), h('small', { class: 'n' }, `${d.n} games`)))),
    );
    b.append(sec('Time and habits', null, h('div', { class: 'pr-grid two' }, timeCard, habits)));

    if (E?.conv?.thrown?.length) {
      b.append(
        sec(
          'Wins that got away',
          'Games where you had a winning position',
          card('pr-thrown', ...E.conv.thrown.map((t) => h('button', { class: 'pr-thrown-row', onclick: () => this.openExample(t, t.g) }, h('span', { class: 'res ' + t.res }, t.res === 'D' ? '½' : 'L'), h('span', { class: 'grow' }, `vs ${t.opp}`), h('small', {}, fmtDate(t.end)), h('span', { class: 'go', html: icons.next })))),
        ),
      );
    }
  }

  focusCard(f, i, gameById) {
    const sevCls = f.sev >= 60 ? 'hi' : f.sev >= 35 ? 'mid' : 'lo';
    const exs = (f.examples || []).filter((x) => x.fen);
    return h(
      'div',
      { class: 'pr-card pr-focus-card', style: { animationDelay: `${i * 60}ms` } },
      h(
        'div',
        { class: 'pr-focus-head' },
        h('span', { class: 'rank' }, i + 1),
        h('div', { class: 'grow' }, h('h3', {}, f.title), h('div', { class: 'pr-focus-stat' }, f.stat)),
        h('div', { class: 'pr-sev ' + sevCls }, h('span', {}, f.sevLabel), h('div', { class: 'meter' }, h('i', { style: { width: `${Math.max(8, Math.min(100, f.sev))}%` } }))),
      ),
      h('p', { class: 'pr-focus-detail' }, f.detail),
      h('ul', { class: 'pr-advice' }, ...f.advice.map((a) => h('li', { html: `${icons.check}<span>${esc(a)}</span>` }))),
      exs.length ? h('div', { class: 'pr-focus-ex' }, h('small', {}, 'From your games'), h('div', { class: 'pr-ex-row' }, ...exs.map((x) => this.exampleCard(x, gameById, false, true)))) : null,
    );
  }

  exampleCard(x, gameById, good = false, compact = false) {
    const game = gameById.get(x.gid);
    const flip = x.color === 'b';
    const k = x.k;
    const board = miniBoard(x.fen, { flip, played: x.uci, best: good ? null : x.bu, playedGood: good });
    const label = good ? (k === 'brilliant' ? 'Brilliant' : 'Great move') : CLS_LABEL[k] || 'Mistake';
    return h(
      'button',
      { class: 'pr-ex' + (compact ? ' compact' : ''), onclick: () => this.openExample(x, game) },
      h('div', { class: 'pr-ex-board' }, board, h('span', { class: 'badge', html: clsIcon(k, 'cls-ico') })),
      h(
        'div',
        { class: 'pr-ex-txt' },
        h('b', {}, `${x.san}`, h('span', { class: 'cls', style: { color: `var(${CLS_COLOR[k] || '--c-mistake'})` } }, ` ${label}`)),
        !good && x.tag && TAGS[x.tag] ? h('small', {}, TAGS[x.tag].label) : null,
        h('small', { class: 'meta' }, `vs ${x.opp} · ${fmtDate(x.end)}`),
      ),
    );
  }
}
