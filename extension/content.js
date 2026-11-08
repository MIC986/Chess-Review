// Chess Review — makes chess.com's own "Game Review" buttons open the Chess Review app.
// The buttons keep chess.com's native look; the popup decides where they lead.
(() => {
  let mode = 'app'; // 'app' | 'chesscom'

  try {
    chrome.storage.sync.get({ mode: 'app' }, (v) => {
      mode = v.mode;
      markAll();
    });
    chrome.storage.onChanged.addListener((ch) => {
      if (ch.mode) {
        mode = ch.mode.newValue;
        markAll();
      }
    });
  } catch {}

  /** {type, id} from a chess.com game / analysis URL. */
  function parseGame(href) {
    if (!href) return null;
    // Matches /game/live/123, /game/daily/123, /game/123 and /analysis/game/live/123
    const m = String(href).match(/\/(?:analysis\/)?game\/(?:(live|daily|computer)\/)?(\d{5,})/);
    if (!m || m[1] === 'computer') return null;
    return { type: m[1] || 'live', id: m[2] };
  }

  function userHint(href) {
    try {
      const q = new URL(href, location.origin).searchParams.get('username');
      if (q) return q;
    } catch {}
    const prof = location.pathname.match(/\/(?:member|games\/archive)\/([^/?#]+)/);
    return prof ? prof[1] : '';
  }

  /**
   * Is this element one of chess.com's "review this game" entry points?
   * Returns the game it reviews, or null.
   */
  function reviewTarget(el) {
    const a = el.closest('a[href], button, [role="button"]');
    if (!a) return null;
    const href = a.getAttribute('href') || '';
    const row = a.closest('.game-history-games-row');

    // Archive / profile rows: "Review" and accuracy links lead to the review.
    if (row) {
      const isReviewLink = /\/analysis\/game\//.test(href) || /^\s*(game\s+)?review\s*$/i.test(a.textContent || '');
      if (!isReviewLink) return null;
      const rowLink = row.querySelector('a.game-history-games-row-link');
      return parseGame(href) || parseGame(rowLink?.getAttribute('href'));
    }

    // Anything labelled "Game Review" (game page sidebar, game-over screen, menus…)
    const exact = (s) => /^\s*game review\s*$/i.test(s || '');
    const isGameReview = exact(a.getAttribute('aria-label')) || exact(a.textContent) || /[?&]tab=review\b/.test(href);
    if (!isGameReview) return null;
    // Don't hijack the tab switcher *inside* chess.com's analysis board.
    if (a.closest('[role="tablist"]')) return null;
    return parseGame(href) || parseGame(location.pathname) || gameFromPage();
  }

  /** On /play pages the URL may not contain the id; look for a game link on the page. */
  function gameFromPage() {
    const link = document.querySelector('a[href*="/game/"], a[href*="/analysis/game/"]');
    return parseGame(link?.getAttribute('href'));
  }

  function openInApp(game, user) {
    const params = new URLSearchParams({ type: game.type, id: game.id });
    if (user) params.set('user', user);
    const url = `chessreview://review?${params}`;
    if (typeof window.__crCapture === 'function') return window.__crCapture(url); // test hook
    console.debug('[Chess Review] opening', game, user);
    toast('Opening in Chess Review…');
    try {
      chrome.runtime.sendMessage({ type: 'open-review', game: { ...game, user } }, (res) => {
        if (chrome.runtime.lastError || !res || res.via === 'failed') {
          console.debug('[Chess Review] background unavailable, using link', chrome.runtime.lastError || res);
          window.location.href = url;
        }
      });
    } catch {
      // Extension was reloaded while the page stayed open: fall back to the app link.
      window.location.href = url;
    }
  }

  console.debug('[Chess Review] active on', location.pathname);

  // ------------------------------------------------------------ click interception
  function intercept(e) {
    if (mode !== 'app') return;
    if (e.type === 'click' && (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey)) return;
    if (e.type === 'auxclick') return;
    const game = reviewTarget(e.target);
    if (!game) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.type === 'click') openInApp(game, userHint(e.target.closest('a')?.href || location.href));
  }
  // Capture phase on window runs before chess.com's own handlers.
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    window.addEventListener(
      t,
      (e) => {
        if (t === 'click') intercept(e);
        else if (mode === 'app' && e.button === 0 && reviewTarget(e.target)) e.stopImmediatePropagation();
      },
      true,
    );
  }
  window.addEventListener('keydown', (e) => {
    if (mode !== 'app' || (e.key !== 'Enter' && e.key !== ' ')) return;
    const game = reviewTarget(e.target);
    if (!game) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openInApp(game, userHint(location.href));
  }, true);

  // ------------------------------------------------------------ tooltips (native look kept)
  function markAll() {
    for (const el of document.querySelectorAll('a[href*="/analysis/game/"], [aria-label="Game Review"], a[href*="tab=review"]')) {
      if (!reviewTarget(el)) continue;
      if (mode === 'app') {
        if (!el.dataset.crTitle) el.dataset.crTitle = el.getAttribute('title') || '';
        el.setAttribute('title', 'Opens in the Chess Review app');
      } else if (el.dataset.crTitle != null) {
        el.setAttribute('title', el.dataset.crTitle);
        if (!el.dataset.crTitle) el.removeAttribute('title');
        delete el.dataset.crTitle;
      }
    }
  }
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      markAll();
    }, 250);
  }).observe(document.documentElement, { childList: true, subtree: true });
  markAll();

  // ------------------------------------------------------------ toast
  let toastEl = null;
  function toast(text) {
    toastEl?.remove();
    const el = document.createElement('div');
    el.className = 'cr-toast';
    const img = document.createElement('img');
    try {
      img.src = chrome.runtime.getURL('icons/32.png');
    } catch {}
    const span = document.createElement('span');
    span.textContent = text;
    el.append(img, span);
    document.body.appendChild(el);
    toastEl = el;
    requestAnimationFrame(() => el.classList.add('cr-show'));
    setTimeout(() => {
      el.classList.remove('cr-show');
      setTimeout(() => el.remove(), 300);
    }, 2400);
  }
})();
