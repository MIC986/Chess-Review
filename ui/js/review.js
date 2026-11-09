// Game Review screen.
import { invoke, listen, h, $, esc, toast, fmtClock, evalText, evalSide, winPct } from './api.js';
import { icons, clsIcon, CLS, CLS_ORDER, clsArticle } from './icons.js';
import { settings, engineOpts, pieceUrl, onSettings } from './settings.js';
import { Board, parseFen, fenTurn } from './board.js';
import { evalGraph } from './graph.js';
import { play, soundForMove } from './sound.js';
import * as voice from './voice.js';
import { COACHES } from './coaches.js';
import { gameStory } from './story.js';
import { perspective, myColor } from './persp.js';

const TIPS = [
  'Use the ← and → arrow keys to step through the moves.',
  'Press ↑ and ↓ to jump between the key moments of the game.',
  'Right-click and drag on the board to draw your own arrows.',
  'Drag any piece during the review to explore your own ideas with the engine.',
  'Use Retry on your mistakes to find the better move yourself.',
  'Press F to flip the board and B to see the best move.',
  'You can change the board, pieces, voice and engine strength in Settings.',
];

const FIG = { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞' };
export function sanHtml(san) {
  if (!settings.figurine) return esc(san);
  const img = (r) => `<img class="fig" src="${pieceUrl('w', r)}" alt="${r}">`;
  const m = san.match(/^([KQRBN])(.*)$/);
  let s = m ? img(m[1]) + esc(m[2]) : esc(san);
  s = s.replace(/=([QRBN])/, (_, p) => '=' + img(p));
  return s;
}

const avatarCache = new Map();
async function fetchAvatar(username) {
  if (!username) return null;
  const k = username.toLowerCase();
  if (!avatarCache.has(k)) avatarCache.set(k, invoke('cc_profile', { username }).catch(() => null));
  return avatarCache.get(k);
}

function avatarEl(url, name, cls = 'avatar sm') {
  if (url) return h('img', { class: cls, src: url, alt: '', draggable: 'false' });
  return h('div', { class: cls + ' avatar-fallback' }, (name || '?')[0].toUpperCase());
}

function coachAvatarEl() {
  const c = COACHES[settings.coach] || COACHES.leo;
  return h(
    'div',
    { class: 'coach-col' },
    h('div', { class: 'coach-avatar', title: `Coach ${c.name}`, style: { background: c.gradient } }, h('img', { src: pieceUrl('w', c.piece, 'cburnett'), alt: '' })),
    h('div', { class: 'coach-name' }, c.name),
  );
}

const START_COUNTS = { P: 8, N: 2, B: 2, R: 2, Q: 1 };
const VAL = { P: 1, N: 3, B: 3, R: 5, Q: 9 };

function materialInfo(fen) {
  const map = parseFen(fen);
  const cnt = { w: { P: 0, N: 0, B: 0, R: 0, Q: 0 }, b: { P: 0, N: 0, B: 0, R: 0, Q: 0 } };
  for (const code of map.values()) if (code[1] !== 'K') cnt[code[0]][code[1]]++;
  const mat = (c) => Object.entries(cnt[c]).reduce((s, [r, n]) => s + VAL[r] * n, 0);
  // pieces captured BY color c = opponent's missing pieces
  const captured = (c) => {
    const o = c === 'w' ? 'b' : 'w';
    const out = [];
    for (const r of ['P', 'N', 'B', 'R', 'Q']) {
      const missing = Math.max(0, START_COUNTS[r] - cnt[o][r]);
      for (let i = 0; i < missing; i++) out.push(o + r);
    }
    return out;
  };
  return { w: captured('w'), b: captured('b'), diff: mat('w') - mat('b') };
}

function parseTimeControl(tc) {
  if (!tc || tc === '-' || tc.includes('/')) return null;
  const base = parseFloat(tc.split('+')[0]);
  return isNaN(base) ? null : base;
}

export class ReviewView {
  constructor(game, app) {
    this.app = app;
    this.game = game; // {pgn, key, meta}
    this.meta = game.meta || {};
    this.review = null;
    this.phase = 'loading';
    this.ply = 0;
    this.tab = 'moves';
    this.variation = null;
    this.retry = null;
    this.showBest = false;
    this.autoplay = null;
    this.live = { id: 0, lines: [], depth: 0, fen: null };
    this.progress = { done: 0, total: 0 };
    this.unsubs = [];
    this.speakTimer = null;
    this.tipIndex = Math.floor(Math.random() * TIPS.length);
    this.build();
  }

  // ================================================================ setup
  async start({ forceAnalyze = false } = {}) {
    try {
      this.base = await invoke('game_moves', { pgn: this.game.pgn });
    } catch (e) {
      this.fail(String(e));
      return;
    }
    this.headers = this.base.headers || {};
    this.white = { name: this.headers.White || this.meta.white?.username || 'White', rating: this.headers.WhiteElo || this.meta.white?.rating };
    this.black = { name: this.headers.Black || this.meta.black?.username || 'Black', rating: this.headers.BlackElo || this.meta.black?.rating };
    // The player being viewed sits at the bottom, their opponent at the top.
    this.viewer = this.meta.viewer || settings.username || '';
    const me = this.viewer.toLowerCase();
    if (me && this.black.name.toLowerCase() === me) this.board.setOrientation('b');
    else this.board.setOrientation('w');
    this.baseClock = parseTimeControl(this.headers.TimeControl);
    this.renderPlayers();
    this.loadAvatars();
    this.goto(0, { silent: true });

    this.unsubs.push(
      await listen('analysis-progress', (p) => {
        if (p.key !== this.game.key) return;
        this.progress = p;
        this.updateProgress();
      }),
      await listen('analysis-done', (p) => {
        if (p.key !== this.game.key) return;
        this.onReview(p.review, true);
      }),
      await listen('analysis-error', (p) => {
        if (p.key !== this.game.key) return;
        if (p.error === 'cancelled') return;
        this.fail(p.error);
      }),
      await listen('live-info', (p) => this.onLive(p)),
    );
    this.unsubs.push(onSettings((k) => this.onSettingChanged(k)));
    voice.onSpeaking((v) => this.el.querySelectorAll('.coach-avatar').forEach((a) => a.classList.toggle('talking', v)));

    if (!forceAnalyze) {
      const cached = await invoke('refresh_review', { key: this.game.key }).catch(() => null);
      if (cached && cached.moves?.length === this.base.moves.length) {
        this.onReview(cached, false);
        return;
      }
    }
    this.analyze();
  }

  async analyze() {
    this.phase = 'analyzing';
    this.review = null;
    this.progress = { done: 0, total: 0 };
    this.renderSidebar();
    try {
      await invoke('analyze_game', {
        pgn: this.game.pgn,
        key: this.game.key,
        meta: this.meta,
        opts: engineOpts(),
        customEngine: settings.customEngine || null,
      });
    } catch (e) {
      if (String(e) === 'engine-missing') {
        this.app.requireEngine(() => this.analyze());
      } else this.fail(String(e));
    }
  }

  fail(msg) {
    this.phase = 'error';
    this.errorMsg = msg;
    this.renderSidebar();
  }

  onReview(review, fresh) {
    this.review = review;
    this.phase = 'summary';
    if (fresh) play('end');
    // Opened at a specific move (e.g. from Profile Review): jump straight there.
    const sp = this.game.startPly;
    if (sp && sp <= this.n) {
      this.game.startPly = null;
      this.phase = 'review';
      this.renderSidebar();
      this.goto(sp, { fromUser: true });
      this.prefetchAll();
      return;
    }
    this.renderSidebar();
    this.goto(this.ply, { silent: true });
    if (fresh || settings.voiceOn) this.speak(this.storySpeech(), 400);
    this.prefetchAll();
  }

  destroy() {
    this.stopAutoplay();
    voice.clearPrefetch();
    voice.stop();
    invoke('live_stop').catch(() => {});
    this.unsubs.forEach((u) => (typeof u === 'function' ? u() : null));
    this.unsubs = [];
    window.removeEventListener('resize', this.onResize);
    if (this.phase === 'analyzing') invoke('cancel_analysis').catch(() => {});
  }

  // ================================================================ layout
  build() {
    this.el = h('div', { class: 'review-layout' });
    this.area = h('div', { class: 'board-area' });
    this.evalBar = h(
      'div',
      { class: 'eval-bar' },
      h('div', { class: 'eb-white' }),
      h('div', { class: 'eb-label bottom' }),
      h('div', { class: 'eb-label top' }),
    );
    this.topBar = h('div', { class: 'player-bar top' });
    this.botBar = h('div', { class: 'player-bar bottom' });
    const boardWrap = h('div', { class: 'board-wrap' });
    this.stack = h('div', { class: 'board-stack' }, this.topBar, boardWrap, this.botBar);
    this.area.append(h('div', { class: 'board-col' }, this.evalBar, this.stack));
    this.board = new Board(boardWrap);
    this.board.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.deltaY > 0) this.step(1);
      else this.step(-1);
    }, { passive: false });

    this.sidebar = h('aside', { class: 'sidebar' });
    this.el.append(this.area, this.sidebar);
    this.onResize = () => this.layout();
    window.addEventListener('resize', this.onResize);
    this.renderSidebar();
  }

  layout() {
    if (!this.el.isConnected) return;
    const showEval = settings.evalBar;
    this.evalBar.classList.toggle('hidden', !showEval);
    const aw = this.area.clientWidth - 36 - (showEval ? 36 : 0);
    const ahh = this.area.clientHeight - 28 - 92;
    let size = Math.floor(Math.min(aw, ahh) / 8) * 8;
    size = Math.max(320, Math.min(size, 1200));
    this.el.style.setProperty('--board-size', size + 'px');
  }

  mount(container) {
    container.append(this.el);
    requestAnimationFrame(() => this.layout());
  }

  onSettingChanged(k) {
    if (['pieceSet'].includes(k)) {
      this.board.refreshPieceSet();
      this.renderPlayers();
    }
    if (['coords'].includes(k)) this.board.applyCoords();
    if (['evalBar'].includes(k)) this.layout();
    if (k === 'coach' || k === 'voiceRate') this.prefetchAll();
    if (['figurine', 'showClocks', 'coachAvatar', 'coach'].includes(k)) {
      this.renderSidebar();
      this.renderPlayers();
    }
    if (['showBadges', 'classHighlight', 'highlightLast', 'showArrows', 'showLegal'].includes(k)) this.refreshBoardDecor();
  }

  // ================================================================ data helpers
  get moves() {
    return this.base?.moves || [];
  }
  get n() {
    return this.moves.length;
  }
  fenAt(p) {
    return p === 0 ? this.base.startFen : this.moves[p - 1].fen;
  }
  rmove(p) {
    return this.review ? this.review.moves[p - 1] : null;
  }
  displayedFen() {
    if (this.retry) return this.retry.fen;
    if (this.variation) return this.variation.moves.length ? this.variation.moves[this.variation.moves.length - 1].fen : this.fenAt(this.variation.basePly);
    return this.fenAt(this.ply);
  }

  // ================================================================ navigation
  goto(p, { silent = false, fromUser = false, noScroll = false } = {}) {
    if (!this.base) return;
    this.noScroll = noScroll;
    p = Math.max(0, Math.min(this.n, p));
    const prev = this.ply;
    if (this.variation || this.retry) {
      this.variation = null;
      this.retry = null;
    }
    this.showBest = false;
    this.ply = p;
    const animate = Math.abs(p - prev) <= 1 || silent === false;
    this.board.setPosition(this.fenAt(p), { animate });
    this.refreshBoardDecor();
    this.updateInteractivity();
    this.renderPlayers();
    this.updateEvalBar();
    if (!silent && p !== prev && p > 0) {
      const m = this.moves[p - 1];
      if (Math.abs(p - prev) === 1) play(soundForMove(m));
      const rm = this.rmove(p);
      if (rm?.classification === 'brilliant' && p > prev) setTimeout(() => play('brilliant'), 120);
    }
    if (this.phase === 'review' || this.phase === 'summary' || this.phase === 'analyzing') this.renderSidebarDynamic();
    if (this.phase === 'review' && !silent) this.speakMove();
    if (this.tab === 'analysis' && this.phase === 'review') this.requestLive();
  }

  step(d) {
    if (this.retry) return;
    if (this.variation) {
      if (d < 0) this.variationBack();
      else this.variationForward();
      return;
    }
    if (this.phase === 'summary' && this.review && d > 0 && this.ply === 0) {
      this.startReview();
      return;
    }
    this.goto(this.ply + d, { fromUser: true, noScroll: true });
  }

  keyMoment(dir) {
    if (!this.review) return;
    const km = this.review.keyMoments;
    const target = dir > 0 ? km.find((k) => k > this.ply) : [...km].reverse().find((k) => k < this.ply);
    if (target != null) {
      if (this.phase !== 'review') this.phase = 'review';
      this.renderSidebar();
      this.goto(target, { fromUser: true });
    } else toast(dir > 0 ? 'No more key moments' : 'This is the first key moment');
  }

  startReview() {
    this.phase = 'review';
    this.tab = 'moves';
    this.renderSidebar();
    this.goto(Math.max(1, this.ply === 0 ? 1 : this.ply), { fromUser: true });
  }

  toggleAutoplay() {
    if (this.autoplay) return this.stopAutoplay();
    if (this.ply >= this.n) this.goto(0, { silent: true });
    const tick = () => {
      if (this.ply >= this.n) return this.stopAutoplay();
      this.step(1);
      this.autoplay = setTimeout(tick, settings.autoplayMs);
    };
    this.autoplay = setTimeout(tick, 250);
    this.renderFooter();
  }

  stopAutoplay() {
    if (this.autoplay) clearTimeout(this.autoplay);
    this.autoplay = null;
    if (this.phase === 'review' || this.phase === 'summary') this.renderFooter();
  }

  // ================================================================ board decor
  refreshBoardDecor() {
    const fen = this.displayedFen();
    let last = null;
    let cls = null;
    let badgeSq = null;
    let check = null;
    let arrows = [];
    if (this.retry) {
      const a = this.retry.attempt;
      if (a) {
        last = [a.from, a.to];
        cls = a.classification;
        badgeSq = a.to;
      }
      if (this.retry.hint) arrows = [];
    } else if (this.variation) {
      const vm = this.variation.moves[this.variation.moves.length - 1];
      if (vm) {
        last = [vm.from, vm.to];
        cls = vm.classification || null;
        badgeSq = cls ? vm.to : null;
        if (vm.check) check = this.kingSquare(fen);
      }
    } else if (this.ply > 0) {
      const m = this.moves[this.ply - 1];
      last = [m.from, m.to];
      const rm = this.rmove(this.ply);
      if (rm && (this.phase === 'review' || this.phase === 'summary')) {
        cls = rm.classification;
        badgeSq = m.to;
        if (settings.showArrows && rm.bestUci && !['best', 'book', 'forced', 'brilliant', 'great'].includes(rm.classification)) {
          arrows.push({ from: rm.bestUci.slice(0, 2), to: rm.bestUci.slice(2, 4), color: '#96bc4b', opacity: 0.82 });
        }
      }
      if (m.check) check = this.kingSquare(fen);
    }
    if (this.showBest && !this.variation && !this.retry) {
      const rm = this.rmove(this.ply + 1);
      const pos = this.review?.positions[this.ply];
      const bu = pos?.lines?.[0]?.uci?.[0];
      if (bu) arrows = [{ from: bu.slice(0, 2), to: bu.slice(2, 4), color: '#96bc4b', opacity: 0.9 }];
      void rm;
    }
    this.board.setHighlights({ last, cls, check });
    this.board.setBadge(badgeSq, cls);
    this.board.setArrows(arrows);
  }

  kingSquare(fen) {
    const turn = fenTurn(fen);
    for (const [sq, code] of parseFen(fen)) if (code === turn + 'K') return sq;
    return null;
  }

  async updateInteractivity() {
    if (!this.base) return;
    const fen = this.displayedFen();
    const turn = fenTurn(fen);
    if (this.retry && this.retry.locked) {
      this.board.setInteractive(null);
      return;
    }
    let color = turn;
    if (this.retry) color = this.retry.color;
    try {
      const d = await invoke('legal_moves', { fen });
      if (fen !== this.displayedFen()) return;
      const dests = new Map(Object.entries(d));
      this.board.setInteractive({ color, dests, onMove: (f, t, p) => this.onUserMove(f, t, p) });
    } catch {
      this.board.setInteractive(null);
    }
  }

  // ================================================================ user moves
  async onUserMove(from, to, promo) {
    const fen = this.displayedFen();
    let r;
    try {
      r = await invoke('play_move', { fen, from, to, promotion: promo });
    } catch {
      this.board.setPosition(fen);
      return;
    }
    play(soundForMove(r));
    if (this.retry) return this.onRetryAttempt(fen, r);

    // Following the game move simply advances.
    if (!this.variation && this.ply < this.n && this.moves[this.ply].uci === r.uci) {
      this.board.noAnim.add(r.to);
      this.goto(this.ply + 1, { silent: true });
      if (this.phase === 'review') this.speakMove();
      return;
    }
    if (!this.variation) this.variation = { basePly: this.ply, moves: [], kind: 'free' };
    else if (this.variation.kind === 'best') this.variation.kind = 'free';
    const entry = { ...r, classification: null, prevFen: fen };
    this.variation.moves.push(entry);
    this.board.setPosition(r.fen);
    this.refreshBoardDecor();
    this.updateInteractivity();
    this.updateEvalBar();
    if (this.phase !== 'review' && this.review) {
      this.phase = 'review';
      this.renderSidebar();
    } else this.renderSidebarDynamic();
    this.requestLive();
    // Classify the explored move.
    invoke('evaluate_attempt', { fen, uci: r.uci, depth: 14, customEngine: settings.customEngine || null })
      .then((res) => {
        entry.classification = res.classification;
        entry.bestSan = res.bestSan;
        entry.eval = res;
        if (this.variation?.moves.includes(entry) && this.variation.moves[this.variation.moves.length - 1] === entry) {
          this.refreshBoardDecor();
          this.renderSidebarDynamic();
        }
      })
      .catch(() => {});
  }

  variationBack() {
    if (!this.variation) return;
    this.variation.moves.pop();
    if (!this.variation.moves.length) {
      const p = this.variation.basePly;
      this.variation = null;
      this.goto(p, { silent: true });
      return;
    }
    this.board.setPosition(this.displayedFen());
    this.refreshBoardDecor();
    this.updateInteractivity();
    this.updateEvalBar();
    this.renderSidebarDynamic();
    this.requestLive();
  }

  async variationForward() {
    const v = this.variation;
    if (!v || v.kind !== 'best' || !v.line) return;
    const i = v.moves.length;
    const uci = v.line[i];
    if (!uci) return;
    const fen = this.displayedFen();
    try {
      const r = await invoke('play_move', { fen, from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || null });
      play(soundForMove(r));
      v.moves.push({ ...r, classification: i === 0 ? 'best' : null });
      this.board.setPosition(r.fen);
      this.refreshBoardDecor();
      this.updateInteractivity();
      this.updateEvalBar();
      this.renderSidebarDynamic();
    } catch {}
  }

  exitVariation() {
    if (!this.variation) return;
    const p = this.variation.basePly;
    this.variation = null;
    invoke('live_stop').catch(() => {});
    this.goto(p, { silent: true });
    if (this.tab === 'analysis') this.requestLive();
  }

  /** Show the engine's best move instead of the played move. */
  async showBestLine() {
    if (!this.review || this.ply < 1) return;
    const before = this.ply - 1;
    const pos = this.review.positions[before];
    const line = pos?.lines?.[0]?.uci;
    if (!line?.length) return;
    this.variation = { basePly: before, moves: [], kind: 'best', line, sanLine: pos.lines[0].san };
    this.board.setPosition(this.fenAt(before), { animate: true });
    await new Promise((r) => setTimeout(r, settings.animMs + 60));
    await this.variationForward();
    const rm = this.rmove(this.ply);
    if (rm && settings.voiceOn && rm.bestText) this.speak(this.tx(rm, 'bestText'));
  }

  // ================================================================ retry
  startRetry(p = this.ply) {
    const rm = this.rmove(p);
    if (!rm || !rm.retry) return;
    this.stopAutoplay();
    this.variation = null;
    this.ply = p;
    const fen = this.fenAt(p - 1);
    this.retry = { ply: p, fen, color: rm.color, attempts: 0, attempt: null, solved: false, hint: false, locked: false };
    this.board.setPosition(fen);
    this.refreshBoardDecor();
    this.updateInteractivity();
    this.updateEvalBar();
    this.renderSidebarDynamic();
    this.speak(`Find a better move for ${rm.color === 'w' ? 'White' : 'Black'}.`);
  }

  async onRetryAttempt(fen, r) {
    const rt = this.retry;
    rt.locked = true;
    this.board.setPosition(r.fen);
    this.board.setInteractive(null);
    rt.attempt = { ...r, classification: null, pending: true };
    this.refreshBoardDecor();
    this.renderSidebarDynamic();
    const rm = this.rmove(rt.ply);
    let res;
    try {
      res = await invoke('evaluate_attempt', { fen, uci: r.uci, depth: settings.retryDepth, customEngine: settings.customEngine || null });
    } catch (e) {
      toast('Could not evaluate the move: ' + e, 'err');
      rt.locked = false;
      this.board.setPosition(fen);
      this.updateInteractivity();
      return;
    }
    if (this.retry !== rt) return;
    rt.attempt = { ...r, classification: res.classification, pending: false };
    rt.attempts++;
    const good = ['best', 'excellent'].includes(res.classification) || r.uci === rm.bestUci;
    if (good) {
      if (r.uci === rm.bestUci) rt.attempt.classification = 'best';
      rt.solved = true;
      play('correct');
      if (settings.confetti) this.board.confetti();
      this.refreshBoardDecor();
      this.renderSidebarDynamic();
      this.speak(rt.attempt.classification === 'best' ? 'Correct! You found the best move.' : 'Correct! That works too.');
    } else {
      play('wrong');
      this.refreshBoardDecor();
      this.renderSidebarDynamic(true);
      this.speak('Not quite. Try again.');
      setTimeout(() => {
        if (this.retry !== rt) return;
        rt.attempt = null;
        rt.locked = false;
        if (rt.attempts >= 2) rt.hint = true;
        this.board.setPosition(rt.fen);
        this.refreshBoardDecor();
        this.updateInteractivity();
        this.renderSidebarDynamic();
        if (rt.hint) this.showHint();
      }, 1300);
    }
  }

  showHint() {
    const rm = this.rmove(this.retry?.ply);
    if (!rm?.bestUci) return;
    this.retry.hint = true;
    this.board.setHighlights({ last: [rm.bestUci.slice(0, 2)], cls: null });
    this.renderSidebarDynamic();
  }

  async showSolution() {
    const rt = this.retry;
    const rm = this.rmove(rt?.ply);
    if (!rm?.bestUci) return;
    rt.locked = true;
    const r = await invoke('play_move', { fen: rt.fen, from: rm.bestUci.slice(0, 2), to: rm.bestUci.slice(2, 4), promotion: rm.bestUci[4] || null });
    rt.attempt = { ...r, classification: 'best' };
    rt.solved = true;
    rt.revealed = true;
    play(soundForMove(r));
    this.board.setPosition(r.fen);
    this.board.setInteractive(null);
    this.refreshBoardDecor();
    this.renderSidebarDynamic();
    if (rm.bestText) this.speak(this.tx(rm, 'bestText'));
  }

  exitRetry(next = false) {
    const p = this.retry?.ply ?? this.ply;
    this.retry = null;
    if (next) {
      const km = this.review.moves.find((m) => m.ply > p && m.retry);
      if (km) return this.startRetry(km.ply);
    }
    this.goto(p, { silent: true });
  }

  // ================================================================ live engine
  requestLive() {
    if (!(this.tab === 'analysis' || this.variation)) return;
    const fen = this.displayedFen();
    this.live = { id: this.live.id + 1, lines: [], depth: 0, fen };
    invoke('live_analyze', {
      fen,
      multipv: settings.liveLines,
      id: this.live.id,
      threads: settings.liveThreads,
      hash: 128,
      maxDepth: 30,
      customEngine: settings.customEngine || null,
    }).catch(() => {});
    if (this.tab === 'analysis') this.renderTabContent();
  }

  onLive(p) {
    if (p.id !== this.live.id) return;
    this.live.lines = p.lines;
    this.live.depth = p.depth;
    if (this.variation) this.updateEvalBar();
    if (this.tab === 'analysis' && this.phase === 'review') this.renderLines();
  }

  // ================================================================ speaking
  speak(text, delay = 0) {
    clearTimeout(this.speakTimer);
    voice.stop(); // silence the previous line immediately
    if (!settings.voiceOn || !text) return;
    this.speakTimer = setTimeout(() => voice.speak(text), delay);
  }

  moveSpeech(rm) {
    // Book moves: the opening name is on screen, so the coach stays quiet.
    if (rm.classification === 'book' || rm.classification === 'forced') return '';
    let t = this.tx(rm);
    if (settings.speakBest && rm.bestText) t += ' ' + this.tx(rm, 'bestText');
    return t;
  }

  /** Pre-generate every coach line, starting from the current move. */
  prefetchAll() {
    if (!this.review) return;
    voice.clearPrefetch();
    const ms = this.review.moves;
    const order = [...ms.slice(this.ply), ...ms.slice(0, this.ply)];
    voice.prefetch(order.map((m) => this.moveSpeech(m)));
  }

  speakMove() {
    const rm = this.rmove(this.ply);
    if (!rm) return voice.stop();
    this.speak(this.moveSpeech(rm), 40);
    // Prepare the next lines so they play without delay.
    const ahead = [1, 2, 3].map((k) => this.rmove(this.ply + k)).filter(Boolean).map((m) => this.moveSpeech(m));
    if (ahead.length) voice.prefetch(ahead, { front: true });
  }

  // ================================================================ eval bar & players
  currentEval() {
    if (this.variation && this.live.lines.length && this.live.fen === this.displayedFen()) return this.live.lines[0].eval;
    if (this.variation?.kind === 'best') return this.review?.positions[this.variation.basePly]?.eval || null;
    if (this.variation) return null;
    if (this.retry) return this.review?.positions[this.retry.ply - 1]?.eval;
    return this.review?.positions[this.ply]?.eval || null;
  }

  updateEvalBar() {
    const ev = this.currentEval();
    const flipped = this.board.orientation === 'b';
    this.evalBar.classList.toggle('flipped', flipped);
    const white = this.evalBar.querySelector('.eb-white');
    const lb = this.evalBar.querySelector('.eb-label.bottom');
    const lt = this.evalBar.querySelector('.eb-label.top');
    if (!ev) {
      if (!this.review) {
        white.style.height = '50%';
        lb.textContent = '';
        lt.textContent = '';
      }
      return;
    }
    let pct;
    if (ev.mate != null) pct = ev.mate > 0 ? 100 : ev.mate < 0 ? 0 : fenTurn(this.displayedFen()) === 'w' ? 0 : 100;
    else pct = Math.max(4, Math.min(96, 50 + 46 * Math.tanh((ev.cp || 0) / 420)));
    white.style.height = pct + '%';
    const txt = evalText(ev).replace('+', '');
    const whiteAhead = evalSide(ev) === 'w';
    // label sits on the side that is ahead
    const atBottom = whiteAhead !== flipped;
    lb.textContent = atBottom ? txt : '';
    lt.textContent = atBottom ? '' : txt;
    lb.style.color = whiteAhead ? '#403d39' : '#fff';
    lt.style.color = whiteAhead ? '#403d39' : '#fff';
  }

  clockAt(color, p) {
    if (!settings.showClocks) return null;
    for (let i = p - 1; i >= 0; i--) if (this.moves[i].color === color && this.moves[i].clock != null) return this.moves[i].clock;
    return this.baseClock;
  }

  async loadAvatars() {
    for (const side of ['white', 'black']) {
      const p = this[side];
      const metaAv = this.meta?.[side]?.avatar;
      if (metaAv) p.avatar = metaAv;
      if (this.meta?.source === 'pgn') continue;
      const prof = await fetchAvatar(p.name);
      if (prof) {
        p.avatar = prof.avatar || p.avatar;
        p.title = prof.title;
        p.country = prof.country;
      }
    }
    this.renderPlayers();
    if (this.phase === 'summary') this.renderSidebar();
  }

  renderPlayers() {
    if (!this.base) return;
    const flipped = this.board.orientation === 'b';
    const fen = this.displayedFen();
    const mi = materialInfo(fen);
    const p = this.retry ? this.retry.ply - 1 : this.variation ? this.variation.basePly : this.ply;
    const turn = fenTurn(fen);
    const make = (color) => {
      const pl = color === 'w' ? this.white : this.black;
      const capt = mi[color];
      const groups = {};
      for (const c of capt) (groups[c[1]] ||= []).push(c);
      const capEl = h('div', { class: 'pb-capt' });
      for (const r of ['P', 'B', 'N', 'R', 'Q']) {
        if (!groups[r]) continue;
        const g = h('div', { class: 'cp-group' });
        for (const c of groups[r]) g.append(h('i', { style: { backgroundImage: `url(${pieceUrl(c[0], c[1])})` } }));
        capEl.append(g);
      }
      const adv = color === 'w' ? mi.diff : -mi.diff;
      if (adv > 0) capEl.append(h('span', { class: 'adv' }, '+' + adv));
      const clk = this.clockAt(color, p);
      const ended = p >= this.n && !this.variation && !this.retry;
      return [
        avatarEl(pl.avatar, pl.name),
        h(
          'div',
          { class: 'pb-info' },
          h(
            'div',
            { class: 'pb-name' },
            pl.title ? h('span', { class: 'title-badge' }, pl.title) : null,
            pl.name,
            pl.rating ? h('span', { class: 'rt' }, `(${pl.rating})`) : null,
          ),
          capEl,
        ),
        h(
          'div',
          { class: `clock ${color === 'w' ? 'white-clock' : 'black-clock'}${turn === color && !ended ? ' active' : ''}` },
          clk != null ? fmtClock(clk) : '',
        ),
      ];
    };
    this.topBar.replaceChildren(...make(flipped ? 'w' : 'b'));
    this.botBar.replaceChildren(...make(flipped ? 'b' : 'w'));
  }

  flip() {
    this.board.flip();
    this.renderPlayers();
    this.updateEvalBar();
    this.refreshBoardDecor();
  }

  // ================================================================ sidebar
  renderSidebar() {
    const head = h(
      'div',
      { class: 'sb-head' },
      h('div', { class: 'sb-title', html: `<span style="color:var(--accent);display:flex">${icons.review}</span> Game Review` }),
      h('button', { class: 'icon-btn' + (settings.voiceOn ? ' on' : ''), 'data-tip': settings.voiceOn ? 'Mute coach' : 'Unmute coach', html: settings.voiceOn ? icons.speaker : icons.mute, onclick: () => { settings.voiceOn = !settings.voiceOn; if (!settings.voiceOn) voice.stop(); this.renderSidebar(); } }),
      h('button', { class: 'icon-btn', 'data-tip': 'Flip board (F)', html: icons.flip, onclick: () => this.flip() }),
      this.meta.url ? h('button', { class: 'icon-btn', 'data-tip': 'Open on chess.com', html: icons.external, onclick: () => invoke('open_url', { url: this.meta.url }) }) : null,
      this.review ? h('button', { class: 'icon-btn', 'data-tip': 'Copy annotated PGN', html: icons.copy, onclick: () => this.copyPgn() }) : null,
      this.review ? h('button', { class: 'icon-btn', 'data-tip': 'Re-analyze with current settings', html: icons.refresh, onclick: () => this.analyze() }) : null,
    );
    this.body = h('div', { class: 'sb-body' });
    this.foot = h('div', { class: 'sb-foot' });
    this.sidebar.replaceChildren(head, this.body, this.foot);
    this.renderBody();
    this.renderFooter();
  }

  renderBody() {
    this.body.replaceChildren();
    this.body.className = 'sb-body';
    this.tabBody = null;
    this.graph = null;
    if (this.phase === 'loading') {
      this.body.append(h('div', { class: 'empty-state' }, h('div', { class: 'spinner' })));
    } else if (this.phase === 'error') {
      this.body.append(
        this.coachRow(h('div', { class: 'bubble' }, h('div', { class: 'b-head' }, 'Something went wrong'), h('div', { class: 'b-text' }, this.errorMsg || 'Unknown error'))),
        h('div', { style: { padding: '8px 16px' } }, h('button', { class: 'btn primary block', onclick: () => this.analyze() }, 'Try again')),
      );
    } else if (this.phase === 'analyzing') {
      this.renderAnalyzing();
    } else if (this.phase === 'summary') {
      this.renderSummary();
    } else if (this.phase === 'review') {
      this.renderReview();
    }
  }

  coachRow(bubble) {
    return h('div', { class: 'coach' }, coachAvatarEl(), bubble);
  }

  renderAnalyzing() {
    const pct = this.progress.total ? Math.round((this.progress.done / this.progress.total) * 100) : 0;
    this.progEl = h('div', { class: 'progress' }, h('i', { style: { width: pct + '%' } }));
    this.progText = h('span', {}, pct + '%');
    const opening = this.headers?.ECOUrl ? decodeURIComponent(this.headers.ECOUrl.split('/').pop()).split('...')[0].replace(/-/g, ' ').replace(/\d.*$/, '').trim() : '';
    this.body.append(
      this.coachRow(h('div', { class: 'bubble' }, h('div', { class: 'b-head' }, 'Reviewing your game…'), h('div', { class: 'b-text' }, `I'm going through every move of ${this.white.name} vs ${this.black.name}. This only takes a moment.`))),
      h(
        'div',
        { class: 'analyzing' },
        h('div', { class: 'an-row' }, h('span', {}, `Analyzing ${this.n} moves · depth ${settings.depth}`), this.progText),
        this.progEl,
        opening ? h('div', { class: 'an-row', style: { marginTop: '18px' } }, h('span', { html: `<span style="color:var(--c-book)">${icons.book.replace('<svg', '<svg width="16" height="16" style="vertical-align:-3px;margin-right:6px"')}</span>${esc(opening)}` })) : null,
        h('div', { class: 'an-tip', html: `${icons.bulb}<span>${esc(TIPS[this.tipIndex % TIPS.length])}</span>` }),
      ),
      this.moveListEl(),
    );
  }

  updateProgress() {
    if (this.phase !== 'analyzing' || !this.progEl) return;
    const pct = this.progress.total ? Math.round((this.progress.done / this.progress.total) * 100) : 0;
    this.progEl.firstChild.style.width = pct + '%';
    this.progText.textContent = pct + '%';
  }

  renderSummary() {
    const r = this.review;
    const ccAcc = this.meta.accuracies;
    const bubble = h(
      'div',
      { class: 'bubble' },
      h('div', { class: 'b-head' }, h('span', { class: 'b-title' }, this.resultTitle()), h('button', { class: 'speak-btn', html: icons.speaker, onclick: () => voice.speak(this.storySpeech(), { force: true }) })),
      h('div', { class: 'b-text' }, this.story()),
    );
    this.graph = evalGraph(r, { onSelect: (p) => { this.phase = 'review'; this.renderSidebar(); this.goto(p, { fromUser: true }); }, ply: this.ply });
    const players = h(
      'div',
      { class: 'sum-players' },
      ...[['w', this.white, r.white], ['b', this.black, r.black]].map(([c, p, s]) =>
        h(
          'div',
          { class: 'sum-player' },
          avatarEl(p.avatar, p.name, 'avatar'),
          h('div', { class: 'nm' }, p.name),
          h('div', { class: `acc-box ${c}` }, s.accuracy.toFixed(1)),
          ccAcc && ccAcc[c === 'w' ? 'white' : 'black'] != null ? h('div', { class: 'cc-acc' }, `chess.com: ${Number(ccAcc[c === 'w' ? 'white' : 'black']).toFixed(1)}`) : null,
        ),
      ),
    );
    const table = h('div', { class: 'cls-table' });
    for (const k of CLS_ORDER) {
      const wc = r.white.counts[k] || 0;
      const bc = r.black.counts[k] || 0;
      table.append(
        h(
          'div',
          { class: 'cls-row' + (wc + bc === 0 ? ' zero' : ''), onclick: () => this.jumpToClass(k) },
          h('div', { class: 'lbl' }, CLS[k].label),
          h('div', { class: `cnt c-${k}` }, wc),
          h('div', { class: 'ico', html: clsIcon(k, '') }),
          h('div', { class: `cnt c-${k}` }, bc),
        ),
      );
    }
    const phaseRow = (label, key) => {
      const ph = (s) => s.phases[key];
      const cell = (v) => h('div', { class: 'ph', html: v ? clsIcon(v, '') : '<span class="none">—</span>' });
      return h('div', { class: 'phase-row' }, h('div', { class: 'lbl' }, label), cell(ph(r.white)), cell(ph(r.black)));
    };
    this.body.append(
      this.coachRow(bubble),
      h('div', { class: 'sum-section' }, this.graph),
      h('div', { class: 'acc-label' }, 'Accuracy'),
      players,
      h('div', { class: 'sum-divider' }),
      table,
      h('div', { class: 'sum-divider' }),
      h('div', { class: 'rating-row' }, h('div', { class: 'lbl' }, 'Game Rating'), h('div', { class: 'rating-box w' }, r.white.rating), h('div', { class: 'rating-box b' }, r.black.rating)),
      h('div', { class: 'sum-divider' }),
      phaseRow('Opening', 'opening'),
      phaseRow('Middlegame', 'middlegame'),
      phaseRow('Endgame', 'endgame'),
      h('div', { style: { height: '10px' } }),
    );
  }

  /** Coach text for a move, phrased for whoever is reviewing (you / your opponent / White/Black). */
  tx(rm, field = 'text') {
    if (!rm) return '';
    return perspective(rm[field] || '', rm.color, myColor(this.viewer, this.white, this.black));
  }

  story() {
    if (!this.review) return '';
    try {
      return gameStory(this.review, this.white, this.black, this.viewer, (m) => this.tx(m));
    } catch (e) {
      console.warn(e);
      return this.review.summary;
    }
  }

  /** The summary as spoken: player names (which the voice can't pronounce) become White / Black. */
  storySpeech() {
    let t = this.story();
    for (const [p, c] of [[this.white, 'White'], [this.black, 'Black']]) {
      if (p?.name) t = t.split(p.name).join(c);
    }
    return t;
  }

  resultTitle() {
    const res = this.review?.result || this.headers?.Result;
    if (res === '1-0') return `${this.white.name} won`;
    if (res === '0-1') return `${this.black.name} won`;
    if (res === '1/2-1/2') return 'Draw';
    return 'Game summary';
  }

  jumpToClass(k) {
    const list = this.review.moves.filter((m) => m.classification === k);
    if (!list.length) return;
    const next = list.find((m) => m.ply > this.ply) || list[0];
    this.phase = 'review';
    this.renderSidebar();
    this.goto(next.ply, { fromUser: true });
  }

  renderReview() {
    this.bubbleWrap = h('div');
    this.graphWrap = h('div', { class: 'sum-section', style: { paddingTop: '2px' } });
    this.graph = evalGraph(this.review, { compact: true, onSelect: (p) => this.goto(p, { fromUser: true }), ply: this.ply });
    this.graphWrap.append(this.graph);
    const keysN = this.review.keyMoments.length;
    const tab = (id, label, ico, extra) =>
      h('button', { class: 'rv-tab' + (this.tab === id ? ' active' : ''), onclick: () => this.setTab(id), html: `${ico}${label}${extra != null ? ` <span class="badge-n">${extra}</span>` : ''}` });
    this.tabsEl = h('div', { class: 'rv-tabs' }, tab('moves', 'Moves', icons.list), tab('keys', 'Key Moments', icons.key, keysN), tab('analysis', 'Analysis', icons.cpu));
    this.tabBody = h('div', { class: 'rv-scroll' });
    this.body.classList.add('rv');
    this.body.append(this.bubbleWrap, this.graphWrap, this.tabsEl, this.tabBody);
    this.renderBubble();
    this.renderTabContent();
  }

  setTab(id) {
    this.tab = id;
    this.tabsEl.querySelectorAll('.rv-tab').forEach((b, i) => b.classList.toggle('active', ['moves', 'keys', 'analysis'][i] === id));
    this.renderTabContent();
    if (id === 'analysis') this.requestLive();
    else if (!this.variation) invoke('live_stop').catch(() => {});
  }

  renderTabContent() {
    if (!this.tabBody) return;
    this.tabBody.replaceChildren();
    if (this.tab === 'moves') {
      const ob = this.openingBar();
      if (ob) this.tabBody.append(ob);
      this.tabBody.append(this.moveListEl());
    } else if (this.tab === 'keys') {
      this.tabBody.append(this.keyListEl());
    } else {
      this.linesEl = h('div', { class: 'lines' });
      this.tabBody.append(this.linesEl);
      this.renderLines();
    }
    this.scrollMoveIntoView(true);
  }

  openingBar() {
    let name = null;
    for (let i = Math.min(this.ply, this.n) - 1; i >= 0; i--) {
      const rm = this.review?.moves[i];
      if (rm?.opening) {
        name = rm.opening;
        break;
      }
    }
    name = name || this.review?.opening;
    if (!name) return null;
    return h('div', { class: 'opening-bar', html: `<span class="c-book" style="display:flex">${icons.book}</span><span>${esc(name)}</span>` });
  }

  moveListEl() {
    const wrap = h('div', { class: 'moves' });
    const ms = this.moves;
    let i = 0;
    const startBlack = ms[0]?.color === 'b';
    while (i < ms.length) {
      const num = ms[i].moveNumber;
      const row = h('div', { class: 'mv-row' }, h('div', { class: 'num' }, num + '.'));
      if (i === 0 && startBlack) {
        row.append(h('div', {}, h('span', { class: 'mv', style: { opacity: 0.4 } }, '…')));
        row.append(h('div', {}, this.moveCell(0)));
        i += 1;
      } else {
        row.append(h('div', {}, this.moveCell(i)));
        row.append(h('div', {}, i + 1 < ms.length ? this.moveCell(i + 1) : ''));
        i += 2;
      }
      wrap.append(row);
    }
    this.movesEl = wrap;
    return wrap;
  }

  moveCell(i) {
    const m = this.moves[i];
    const rm = this.review?.moves[i];
    const p = i + 1;
    const el = h('div', { class: 'mv' + (p === this.ply && !this.variation && !this.retry ? ' cur' : ''), 'data-ply': p, onclick: () => { if (this.phase === 'summary') { this.phase = 'review'; this.renderSidebar(); } this.goto(p, { fromUser: true }); } });
    if (rm && !['best', 'excellent', 'good'].includes(rm.classification)) el.innerHTML = clsIcon(rm.classification);
    else if (rm) el.innerHTML = clsIcon(rm.classification);
    el.insertAdjacentHTML('beforeend', `<span class="san">${sanHtml(m.san)}</span>`);
    return el;
  }

  keyListEl() {
    const wrap = h('div', { class: 'key-list' });
    const km = this.review.moves.filter((m) => this.review.keyMoments.includes(m.ply));
    if (!km.length) {
      wrap.append(h('div', { class: 'empty-state', style: { padding: '30px 10px' } }, h('h3', {}, 'No key moments'), 'Both sides played cleanly — no big swings in this game.'));
      return wrap;
    }
    for (const m of km) {
      const pl = m.color === 'w' ? this.white.name : this.black.name;
      const card = h(
        'div',
        { class: 'key-card' + (m.ply === this.ply ? ' cur' : ''), style: { '--clscol': CLS[m.classification].color }, onclick: () => this.goto(m.ply, { fromUser: true }) },
        h('span', { html: clsIcon(m.classification) }),
        h(
          'div',
          {},
          h('div', { class: 'kc-t', html: `${m.moveNumber}${m.color === 'w' ? '.' : '...'} ${sanHtml(m.san)} <small>${esc(pl)} · ${CLS[m.classification].label}</small>` }),
          h('div', { class: 'kc-d' }, this.tx(m)),
        ),
      );
      wrap.append(card);
    }
    return wrap;
  }

  renderLines() {
    if (!this.linesEl) return;
    const lines = this.live.lines || [];
    const fen = this.displayedFen();
    const turn = fenTurn(fen);
    const fullmove = parseInt(fen.split(' ')[5] || '1', 10);
    const head = h('div', { class: 'line-head' }, h('span', {}, 'Engine lines'), h('span', {}, this.live.depth ? `depth ${this.live.depth}` : 'thinking…'));
    const rows = lines.map((l) => {
      const pv = h('div', { class: 'pv' });
      let num = fullmove;
      let t = turn;
      l.san.slice(0, 12).forEach((s, i) => {
        if (t === 'w') pv.append(h('span', { class: 'n' }, `${num}.`));
        else if (i === 0) pv.append(h('span', { class: 'n' }, `${num}...`));
        pv.append(h('span', { html: sanHtml(s), onclick: () => this.playLine(fen, l.uci.slice(0, i + 1)) }), ' ');
        if (t === 'b') num++;
        t = t === 'w' ? 'b' : 'w';
      });
      return h('div', { class: 'line' }, h('span', { class: `eval-chip ${evalSide(l.eval)}` }, evalText(l.eval)), pv);
    });
    if (!rows.length) rows.push(h('div', { class: 'line' }, h('div', { class: 'spinner' }), h('span', { style: { color: 'var(--text-3)' } }, 'Starting engine…')));
    this.linesEl.replaceChildren(head, ...rows);
  }

  async playLine(fen, ucis) {
    if (!this.variation) this.variation = { basePly: this.ply, moves: [], kind: 'free' };
    let cur = fen;
    for (const u of ucis) {
      try {
        const r = await invoke('play_move', { fen: cur, from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || null });
        this.variation.moves.push({ ...r, prevFen: cur });
        cur = r.fen;
      } catch {
        break;
      }
    }
    play('move');
    this.board.setPosition(cur);
    this.refreshBoardDecor();
    this.updateInteractivity();
    this.updateEvalBar();
    this.renderSidebarDynamic();
    this.requestLive();
  }

  scrollMoveIntoView(force = false) {
    if (this.noScroll && !force) return;
    const cur = this.sidebar.querySelector('.mv.cur');
    if (cur) {
      const body = this.tabBody || this.body;
      const r = cur.getBoundingClientRect();
      const b = body.getBoundingClientRect();
      if (r.top < b.top || r.bottom > b.bottom) cur.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  /** Lightweight refresh after navigation (keeps scroll position, no full rebuild). */
  renderSidebarDynamic(failShake = false) {
    if (this.graph) this.graph.setPly(this.retry ? this.retry.ply - 1 : this.variation ? this.variation.basePly : this.ply);
    if (this.phase === 'review') {
      this.renderBubble(failShake);
      if (this.tab === 'moves') {
        this.sidebar.querySelectorAll('.mv.cur').forEach((e) => e.classList.remove('cur'));
        if (!this.variation && !this.retry) this.sidebar.querySelector(`.mv[data-ply="${this.ply}"]`)?.classList.add('cur');
        const ob = this.openingBar();
        const old = this.tabBody.querySelector('.opening-bar');
        if (ob && old) old.replaceWith(ob);
        else if (ob) this.tabBody.prepend(ob);
        else if (old) old.remove();
        this.scrollMoveIntoView();
      } else if (this.tab === 'keys') {
        this.tabBody.querySelectorAll('.key-card').forEach((c) => c.classList.toggle('cur', false));
        const idx = this.review.moves.filter((m) => this.review.keyMoments.includes(m.ply)).findIndex((m) => m.ply === this.ply);
        if (idx >= 0) this.tabBody.querySelectorAll('.key-card')[idx]?.classList.add('cur');
      }
      this.renderFooter();
    } else if (this.phase === 'analyzing' || this.phase === 'summary') {
      this.sidebar.querySelectorAll('.mv.cur').forEach((e) => e.classList.remove('cur'));
      this.sidebar.querySelector(`.mv[data-ply="${this.ply}"]`)?.classList.add('cur');
    }
  }

  renderBubble(failShake = false) {
    if (!this.bubbleWrap) return;
    const b = h('div', { class: 'bubble' });
    const actions = h('div', { class: 'b-actions' });
    const evChip = (ev) => (ev ? h('span', { class: `eval-chip ${evalSide(ev)}` }, evalText(ev)) : null);
    if (this.retry) {
      const rt = this.retry;
      const rm = this.rmove(rt.ply);
      const side = rm.color === 'w' ? 'White' : 'Black';
      if (rt.solved && rt.attempt) {
        b.classList.add(rt.revealed ? 'x' : 'success');
        b.append(
          h('div', { class: 'b-head', html: `${clsIcon(rt.attempt.classification)}<span class="b-title c-${rt.attempt.classification}">${rt.revealed ? `${esc(rt.attempt.san)} is best` : `Correct! ${esc(rt.attempt.san)} is ${rt.attempt.classification}`}</span>` }),
          h('div', { class: 'b-text' }, rt.revealed ? this.tx(rm, 'bestText') : rt.attempt.classification === 'best' ? 'You found the best move in this position.' : 'That works just as well as the engine move.'),
        );
        actions.append(
          h('button', { class: 'btn primary', onclick: () => this.exitRetry(true), html: `${icons.next} Next mistake` }),
          h('button', { class: 'btn', onclick: () => this.exitRetry(false) }, 'Back to game'),
        );
      } else if (rt.attempt && !rt.attempt.pending) {
        if (failShake) b.classList.add('fail');
        b.append(
          h('div', { class: 'b-head', html: `${clsIcon(rt.attempt.classification)}<span class="b-title c-${rt.attempt.classification}">${esc(rt.attempt.san)} is ${clsArticle(rt.attempt.classification)} ${rt.attempt.classification}</span>` }),
          h('div', { class: 'b-text' }, 'Not quite. Try again!'),
        );
      } else if (rt.attempt?.pending) {
        b.append(h('div', { class: 'b-head', html: `<span class="spinner" style="width:18px;height:18px;border-width:2px"></span><span class="b-title">Checking ${esc(rt.attempt.san)}…</span>` }));
      } else {
        b.append(
          h('div', { class: 'b-head', html: `<span style="color:var(--accent);display:flex">${icons.retry.replace('<svg', '<svg width="20" height="20"')}</span><span class="b-title">Find a better move for ${side}</span>` }),
          h('div', { class: 'b-text' }, rt.hint ? 'Hint: the highlighted piece is the one to move.' : `In the game, ${rm.san} was ${clsArticle(rm.classification)} ${rm.classification}. Can you do better?`),
        );
        actions.append(
          !rt.hint ? h('button', { class: 'btn', onclick: () => this.showHint(), html: `${icons.bulb} Hint` }) : null,
          h('button', { class: 'btn', onclick: () => this.showSolution(), html: `${icons.eye} Show solution` }),
          h('button', { class: 'btn', onclick: () => this.exitRetry(false) }, 'Cancel'),
        );
      }
      if (actions.childElementCount) b.append(actions);
      this.bubbleWrap.replaceChildren(this.coachRow(b));
      return;
    }
    if (this.variation) {
      const v = this.variation;
      const last = v.moves[v.moves.length - 1];
      if (v.kind === 'best') {
        const rm = this.rmove(v.basePly + 1);
        b.append(
          h('div', { class: 'b-head', html: `${clsIcon('best')}<span class="b-title c-best">${esc(v.sanLine?.[0] || '')} is best</span>` }),
          h('div', { class: 'b-text' }, this.tx(rm, 'bestText').replace(/^\S+ was best\.\s*/, '')),
        );
        const bestLine = (v.sanLine || []).slice(0, 8).join(' ');
        if (bestLine) b.append(h('div', { class: 'b-best' }, h('span', { style: { fontSize: '12.5px' } }, 'Line: ' + bestLine)));
        actions.append(
          h('button', { class: 'btn primary', onclick: () => this.variationForward(), html: `${icons.play} Show follow-up` }),
          h('button', { class: 'btn', onclick: () => this.exitVariation() }, 'Back to game'),
        );
      } else {
        const evl = this.live.lines[0]?.eval;
        if (last?.classification) {
          b.append(h('div', { class: 'b-head', html: `${clsIcon(last.classification)}<span class="b-title c-${last.classification}">${esc(last.san)} is ${last.classification === 'best' ? 'best' : clsArticle(last.classification) + ' ' + last.classification}</span>` }, evChip(evl)));
          if (last.bestSan && last.classification !== 'best') b.append(h('div', { class: 'b-text' }, `${last.bestSan} was best.`));
        } else {
          b.append(h('div', { class: 'b-head', html: `<span style="color:var(--c-great);display:flex">${icons.analysis.replace('<svg', '<svg width="20" height="20"')}</span><span class="b-title">Exploring ${esc(last?.san || '')}</span>` }, evChip(evl)));
        }
        const line = this.live.lines[0]?.san?.slice(0, 6).join(' ');
        b.append(h('div', { class: 'b-text', style: { marginTop: '4px', fontSize: '13px' } }, line ? `Engine: ${line}` : 'Engine is thinking…'));
        actions.append(h('button', { class: 'btn primary', onclick: () => this.exitVariation(), html: `${icons.prev} Back to game` }));
      }
      b.append(actions);
      this.bubbleWrap.replaceChildren(this.coachRow(b));
      return;
    }
    const rm = this.rmove(this.ply);
    if (!rm) {
      b.append(h('div', { class: 'b-head' }, h('span', { class: 'b-title' }, 'Starting position')), h('div', { class: 'b-text' }, `${this.white.name} vs ${this.black.name}. Press Next to go through the game move by move.`));
      this.bubbleWrap.replaceChildren(this.coachRow(b));
      return;
    }
    const ev = this.review.positions[this.ply]?.eval;
    b.append(
      h('div', { class: 'b-head', html: `${clsIcon(rm.classification)}<span class="b-title c-${rm.classification}">${esc(rm.title)}</span>` }, evChip(ev), h('button', { class: 'speak-btn', html: icons.speaker, onclick: () => voice.speak(this.moveSpeech(rm) || this.tx(rm), { force: true }) })),
      h('div', { class: 'b-text' }, rm.classification === 'book' ? rm.opening || 'A standard opening move.' : this.tx(rm)),
    );
    if (rm.bestText && settings.showBestInBubble) {
      b.append(h('div', { class: 'b-best', html: `${clsIcon('best')}<span>${esc(this.tx(rm, 'bestText'))}</span>` }));
    }
    if (rm.bestSan) actions.append(h('button', { class: 'btn', onclick: () => this.showBestLine(), html: `${icons.star || icons.review} Best` }));
    if (rm.retry) actions.append(h('button', { class: 'btn primary', onclick: () => this.startRetry(), html: `${icons.retry} Retry` }));
    if (!rm.bestSan && !['book', 'forced'].includes(rm.classification) && this.review.positions[this.ply - 1]?.lines?.[0]?.san?.length > 1) actions.append(h('button', { class: 'btn', onclick: () => this.showBestLine(), html: `${icons.play} Show line` }));
    if (actions.childElementCount) b.append(actions);
    this.bubbleWrap.replaceChildren(this.coachRow(b));
  }

  renderFooter() {
    if (!this.foot) return;
    this.foot.replaceChildren();
    if (this.phase === 'analyzing') {
      this.foot.append(h('button', { class: 'btn block', onclick: () => { invoke('cancel_analysis'); this.app.go('games'); } }, 'Cancel'));
      return;
    }
    if (this.phase === 'summary') {
      this.foot.append(h('button', { class: 'btn primary big block', onclick: () => this.startReview(), html: `${icons.review} Start Review` }));
      return;
    }
    if (this.phase !== 'review') return;
    const nb = (ico, tip, fn, on = false) => h('button', { class: 'nb' + (on ? ' on' : ''), 'data-tip': tip, html: icons[ico], onclick: fn });
    const atEnd = this.ply >= this.n && !this.variation;
    const nextLabel = this.variation ? 'Back' : atEnd ? 'Summary' : 'Next';
    const next = h('button', {
      class: 'btn primary',
      html: `${nextLabel} ${icons.next}`,
      onclick: () => {
        if (this.variation) return this.exitVariation();
        if (atEnd) {
          this.phase = 'summary';
          this.renderSidebar();
          this.refreshBoardDecor();
          return;
        }
        this.step(1);
      },
    });
    this.foot.append(
      h(
        'div',
        { class: 'nav-ctrls' },
        nb('first', 'First move (Home)', () => this.goto(0, { fromUser: true })),
        nb('prev', 'Previous (←)', () => this.step(-1)),
        next,
        nb('key', 'Next key moment (↓)', () => this.keyMoment(1)),
        nb(this.autoplay ? 'pause' : 'play', 'Autoplay (Space)', () => this.toggleAutoplay(), !!this.autoplay),
      ),
    );
  }

  // ================================================================ misc
  copyPgn() {
    const nag = { brilliant: '$3', great: '$1', mistake: '$2', blunder: '$4', inaccuracy: '$6', miss: '$2' };
    const hd = this.headers;
    let s = Object.entries(hd).map(([k, v]) => `[${k} "${String(v).replace(/"/g, '\\"')}"]`).join('\n') + '\n\n';
    this.review.moves.forEach((m) => {
      if (m.color === 'w') s += `${m.moveNumber}. `;
      else if (m.ply === 1) s += `${m.moveNumber}... `;
      s += m.san + (nag[m.classification] ? ' ' + nag[m.classification] : '');
      const ev = this.review.positions[m.ply].eval;
      s += ` { ${CLS[m.classification]?.label || ''} (${evalText(ev)})${m.bestSan ? `. Best: ${m.bestSan}` : ''} } `;
    });
    s += this.review.result;
    navigator.clipboard.writeText(s).then(() => toast('Annotated PGN copied to clipboard'));
  }

  onKey(e) {
    if (e.target.closest('input,textarea,select')) return false;
    switch (e.key) {
      case 'ArrowRight': this.step(1); break;
      case 'ArrowLeft': this.step(-1); break;
      case 'ArrowDown': this.keyMoment(1); break;
      case 'ArrowUp': this.keyMoment(-1); break;
      case 'Home': this.goto(0, { fromUser: true }); break;
      case 'End': this.goto(this.n, { fromUser: true }); break;
      case 'f': case 'F': this.flip(); break;
      case 'b': case 'B': if (this.review && this.rmove(this.ply)?.bestSan) this.showBestLine(); break;
      case 'r': case 'R': if (this.rmove(this.ply)?.retry) this.startRetry(); break;
      case ' ': if (this.phase === 'review') this.toggleAutoplay(); break;
      case 'Escape':
        if (this.retry) this.exitRetry(false);
        else if (this.variation) this.exitVariation();
        else return false;
        break;
      default: return false;
    }
    e.preventDefault();
    return true;
  }
}
