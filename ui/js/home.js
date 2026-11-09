// Games (chess.com browser) and History pages.
import { invoke, h, esc, toast, modal, timeAgo } from './api.js';
import { icons, TC_ICON } from './icons.js';
import { settings } from './settings.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (ym) => {
  const [y, m] = ym.split('/');
  return `${MONTHS[+m - 1]} ${y}`;
};

function hashStr(s) {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  return (h1 >>> 0).toString(36);
}

export function pgnGame(pgn) {
  return { pgn, key: 'pgn-' + hashStr(pgn.trim()), meta: { source: 'pgn' } };
}

export function chesscomGame(g, extra = {}) {
  return {
    pgn: g.pgn,
    key: `cc-${g.id}`,
    meta: {
      source: 'chesscom',
      viewer: extra.viewer || null,
      id: g.id,
      url: g.url,
      timeClass: g.timeClass,
      accuracies: g.accuracies || null,
      white: { username: g.white?.username, rating: g.white?.rating, avatar: extra.whiteAvatar || null },
      black: { username: g.black?.username, rating: g.black?.rating, avatar: extra.blackAvatar || null },
    },
  };
}

export function openPgnModal(app) {
  const ta = h('textarea', { class: 'input', rows: 12, placeholder: '[Event "..."]\n\n1. e4 e5 2. Nf3 Nc6 ...', spellcheck: 'false' });
  const go = async () => {
    const pgn = ta.value.trim();
    if (!pgn) return;
    try {
      const info = await invoke('parse_pgn_info', { pgn });
      if (!info.moves) throw 'This PGN has no moves';
      m.close();
      app.openReview(pgnGame(pgn));
    } catch (e) {
      toast(String(e), 'err');
    }
  };
  const m = modal({
    title: 'Review a PGN',
    icon: icons.pgn,
    body: h('div', { class: 'modal-body' }, h('p', { style: { margin: '0 0 12px', color: 'var(--text-2)' } }, 'Paste a game in PGN format from any site or database.'), ta),
    foot: h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: go, html: `${icons.review} Review game` })),
  });
  setTimeout(() => ta.focus(), 50);
}

// ====================================================================== Games
export class GamesPage {
  constructor(app) {
    this.app = app;
    this.el = h('div', { class: 'view-page' });
    this.user = null;
    this.profile = null;
    this.archives = [];
    this.month = null;
    this.games = [];
    this.filter = 'all';
    this.query = '';
    this.reviewed = new Map();
    this.render();
    const start = settings.lastSearch || settings.username;
    if (start) this.load(start);
  }

  async refreshReviewed() {
    const hist = await invoke('history_list').catch(() => []);
    this.reviewed = new Map(hist.map((x) => [x.key, x]));
  }

  render() {
    const input = h('input', { class: 'input', placeholder: 'chess.com username', value: this.user || settings.lastSearch || settings.username || '', spellcheck: 'false', onkeydown: (e) => e.key === 'Enter' && this.load(input.value) });
    this.input = input;
    const searchRow = h(
      'div',
      { class: 'search-row' },
      h('div', { class: 'input-wrap', html: icons.user }, input),
      h('button', { class: 'btn primary', onclick: () => this.load(input.value), html: `${icons.search} Show games` }),
      h('button', { class: 'btn ghost', 'data-tip': 'Review a PGN', onclick: () => openPgnModal(this.app), html: icons.pgn }),
    );
    const compact = !!(this.user || settings.lastSearch || settings.username);
    const top = compact
      ? h('div', { class: 'searchbar' }, searchRow)
      : h('div', { class: 'hero' }, h('div', { style: { flex: 1, position: 'relative', zIndex: 1 } }, h('h1', {}, 'Review your games'), h('p', {}, 'Enter your chess.com username to load your games.'), searchRow));
    this.content = h('div');
    this.el.replaceChildren(h('div', { class: 'page-wrap' }, top, this.content));
    this.renderContent();
  }

  async load(username) {
    username = (username || '').trim();
    if (!username) return;
    this.user = username;
    this.loading = true;
    this.error = null;
    this.profile = null;
    this.games = [];
    this.renderContent();
    try {
      const [profile, archives] = await Promise.all([invoke('cc_profile', { username }), invoke('cc_archives', { username })]);
      this.profile = profile;
      this.archives = archives;
      settings.lastSearch = profile.username;
      if (!settings.username) settings.username = profile.username;
      await this.refreshReviewed();
      if (!archives.length) {
        this.loading = false;
        this.renderContent();
        return;
      }
      await this.loadMonth(archives[0], true);
    } catch (e) {
      this.error = String(e);
      this.loading = false;
      this.renderContent();
    }
  }

