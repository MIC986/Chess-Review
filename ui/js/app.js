import { invoke, listen, appWindow, h, $, toast, modal } from './api.js';
import { icons } from './icons.js';
import { loadSettings, settings } from './settings.js';
import { GamesPage, HistoryPage, chesscomGame, openPgnModal } from './home.js';
import { ReviewView } from './review.js';
import { ProfilePage } from './profile.js';
import { openSettings } from './settings-view.js';

window.__icons = icons;

class App {
  constructor() {
    this.page = null;
    this.pages = {};
    this.review = null;
    this.view = $('#view');
  }

  async init() {
    await loadSettings();
    this.buildChrome();
    this.go('games');
    // Show the window only after the first paint to avoid a white flash.
    requestAnimationFrame(() => setTimeout(() => appWindow().show().catch(() => {}), 30));

    listen('deep-link', (url) => this.handleLink(url));
    const pending = await invoke('take_pending_link').catch(() => null);
    if (pending) this.handleLink(pending);

    const st = await invoke('engine_status', { custom: settings.customEngine || null }).catch(() => ({ installed: true }));
    if (!st.installed) this.requireEngine();

    if (settings.voiceEngine === 'kokoro') {
      const vs = await invoke('kokoro_status').catch(() => ({ installed: false }));
      if (vs.installed) invoke('kokoro_warm').catch(() => {});
      else if (st.installed && settings.voiceOn && !settings.voicePromptSeen) this.requireVoice();
    }

    document.addEventListener('keydown', (e) => {
      if (document.querySelector('.modal-back')) return;
      if (this.page === 'review' && this.review) this.review.onKey(e);
    });
  }

  buildChrome() {
    const win = appWindow();
    const maxBtn = h('button', { class: 'tb-btn', html: icons.max, onclick: () => win.toggleMaximize() });
    const tb = $('#titlebar');
    tb.replaceChildren(
      h('div', { class: 'tb-drag', 'data-tauri-drag-region': '' }, h('img', { class: 'tb-logo', src: 'logo.png', 'data-tauri-drag-region': '' }), h('span', { class: 'tb-title', 'data-tauri-drag-region': '', html: '<b>Chess</b> Review' })),
      h('button', { class: 'tb-btn', html: icons.min, onclick: () => win.minimize() }),
      maxBtn,
      h('button', { class: 'tb-btn close', html: icons.close, onclick: () => win.close() }),
    );
    const syncMax = async () => {
      const m = await win.isMaximized().catch(() => false);
      maxBtn.innerHTML = m ? icons.restore : icons.max;
    };
    win.onResized?.(() => syncMax());
    syncMax();

    const nav = $('#sidenav');
    const item = (id, label, ico, fn) => h('button', { class: 'nav-item', 'data-id': id, html: `${icons[ico]}<span>${label}</span>`, onclick: fn || (() => this.go(id)) });
    this.navReview = item('review', 'Review', 'review');
    nav.replaceChildren(
      item('games', 'Games', 'search'),
      item('profile', 'Profile', 'chart'),
      this.navReview,
      item('history', 'History', 'history'),
      item('pgn', 'PGN', 'pgn', () => openPgnModal(this)),
      h('div', { class: 'nav-spacer' }),
      item('settings', 'Settings', 'settings', () => openSettings(this)),
    );
    this.updateNav();
  }

