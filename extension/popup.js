const opts = [...document.querySelectorAll('.opt')];
const store = chrome.storage?.sync || chrome.storage?.local || null;

function render(mode) {
  opts.forEach((o) => o.classList.toggle('active', o.dataset.mode === mode));
}

if (store) store.get({ mode: 'app' }, (v) => render(v?.mode || 'app'));
else render('app');

opts.forEach((o) =>
  o.addEventListener('click', () => {
    store?.set({ mode: o.dataset.mode });
    render(o.dataset.mode);
  }),
);

const dot = document.getElementById('dot');
const status = document.getElementById('status');
const openBtn = document.getElementById('open');

function setStatus(ok) {
  dot.className = 'dot ' + (ok ? 'ok' : 'off');
  status.textContent = ok ? 'Chess Review is running. Reviews open instantly.' : 'Chess Review is not running. It starts when you open a review.';
}

chrome.runtime.sendMessage({ type: 'ping-app' }, (r) => {
  void chrome.runtime.lastError;
  setStatus(!!r?.ok);
});

openBtn.addEventListener('click', () => {
  openBtn.disabled = true;
  openBtn.textContent = 'Opening…';
  chrome.runtime.sendMessage({ type: 'launch-app' }, () => {
    void chrome.runtime.lastError;
    window.close();
  });
});