  async loadMonth(ym, allowFallback = false) {
    this.month = ym;
    this.loading = true;
    this.renderContent();
    try {
      this.games = await invoke('cc_month', { username: this.user, month: ym });
      if (!this.games.length && allowFallback && this.archives[1]) return this.loadMonth(this.archives[1]);
    } catch (e) {
      if (allowFallback && this.archives[1]) return this.loadMonth(this.archives[1]);
      this.error = String(e);
    }
    this.loading = false;
    this.renderContent();
  }

  renderContent() {
    const c = this.content;
    if (!c) return;
    c.replaceChildren();
    if (this.error) {
      c.append(h('div', { class: 'games-table' }, h('div', { class: 'empty-state', html: `${icons.info}<h3>Couldn't load games</h3><div>${esc(this.error)}</div>` })));
      return;
    }
    if (!this.user) {
      c.append(this.recentStrip());
      return;
    }
    if (this.profile) c.append(this.profileCard());
    else if (this.loading) c.append(h('div', { class: 'profile-card' }, h('div', { class: 'skeleton', style: { width: '64px', height: '64px' } }), h('div', { style: { flex: 1 } }, h('div', { class: 'skeleton', style: { width: '180px', height: '20px' } }), h('div', { class: 'skeleton', style: { width: '120px', height: '14px', marginTop: '8px' } }))));

    if (this.archives.length) c.append(this.filtersEl());
    const table = h('div', { class: 'games-table' });
    table.append(
      h('div', { class: 'gt-head' }, h('div', {}), h('div', {}, 'Players'), h('div', {}, 'Result'), h('div', {}, 'Accuracy'), h('div', {}, 'Moves'), h('div', {}, 'Date'), h('div', {})),
    );
    if (this.loading) {
      for (let i = 0; i < 7; i++) table.append(h('div', { class: 'gt-row', style: { cursor: 'default' } }, h('div', {}), h('div', {}, h('div', { class: 'skeleton', style: { width: '60%', height: '14px', marginBottom: '8px' } }), h('div', { class: 'skeleton', style: { width: '50%', height: '14px' } }))));
    } else {
      const list = this.filtered();
      if (!list.length) table.append(h('div', { class: 'empty-state', html: `${icons.board}<h3>No games here</h3><div>Try another month or time control.</div>` }));
      list.forEach((g, i) => table.append(this.row(g, i)));
    }
    c.append(table);
  }

  recentStrip() {
    return h('div', { class: 'empty-state', html: `${icons.search}<h3>Find your games</h3><div>Your username is remembered, so next time your games load automatically.</div>` });
  }

  profileCard() {
    const p = this.profile;
    const r = p.ratings || {};
    const isMe = settings.username?.toLowerCase() === p.username.toLowerCase();
    const chip = (key, label) =>
      r[key] ? h('div', { class: 'rating-chip', 'data-tip': label, html: `<span class="tc-${key}">${icons[TC_ICON[key]]}</span><b>${r[key]}</b><span class="lbl">${label}</span>` }) : null;
    const joined = p.joined ? new Date(p.joined * 1000).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '';
    return h(
      'div',
      { class: 'profile-card' },
      p.avatar ? h('img', { class: 'avatar', src: p.avatar }) : h('div', { class: 'avatar avatar-fallback', style: { fontSize: '24px' } }, p.username[0].toUpperCase()),
      h(
        'div',
        { class: 'pc-main' },
        h(
          'div',
          { class: 'pname' },
          p.title ? h('span', { class: 'title-badge' }, p.title) : null,
          p.username,
          p.country ? h('span', { class: 'country-badge' }, p.country) : null,
          isMe ? h('span', { class: 'me-badge' }, 'You') : null,
          h('button', { class: 'icon-btn tiny', 'data-tip': 'Open profile on chess.com', html: icons.external, onclick: () => invoke('open_url', { url: p.url || `https://www.chess.com/member/${p.username}` }) }),
        ),
        h(
          'div',
          { class: 'psub' },
          [p.name, joined && `Joined ${joined}`].filter(Boolean).join(' · '),
          !isMe
            ? h('button', { class: 'link-btn', onclick: () => { settings.username = p.username; toast(`Got it: you are ${p.username}.`); this.renderContent(); } }, 'This is me')
            : null,
        ),
      ),
      h('div', { class: 'ratings' }, chip('bullet', 'Bullet'), chip('blitz', 'Blitz'), chip('rapid', 'Rapid'), chip('daily', 'Daily')),
    );
  }