  updateNav() {
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.id === this.page));
    this.navReview.classList.toggle('disabled', !this.review);
  }

  go(page) {
    if (page === 'review' && !this.review) return;
    if (this.page === 'profile' && page !== 'profile') this.pages.profile?.destroy();
    this.page = page;
    this.view.replaceChildren();
    if (page === 'games') {
      if (!this.pages.games) this.pages.games = new GamesPage(this);
      else this.pages.games.refreshReviewed().then(() => this.pages.games.renderTableOnly());
      this.view.append(this.pages.games.el);
    } else if (page === 'profile') {
      if (!this.pages.profile) this.pages.profile = new ProfilePage(this);
      this.view.append(this.pages.profile.el);
    } else if (page === 'history') {
      this.pages.history = new HistoryPage(this);
      this.view.append(this.pages.history.el);
    } else if (page === 'review') {
      this.review.mount(this.view);
    }
    this.updateNav();
  }

  openReview(game) {
    if (this.review) this.review.destroy();
    this.review = new ReviewView(game, this);
    this.go('review');
    this.review.start();
  }

  async handleLink(url) {
    // chessreview://review?type=live&id=123&user=name
    try {
      const u = new URL(url.replace(/^chessreview:\/\//i, 'https://x/'));
      const params = u.searchParams;
      let type = params.get('type') || 'live';
      let id = params.get('id');
      if (!id) {
        const parts = u.pathname.split('/').filter(Boolean);
        const n = parts.findIndex((p) => /^\d+$/.test(p));
        if (n >= 0) {
          id = parts[n];
          if (parts[n - 1] === 'daily') type = 'daily';
        }
      }
      if (!id) return;
      const t = this.loadingToast('Opening game from chess.com…');
      try {
        const g = await invoke('cc_resolve', { kind: type, id, user: params.get('user') || null });
        t.remove();
        this.openReview(chesscomGame(g, { viewer: params.get('user') || null }));
      } catch (e) {
        t.remove();
        toast(String(e), 'err', 5000);
      }
    } catch (e) {
      console.warn('bad link', url, e);
    }
  }

  loadingToast(text) {
    const root = document.getElementById('toast-root');
    const t = h('div', { class: 'toast' }, h('span', { class: 'spinner', style: { width: '16px', height: '16px', borderWidth: '2px' } }), text);
    root.append(t);
    return t;
  }

  requireVoice() {
    if (this.voiceModal || this.engineModal) return;
    settings.voicePromptSeen = true;
    const bar = h('div', { class: 'progress' }, h('i'));
    const info = h('div', { class: 'small', style: { color: 'var(--text-3)', fontSize: '12.5px', marginTop: '6px', minHeight: '18px' } }, '');
    const btn = h('button', { class: 'btn primary big block', html: `${icons.download} Install coach voices` });
    const later = h('button', { class: 'btn ghost block', style: { marginTop: '8px' } }, 'Not now (coach stays silent)');
    const body = h(
      'div',
      { class: 'modal-body', style: { textAlign: 'center', padding: '26px 30px 30px' } },
      h('div', { style: { width: '72px', height: '72px', margin: '0 auto', borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'radial-gradient(circle at 30% 25%, var(--accent-hover), var(--accent) 60%, var(--accent-shadow))', color: '#fff' }, html: icons.mic.replace('<svg', '<svg width="34" height="34"') }),
      h('h2', { style: { color: '#fff', margin: '16px 0 6px', fontSize: '22px' } }, 'Give your coach a real voice'),
      h('p', { style: { color: 'var(--text-2)', lineHeight: 1.55, margin: '0 0 18px' } }, 'Your coaches Maya, Leo and Bella speak with natural neural voices (Kokoro) that sound like real people, not robots. It is a one-time download of about 380 MB and runs completely offline.'),
      btn,
      later,
      h('div', { style: { height: '14px' } }),
      bar,
      info,
    );
    bar.style.visibility = 'hidden';
    const m = modal({ title: 'Coach voice', icon: `<span style="color:var(--accent);display:flex">${icons.mic}</span>`, body, onClose: () => (this.voiceModal = null) });
    this.voiceModal = m;
    later.onclick = () => m.close();
    btn.onclick = async () => {
      btn.disabled = true;
      later.style.display = 'none';
      btn.innerHTML = '<span class="spinner"></span> Installing…';
      bar.style.visibility = 'visible';
      bar.classList.add('indet');
      const un = await listen('install-progress', (p) => {
        if (p.what !== 'kokoro') return;
        if (!p.total) {
          bar.classList.add('indet');
          info.textContent = p.label + '…';
          return;
        }
        bar.classList.remove('indet');
        bar.firstChild.style.width = `${(p.got / p.total) * 100}%`;
        info.textContent = `${p.label} · ${(p.got / 1048576).toFixed(0)} / ${(p.total / 1048576).toFixed(0)} MB`;
      });
      try {
        await invoke('kokoro_install');
        un();
        const voice = await import('./voice.js');
        await voice.kokoroInstalled(true);
        settings.voiceEngine = 'kokoro';
        m.close();
        toast('Coach voices installed');
        const { COACHES } = await import('./coaches.js');
        const c = COACHES[settings.coach] || COACHES.leo;
        voice.speak(c.hello, { force: true });
      } catch (e) {
        un();
        btn.disabled = false;
        btn.innerHTML = `${icons.refresh} Try again`;
        info.textContent = String(e);
      }
    };
  }

  requireEngine(after) {
    if (this.engineModal) return;
    const bar = h('div', { class: 'progress' }, h('i'));
    const info = h('div', { class: 'small' }, '');
    const btn = h('button', { class: 'btn primary big block', html: `${icons.download} Download Stockfish` });
    const body = h(
      'div',
      { class: 'modal-body', style: { textAlign: 'center', padding: '26px 30px 30px' } },
      h('img', { src: 'logo.png', style: { width: '72px', height: '72px', borderRadius: '16px', boxShadow: '0 8px 24px rgba(0,0,0,.4)' } }),
      h('h2', { style: { color: '#fff', margin: '16px 0 6px', fontSize: '22px' } }, 'One quick setup step'),
      h('p', { style: { color: 'var(--text-2)', lineHeight: 1.55, margin: '0 0 18px' } }, 'Game reviews are powered by Stockfish, the strongest open-source chess engine. It is downloaded once from the official release page (about 80 MB) and runs fully on your computer.'),
      btn,
      h('div', { style: { height: '14px' } }),
      bar,
      info,
    );
    bar.style.visibility = 'hidden';
    const m = modal({ title: 'Analysis engine', icon: `<span style="color:var(--accent);display:flex">${icons.cpu}</span>`, body, onClose: () => (this.engineModal = null) });
    this.engineModal = m;
    let unlisten = null;
    btn.onclick = async () => {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Downloading…';
      bar.style.visibility = 'visible';
      bar.classList.add('indet');
      unlisten = await listen('install-progress', (p) => {
        if (p.what !== 'engine' || !p.total) return;
        bar.classList.remove('indet');
        bar.firstChild.style.width = `${(p.got / p.total) * 100}%`;
        info.textContent = `${(p.got / 1048576).toFixed(1)} / ${(p.total / 1048576).toFixed(1)} MB`;
      });
      try {
        await invoke('install_engine');
        unlisten && unlisten();
        m.close();
        toast('Stockfish is ready — enjoy your reviews!');
        after && after();
        if (settings.voiceEngine === 'kokoro' && !settings.voicePromptSeen) setTimeout(() => this.requireVoice(), 400);
      } catch (e) {
        unlisten && unlisten();
        btn.disabled = false;
        btn.innerHTML = `${icons.refresh} Try again`;
        info.textContent = String(e);
      }
    };
  }
}

const app = new App();
window.app = app;
app.init().catch((e) => {
  console.error(e);
  appWindow().show();
});
