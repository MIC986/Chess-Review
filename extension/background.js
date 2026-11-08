// Chess Review — opens reviews in the desktop app.
// 1) If the app is running: talk to it directly over its local bridge (instant, no prompt).
// 2) Otherwise: launch it with a chessreview:// link (the browser asks once to allow it).

const BRIDGE = 'http://127.0.0.1:47321';

async function bridge(path, timeout = 900) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(BRIDGE + path, { signal: ctrl.signal, cache: 'no-store' });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function openReview(game, tabId) {
  const q = new URLSearchParams({ type: game.type || 'live', id: game.id });
  if (game.user) q.set('user', game.user);
  if (await bridge('/open?' + q)) return { via: 'bridge' };
  // App not running: launch it through its link handler.
  const url = 'chessreview://review?' + q;
  try {
    if (tabId != null) await chrome.tabs.update(tabId, { url });
    else await chrome.tabs.create({ url, active: false });
    return { via: 'protocol' };
  } catch (e) {
    return { via: 'failed', error: String(e) };
  }
}

/** Bring the app forward, or start it if it isn't running. */
async function launchApp() {
  if (await bridge('/show')) return { ok: true, via: 'bridge' };
  // Extension pages may not launch app links themselves; a short-lived background tab can.
  try {
    // Visible, so the browser's "Open Chess Review?" prompt can be answered.
    const tab = await chrome.tabs.create({ url: 'chessreview://open', active: true });
    // Close the helper tab once the app answers (or after 30 s).
    (async () => {
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await bridge('/ping', 500)) break;
      }
      chrome.tabs.remove(tab.id).catch(() => {});
    })();
    return { ok: true, via: 'protocol' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'open-review') {
    openReview(msg.game, sender.tab?.id).then(reply);
    return true;
  }
  if (msg?.type === 'ping-app') {
    bridge('/ping', 700).then((ok) => reply({ ok }));
    return true;
  }
  if (msg?.type === 'launch-app') {
    launchApp().then(reply);
    return true;
  }
});