  filtersEl() {
    const chip = (id, label, ico) =>
      h('button', { class: 'chip' + (this.filter === id ? ' active' : ''), onclick: () => { this.filter = id; this.renderContent(); }, html: (ico ? icons[ico] : '') + label });
    const sel = h('select', { class: 'input', onchange: (e) => this.loadMonth(e.target.value) }, ...this.archives.map((a) => h('option', { value: a, selected: a === this.month ? true : null }, monthLabel(a))));
    const q = h('input', { class: 'input', placeholder: 'Filter by opponent…', value: this.query, style: { height: '34px', width: '200px', fontSize: '13px' }, oninput: (e) => { this.query = e.target.value; this.renderTableOnly(); } });
    return h(
      'div',
      { class: 'filters' },
      chip('all', 'All'),
      chip('bullet', 'Bullet', 'bullet'),
      chip('blitz', 'Blitz', 'bolt'),
      chip('rapid', 'Rapid', 'timer'),
      chip('daily', 'Daily', 'sun'),
      h('div', { class: 'grow' }),
      q,
      sel,
    );
  }

  renderTableOnly() {
    const table = this.content.querySelector('.games-table');
    if (!table) return;
    table.querySelectorAll('.gt-row,.empty-state').forEach((r) => r.remove());
    const list = this.filtered();
    if (!list.length) table.append(h('div', { class: 'empty-state', html: `${icons.board}<h3>No games here</h3>` }));
    list.forEach((g, i) => table.append(this.row(g, i)));
  }

