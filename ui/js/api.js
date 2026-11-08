// Thin wrapper around the Tauri bridge.
const T = window.__TAURI__;

export const invoke = (cmd, args = {}) => T.core.invoke(cmd, args);
export const listen = (event, cb) => T.event.listen(event, (e) => cb(e.payload));
export const appWindow = () => T.window.getCurrentWindow();

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function toast(msg, kind = 'ok', ms = 3200) {
  const root = document.getElementById('toast-root');
  const t = h('div', { class: 'toast' + (kind === 'err' ? ' err' : '') }, msg);
  root.append(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 240);
  }, ms);
}

export function modal({ title, icon = '', body, foot, wide = false, onClose } = {}) {
  const root = document.getElementById('modal-root');
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose && onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const closeBtn = h('button', { class: 'icon-btn', onclick: close, html: (window.__icons || {}).close || '×' });
  const box = h(
    'div',
    { class: 'modal' + (wide ? ' wide' : '') },
    h('div', { class: 'modal-head' }, icon ? h('span', { html: icon, style: { display: 'flex' } }) : null, h('h2', {}, title), closeBtn),
    body,
    foot || null,
  );
  const back = h('div', { class: 'modal-back', onmousedown: (e) => e.target === back && close() }, box);
  root.append(back);
  document.addEventListener('keydown', onKey, true);
  return { close, box };
}

export function fmtClock(sec) {
  if (sec == null || isNaN(sec)) return '';
  const s = Math.max(0, sec);
  if (s >= 3600) {
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  const m = Math.floor(s / 60);
  const ss = s % 60;
  if (s < 20) return `${m}:${ss.toFixed(1).padStart(4, '0')}`;
  return `${m}:${String(Math.floor(ss)).padStart(2, '0')}`;
}

export function evalText(ev) {
  if (!ev) return '0.0';
  if (ev.mate != null) {
    if (ev.mate === 0) return '#';
    return (ev.mate > 0 ? '' : '-') + 'M' + Math.abs(ev.mate);
  }
  const v = (ev.cp || 0) / 100;
  return (v > 0 ? '+' : '') + v.toFixed(Math.abs(v) >= 10 ? 0 : 1).replace('-0.0', '0.0');
}

export function evalSide(ev) {
  if (!ev) return 'w';
  if (ev.mate != null) return ev.mate > 0 ? 'w' : ev.mate < 0 ? 'b' : 'w';
  return (ev.cp || 0) >= 0 ? 'w' : 'b';
}

export function winPct(ev) {
  if (!ev) return 50;
  let cp;
  if (ev.mate != null) cp = ev.mate > 0 ? 10000 : ev.mate < 0 ? -10000 : -10000;
  else cp = ev.cp || 0;
  cp = Math.max(-4000, Math.min(4000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export function timeAgo(sec) {
  const d = Date.now() / 1000 - sec;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} days ago`;
  return new Date(sec * 1000).toLocaleDateString();
}
