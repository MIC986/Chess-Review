// Chess board view: animated pieces, drag & drop, arrows, badges.
import { h } from './api.js';
import { clsIcon, CLS } from './icons.js';
import { settings, pieceUrl } from './settings.js';

const FILES = 'abcdefgh';

export function parseFen(fen) {
  const map = new Map();
  const rows = fen.split(' ')[0].split('/');
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) f += +ch;
      else {
        const color = ch === ch.toUpperCase() ? 'w' : 'b';
        map.set(FILES[f] + (8 - r), color + ch.toUpperCase());
        f++;
      }
    }
  }
  return map;
}

export function fenTurn(fen) {
  return (fen.split(' ')[1] || 'w')[0];
}

const sqXY = (sq) => [FILES.indexOf(sq[0]), +sq[1] - 1];

export class Board {
  constructor(container) {
    this.orientation = 'w';
    this.fen = '8/8/8/8/8/8/8/8 w - - 0 1';
    this.pieces = []; // {el, code, sq}
    this.interactive = null; // {color, dests: Map, onMove}
    this.selected = null;
    this.userArrows = [];
    this.userMarks = new Set();
    this.arrows = [];
    this.noAnim = new Set();

    this.el = h('div', { class: 'board' });
    this.squaresEl = h('div', { class: 'squares' });
    this.piecesEl = h('div', { class: 'pieces' });
    this.arrowsEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.arrowsEl.setAttribute('class', 'arrows');
    this.arrowsEl.setAttribute('viewBox', '0 0 800 800');
    this.badgesEl = h('div', { class: 'badges' });
    this.el.append(this.squaresEl, this.piecesEl, this.arrowsEl, this.badgesEl);
    container.append(this.el);

    this.sqEls = new Map();
    this.buildSquares();
    this.bindPointer();
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ------------------------------------------------------------ layout
  buildSquares() {
    this.squaresEl.innerHTML = '';
    this.sqEls.clear();
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const [f, r] = this.orientation === 'w' ? [x, 7 - y] : [7 - x, y];
        const sq = FILES[f] + (r + 1);
        const light = (f + r) % 2 === 1;
        const el = h('div', { class: 'sq ' + (light ? 'l' : 'd'), 'data-sq': sq }, h('div', { class: 'ov' }));
        if (x === 0) el.append(h('span', { class: 'coord rank' }, r + 1));
        if (y === 7) el.append(h('span', { class: 'coord file' }, FILES[f]));
        this.squaresEl.append(el);
        this.sqEls.set(sq, el);
      }
    }
    this.applyCoords();
  }

  applyCoords() {
    this.el.classList.toggle('coords-off', settings.coords === 'off');
  }

  xy(sq) {
    const [f, r] = sqXY(sq);
    return this.orientation === 'w' ? [f, 7 - r] : [7 - f, r];
  }

  sqAt(clientX, clientY) {
    const rect = this.el.getBoundingClientRect();
    const x = Math.floor(((clientX - rect.left) / rect.width) * 8);
    const y = Math.floor(((clientY - rect.top) / rect.height) * 8);
    if (x < 0 || x > 7 || y < 0 || y > 7) return null;
    const [f, r] = this.orientation === 'w' ? [x, 7 - y] : [7 - x, y];
    return FILES[f] + (r + 1);
  }

  place(el, sq) {
    const [x, y] = this.xy(sq);
    el.style.transform = `translate(${x * 100}%, ${y * 100}%)`;
  }

  setOrientation(o) {
    if (o === this.orientation) return;
    this.orientation = o;
    this.buildSquares();
    for (const p of this.pieces) {
      p.el.style.transition = 'none';
      this.place(p.el, p.sq);
    }
    requestAnimationFrame(() => this.pieces.forEach((p) => (p.el.style.transition = '')));
    this.renderHighlights();
    this.renderArrows();
    this.renderBadge();
  }

  flip() {
    this.setOrientation(this.orientation === 'w' ? 'b' : 'w');
  }

  refreshPieceSet() {
    for (const p of this.pieces) p.el.style.backgroundImage = `url(${pieceUrl(p.code[0], p.code[1])})`;
  }

  // ------------------------------------------------------------ position
  setPosition(fen, { animate = true } = {}) {
    this.fen = fen;
    this.cancelPromotion();
    const next = parseFen(fen);
    const old = this.pieces.map((p) => ({ ...p, used: false }));
    const result = [];
    const pending = [];
    // 1) unchanged pieces
    for (const [sq, code] of next) {
      const o = old.find((p) => !p.used && p.sq === sq && p.code === code);
      if (o) {
        o.used = true;
        result.push({ el: o.el, code, sq });
      } else pending.push([sq, code]);
    }
    // 2) moved pieces (closest same type)
    const created = [];
    for (const [sq, code] of pending) {
      const [tx, ty] = sqXY(sq);
      let best = null;
      let bd = 1e9;
      for (const o of old) {
        if (o.used || o.code !== code) continue;
        const [ox, oy] = sqXY(o.sq);
        const d = Math.abs(ox - tx) + Math.abs(oy - ty);
        if (d < bd) {
          bd = d;
          best = o;
        }
      }
      if (best && pending.length <= 6) {
        best.used = true;
        const el = best.el;
        if (!animate || this.noAnim.has(sq)) el.style.transition = 'none';
        el.classList.remove('dragging', 'ghost');
        el.style.zIndex = 5;
        this.place(el, sq);
        if (!animate || this.noAnim.has(sq)) requestAnimationFrame(() => (el.style.transition = ''));
        setTimeout(() => (el.style.zIndex = ''), settings.animMs + 30);
        result.push({ el, code, sq });
      } else {
        const el = h('div', { class: 'piece' + (animate ? ' appear' : '') });
        el.style.backgroundImage = `url(${pieceUrl(code[0], code[1])})`;
        el.style.transition = 'none';
        this.place(el, sq);
        this.piecesEl.append(el);
        requestAnimationFrame(() => (el.style.transition = ''));
        created.push(el);
        result.push({ el, code, sq });
      }
    }
    // 3) removed pieces
    for (const o of old) {
      if (o.used) continue;
      if (animate) {
        o.el.classList.add('fading');
        setTimeout(() => o.el.remove(), 200);
      } else o.el.remove();
    }
    this.noAnim.clear();
    this.pieces = result;
    this.selected = null;
    this.renderHighlights();
  }

  pieceAt(sq) {
    return this.pieces.find((p) => p.sq === sq);
  }

  // ------------------------------------------------------------ highlights
  setHighlights({ last = null, cls = null, check = null } = {}) {
    this.hl = { last, cls, check };
    this.renderHighlights();
  }

  renderHighlights() {
    const hl = this.hl || {};
    for (const [sq, el] of this.sqEls) {
      el.classList.remove('hl-last', 'hl-sel', 'hl-class', 'hl-check', 'hl-red');
      el.querySelectorAll('.dot,.ring').forEach((d) => d.remove());
      el.style.removeProperty('--clscol');
    }
    if (hl.last && settings.highlightLast) {
      const useCls = hl.cls && settings.classHighlight && CLS[hl.cls];
      for (const sq of hl.last) {
        const el = this.sqEls.get(sq);
        if (!el) continue;
        if (useCls) {
          el.classList.add('hl-class');
          el.style.setProperty('--clscol', CLS[hl.cls].color);
        } else el.classList.add('hl-last');
      }
    }
    if (hl.check) this.sqEls.get(hl.check)?.classList.add('hl-check');
    for (const sq of this.userMarks) this.sqEls.get(sq)?.classList.add('hl-red');
    if (this.selected) {
      this.sqEls.get(this.selected)?.classList.add('hl-sel');
      if (settings.showLegal) {
        const dests = this.interactive?.dests?.get(this.selected) || [];
        for (const d of dests) {
          const el = this.sqEls.get(d);
          if (!el) continue;
          el.append(h('div', { class: this.pieceAt(d) ? 'ring' : 'dot' }));
        }
      }
    }
  }

  // ------------------------------------------------------------ badge
  setBadge(sq, cls) {
    this.badge = sq && cls ? { sq, cls } : null;
    this.renderBadge(true);
  }

  renderBadge(animate = false) {
    this.badgesEl.innerHTML = '';
    if (!this.badge || !settings.showBadges) return;
    const [x, y] = this.xy(this.badge.sq);
    const el = h('div', { class: 'badge', html: clsIcon(this.badge.cls, '') });
    const edgeX = x === 7 ? 0.82 : 0.9;
    const edgeY = y === 0 ? 0.18 : 0.1;
    el.style.left = `${(x + edgeX) * 12.5}%`;
    el.style.top = `${(y + edgeY) * 12.5}%`;
    if (!animate) el.style.animation = 'none';
    this.badgesEl.append(el);
  }

  // ------------------------------------------------------------ arrows
  setArrows(arrows) {
    this.arrows = arrows || [];
    this.renderArrows();
  }

  clearUserMarks() {
    if (!this.userArrows.length && !this.userMarks.size) return;
    this.userArrows = [];
    this.userMarks.clear();
    this.renderArrows();
    this.renderHighlights();
  }

  renderArrows() {
    const all = [...this.arrows, ...this.userArrows.map((a) => ({ ...a, color: 'rgba(255,170,0,1)', opacity: 0.8 }))];
    this.arrowsEl.innerHTML = all.map((a) => this.arrowSvg(a)).join('');
  }

  arrowSvg({ from, to, color = '#96bc4b', opacity = 0.82, width = 1 }) {
    const [x1, y1] = this.xy(from).map((v) => v * 100 + 50);
    const [x2, y2] = this.xy(to).map((v) => v * 100 + 50);
    const dxs = Math.abs(x2 - x1) / 100;
    const dys = Math.abs(y2 - y1) / 100;
    const sw = 17 * width;
    const headW = 44 * width;
    const headL = 36 * width;
    let pts;
    if ((dxs === 1 && dys === 2) || (dxs === 2 && dys === 1)) {
      // Knight: L-shaped arrow (long leg first)
      const corner = dys > dxs ? [x1, y2] : [x2, y1];
      pts = [[x1, y1], corner, [x2, y2]];
    } else pts = [[x1, y1], [x2, y2]];
    // shorten end for head, start offset
    const [px, py] = pts[pts.length - 2];
    const ang = Math.atan2(y2 - py, x2 - px);
    const ex = x2 - Math.cos(ang) * headL;
    const ey = y2 - Math.sin(ang) * headL;
    const [sx, sy] = pts[0];
    const ang0 = Math.atan2(pts[1][1] - sy, pts[1][0] - sx);
    const startOff = pts.length === 2 ? 18 : 0;
    const p0 = [sx + Math.cos(ang0) * startOff, sy + Math.sin(ang0) * startOff];
    const line = [p0, ...pts.slice(1, -1), [ex, ey]].map((p) => p.join(',')).join(' ');
    const hx = (k, s) => [ex + Math.cos(ang + (Math.PI / 2) * s) * k, ey + Math.sin(ang + (Math.PI / 2) * s) * k];
    const head = [hx(headW / 2, 1), [x2, y2], hx(headW / 2, -1)].map((p) => p.join(',')).join(' ');
    return `<g opacity="${opacity}"><polyline points="${line}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linejoin="miter"/><polygon points="${head}" fill="${color}"/></g>`;
  }

  // ------------------------------------------------------------ interaction
  setInteractive(opts) {
    this.interactive = opts; // {color:'w'|'b'|'both', dests: Map<string,string[]>, onMove}
    this.el.classList.toggle('interactive', !!opts);
    this.selected = null;
    this.renderHighlights();
  }

  canMove(sq) {
    if (!this.interactive) return false;
    const p = this.pieceAt(sq);
    if (!p) return false;
    const c = this.interactive.color;
    if (c !== 'both' && p.code[0] !== c) return false;
    return (this.interactive.dests.get(sq) || []).length > 0;
  }

  bindPointer() {
    let drag = null;
    let rightStart = null;

    this.el.addEventListener('pointerdown', (e) => {
      const sq = this.sqAt(e.clientX, e.clientY);
      if (!sq) return;
      if (e.button === 2) {
        rightStart = sq;
        return;
      }
      if (e.button !== 0) return;
      this.clearUserMarks();
      // Second click of click-to-move
      if (this.selected && this.selected !== sq) {
        const dests = this.interactive?.dests?.get(this.selected) || [];
        if (dests.includes(sq)) {
          const from = this.selected;
          this.selected = null;
          this.tryMove(from, sq, false);
          return;
        }
      }
      if (!this.canMove(sq)) {
        if (this.selected) {
          this.selected = null;
          this.renderHighlights();
        }
        return;
      }
      const piece = this.pieceAt(sq);
      const wasSelected = this.selected === sq;
      this.selected = sq;
      this.renderHighlights();
      const rect = this.el.getBoundingClientRect();
      drag = { from: sq, piece, rect, startX: e.clientX, startY: e.clientY, moved: false, wasSelected };
      this.el.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    this.el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (!drag.moved && dist < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        drag.piece.el.classList.add('dragging');
        this.el.classList.add('grabbing');
      }
      const sqSize = drag.rect.width / 8;
      const x = e.clientX - drag.rect.left - sqSize / 2;
      const y = e.clientY - drag.rect.top - sqSize / 2;
      drag.piece.el.style.transform = `translate(${x}px, ${y}px)`;
      const over = this.sqAt(e.clientX, e.clientY);
      if (over !== drag.over) {
        if (drag.over) this.sqEls.get(drag.over)?.classList.remove('hover-target');
        drag.over = over;
        if (over && over !== drag.from) this.sqEls.get(over)?.classList.add('hover-target');
      }
    });

    const end = (e) => {
      if (e.button === 2 && rightStart) {
        const sq = this.sqAt(e.clientX, e.clientY);
        if (sq) {
          if (sq === rightStart) {
            this.userMarks.has(sq) ? this.userMarks.delete(sq) : this.userMarks.add(sq);
            this.renderHighlights();
          } else {
            const i = this.userArrows.findIndex((a) => a.from === rightStart && a.to === sq);
            if (i >= 0) this.userArrows.splice(i, 1);
            else this.userArrows.push({ from: rightStart, to: sq });
            this.renderArrows();
          }
        }
        rightStart = null;
        return;
      }
      if (!drag) return;
      const d = drag;
      drag = null;
      this.el.classList.remove('grabbing');
      if (d.over) this.sqEls.get(d.over)?.classList.remove('hover-target');
      if (!d.moved) {
        if (d.wasSelected) {
          this.selected = null;
          this.renderHighlights();
        }
        return;
      }
      const to = this.sqAt(e.clientX, e.clientY);
      const dests = this.interactive?.dests?.get(d.from) || [];
      if (to && to !== d.from && dests.includes(to)) {
        d.piece.el.classList.remove('dragging');
        d.piece.el.style.transition = 'none';
        this.place(d.piece.el, to);
        requestAnimationFrame(() => (d.piece.el.style.transition = ''));
        this.selected = null;
        this.tryMove(d.from, to, true);
      } else {
        d.piece.el.classList.remove('dragging');
        this.place(d.piece.el, d.from);
      }
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
  }

  async tryMove(from, to, dropped) {
    const it = this.interactive;
    if (!it) return;
    const piece = this.pieceAt(from);
    const isPawn = piece && piece.code[1] === 'P';
    const lastRank = to[1] === '8' || to[1] === '1';
    if (dropped) this.noAnim.add(to);
    if (isPawn && lastRank) {
      const promo = await this.askPromotion(to, piece.code[0]);
      if (!promo) {
        this.noAnim.clear();
        this.place(piece.el, from);
        this.renderHighlights();
        return;
      }
      it.onMove(from, to, promo);
    } else {
      it.onMove(from, to, null);
    }
  }

  askPromotion(sq, color) {
    return new Promise((resolve) => {
      this.cancelPromotion();
      const [x, y] = this.xy(sq);
      const down = y === 0;
      const roles = ['q', 'n', 'r', 'b'];
      const box = h('div', { class: 'promo-picker' });
      const order = down ? roles : [...roles].reverse();
      const btns = order.map((r) =>
        h('button', {
          style: { backgroundImage: `url(${pieceUrl(color, r)})` },
          onpointerdown: (e) => {
            e.stopPropagation();
            this.cancelPromotion();
            resolve(r);
          },
        }),
      );
      const x0 = h('button', { class: 'x', onpointerdown: (e) => { e.stopPropagation(); this.cancelPromotion(); resolve(null); } }, '×');
      if (down) box.append(...btns, x0);
      else box.append(x0, ...btns);
      box.style.left = `${x * 12.5}%`;
      if (down) box.style.top = '0';
      else box.style.bottom = '0';
      this.el.append(box);
      this.promoBox = box;
      this.promoResolve = resolve;
    });
  }

  cancelPromotion() {
    if (this.promoBox) {
      this.promoBox.remove();
      this.promoBox = null;
      const r = this.promoResolve;
      this.promoResolve = null;
      r && r(null);
    }
  }

  flash(content, ms = 1100) {
    const m = h('div', { class: 'board-overlay-msg', html: content });
    this.el.append(m);
    setTimeout(() => {
      m.style.transition = 'opacity 200ms';
      m.style.opacity = '0';
      setTimeout(() => m.remove(), 220);
    }, ms);
  }

  confetti() {
    const colors = ['#81b64c', '#26c2a3', '#f7c631', '#749bbf', '#ffa459', '#ffffff'];
    for (let i = 0; i < 46; i++) {
      const c = h('div', { class: 'confetti' });
      const ang = Math.random() * Math.PI * 2;
      const dist = 120 + Math.random() * 260;
      c.style.left = '50%';
      c.style.top = '50%';
      c.style.background = colors[i % colors.length];
      c.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
      c.style.setProperty('--dy', `${Math.sin(ang) * dist + 80}px`);
      c.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`);
      c.style.animationDelay = `${Math.random() * 80}ms`;
      this.el.append(c);
      setTimeout(() => c.remove(), 1300);
    }
  }
}