  filtered() {
    const q = this.query.trim().toLowerCase();
    return this.games.filter((g) => {
      if (g.rules && g.rules !== 'chess') return false;
      if (this.filter !== 'all' && g.timeClass !== this.filter) return false;
      if (q && !`${g.white.username} ${g.black.username}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  row(g, i) {
    const me = this.user.toLowerCase();
    const myColor = g.white.username?.toLowerCase() === me ? 'white' : g.black.username?.toLowerCase() === me ? 'black' : null;
    const wr = g.white.result;
    const score = wr === 'win' ? ['1', '0'] : g.black.result === 'win' ? ['0', '1'] : ['½', '½'];
    let res = 'draw';
    if (myColor) {
      const r = g[myColor].result;
      res = r === 'win' ? 'win' : ['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'].includes(r) ? 'draw' : 'loss';
    } else res = wr === 'win' ? 'win' : g.black.result === 'win' ? 'loss' : 'draw';
    const resIcon = { win: icons.plus, loss: icons.min, draw: icons.equal }[res];
    const reviewed = this.reviewed.get(`cc-${g.id}`);
    const acc = reviewed?.accuracy || g.accuracies;
    const accEl = acc
      ? h('div', { class: 'gt-acc' }, h('span', {}, Number(acc.white).toFixed(1)), h('span', {}, Number(acc.black).toFixed(1)))
      : h('div', { class: 'gt-acc' }, h('span', { class: 'na' }, '—'));
    const date = g.endTime ? new Date(g.endTime * 1000) : null;
    const sameYear = date && date.getFullYear() === new Date().getFullYear();
    const player = (side) =>
      h(
        'div',
        { class: 'gt-player' },
        h('span', { class: 'sqc ' + (side === 'white' ? 'w' : 'b') }),
        h('span', { class: 'nm' + (myColor === side ? ' me' : '') }, g[side].username),
        h('span', { class: 'rt' }, `(${g[side].rating})`),
      );
    const open = () => {
      const extra = {};
      if (this.profile?.avatar) {
        if (myColor === 'white') extra.whiteAvatar = this.profile.avatar;
        if (myColor === 'black') extra.blackAvatar = this.profile.avatar;
      }
      extra.viewer = this.profile?.username || this.user;
      this.app.openReview(chesscomGame(g, extra));
    };
    const row = h(
      'div',
      { class: 'gt-row', style: { animationDelay: `${Math.min(i, 20) * 18}ms` }, onclick: open },
      h('div', { class: 'gt-tc', html: `<span class="tc-${g.timeClass}" style="display:flex">${icons[TC_ICON[g.timeClass]] || icons.timer}</span>` }),
      h('div', { class: 'gt-players' }, player('white'), player('black'), g.opening ? h('div', { class: 'gt-opening' }, g.opening) : null),
      h('div', { class: 'gt-result' }, h('div', { class: 'scores' }, h('span', {}, score[0]), h('span', {}, score[1])), h('div', { class: `res-icon ${res}`, html: resIcon })),
      accEl,
      h('div', { class: 'gt-moves' }, g.moves || '—'),
      h('div', { class: 'gt-date', title: date ? date.toLocaleString() : '' }, date ? date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }) : ''),
      h('div', { class: 'gt-review' }, h('button', { class: 'row-act' + (reviewed ? ' done' : ''), 'data-tip': reviewed ? 'Reviewed: open' : 'Review', onclick: (e) => { e.stopPropagation(); open(); }, html: reviewed ? icons.check : icons.review })),
    );
    return row;
  }
}

// ====================================================================== History
export class HistoryPage {
  constructor(app) {
    this.app = app;
    this.el = h('div', { class: 'view-page' });
    this.load();
  }

  async load() {
    const list = await invoke('history_list').catch(() => []);
    const grid = h('div', { class: 'history-grid' });
    for (const [i, x] of list.entries()) {
      const meIsBlack = settings.username && x.black?.toLowerCase() === settings.username.toLowerCase();
      void meIsBlack;
      const res = x.result === '1-0' ? '1–0' : x.result === '0-1' ? '0–1' : x.result === '1/2-1/2' ? '½–½' : '*';
      const del = h('button', {
        class: 'icon-btn hc-del',
        'data-tip': 'Remove',
        html: icons.trash,
        onclick: async (e) => {
          e.stopPropagation();
          await invoke('history_remove', { key: x.key });
          card.style.transition = 'opacity 200ms, transform 200ms';
          card.style.opacity = '0';
          card.style.transform = 'scale(0.96)';
          setTimeout(() => card.remove(), 200);
        },
      });
      const card = h(
        'div',
        { class: 'hcard', style: { animationDelay: `${Math.min(i, 20) * 25}ms` }, onclick: () => this.open(x) },
        h('div', { class: 'hc-top' }, h('span', {}, x.date || ''), h('span', {}, `${res} · ${x.moves} moves · reviewed ${timeAgo(x.analyzedAt)}`)),
        h('div', { class: 'hc-p' }, h('span', { class: 'nm' }, h('span', { class: 'sqc', style: { width: '11px', height: '11px', background: '#f0f0f0', borderRadius: '2px', display: 'inline-block' } }), x.white, x.whiteElo ? h('span', { style: { color: 'var(--text-3)', fontWeight: 600 } }, `(${x.whiteElo})`) : null), h('span', { class: 'acc-pill w' }, Number(x.accuracy?.white || 0).toFixed(1))),
        h('div', { class: 'hc-p' }, h('span', { class: 'nm' }, h('span', { class: 'sqc', style: { width: '11px', height: '11px', background: '#1b1a18', borderRadius: '2px', display: 'inline-block', boxShadow: 'inset 0 0 0 1px #5d5b58' } }), x.black, x.blackElo ? h('span', { style: { color: 'var(--text-3)', fontWeight: 600 } }, `(${x.blackElo})`) : null), h('span', { class: 'acc-pill b' }, Number(x.accuracy?.black || 0).toFixed(1))),
        x.opening ? h('div', { class: 'hc-open' }, x.opening) : null,
        del,
      );
      grid.append(card);
    }
    const clearBtn = list.length
      ? h('button', { class: 'btn small danger', onclick: async () => { await invoke('history_clear'); this.load(); }, html: `${icons.trash} Clear history` })
      : null;
    this.el.replaceChildren(
      h(
        'div',
        { class: 'page-wrap' },
        h('div', { class: 'page-title', html: `${icons.history}<span style="flex:1">Reviewed games</span>` }, clearBtn),
        list.length ? grid : h('div', { class: 'games-table' }, h('div', { class: 'empty-state', html: `${icons.history}<h3>No reviews yet</h3><div>Games you review are saved here so you can reopen them instantly.</div>` })),
      ),
    );
  }

  async open(x) {
    const r = await invoke('load_review', { key: x.key }).catch(() => null);
    if (!r) return toast('This review is no longer available', 'err');
    const clk = (c) => {
      if (c == null) return '';
      const hh = Math.floor(c / 3600);
      const mm = Math.floor((c % 3600) / 60);
      const ss = (c % 60).toFixed(1);
      return ` {[%clk ${hh}:${String(mm).padStart(2, '0')}:${ss.padStart(4, '0')}]}`;
    };
    const pgn = Object.entries(r.headers).map(([k, v]) => `[${k} "${v}"]`).join('\n') + '\n\n' + r.moves.map((m) => (m.color === 'w' ? `${m.moveNumber}. ` : m.ply === 1 ? `${m.moveNumber}... ` : '') + m.san + clk(m.clock)).join(' ') + ' ' + r.result;
    this.app.openReview({ pgn, key: x.key, meta: r.meta || {} });
  }
}
