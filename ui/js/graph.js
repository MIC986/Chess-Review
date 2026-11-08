// Evaluation graph (white advantage area chart).
import { h, evalText } from './api.js';
import { CLS } from './icons.js';

const MARK = new Set(['brilliant', 'great', 'miss', 'mistake', 'blunder']);
const DOT = 7;

export function evalGraph(review, { compact = false, onSelect, ply = 0 } = {}) {
  const wrap = h('div', { class: 'graph' + (compact ? ' compact' : '') });
  const n = review.positions.length;
  const W = 1000;
  const H = 100;
  const xs = (i) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  // Use a softened curve so small edges are visible but huge ones saturate.
  const ys = (i) => {
    const w = review.positions[i].win; // 0..100 white
    return H - (4 + (w / 100) * (H - 8));
  };
  let d = `M0,${H} L0,${ys(0).toFixed(2)}`;
  for (let i = 1; i < n; i++) {
    const x0 = xs(i - 1);
    const x1 = xs(i);
    const y0 = ys(i - 1);
    const y1 = ys(i);
    const cx = (x0 + x1) / 2;
    d += ` C${cx.toFixed(2)},${y0.toFixed(2)} ${cx.toFixed(2)},${y1.toFixed(2)} ${x1.toFixed(2)},${y1.toFixed(2)}`;
  }
  d += ` L${W},${H} Z`;

  let marks = '';
  for (const m of review.moves) {
    if (!MARK.has(m.classification)) continue;
    const x = xs(m.ply);
    const y = ys(m.ply);
    const c = CLS[m.classification].color;
    marks += `<circle cx="${x.toFixed(1)}" cy="${Math.min(H - 4, Math.max(4, y)).toFixed(1)}" r="${compact ? 4.2 : 4.8}" fill="${c}" stroke="#1d1c1a" stroke-width="1.4" vector-effect="non-scaling-stroke"/>`;
  }
  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path d="${d}" fill="#ffffff"/>
      <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="rgba(128,128,128,0.55)" stroke-width="1" vector-effect="non-scaling-stroke"/>
    </svg>
    <svg class="g-marks" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="overflow:visible">${marks}</svg>`;
  // keep circles round despite non-uniform scaling: draw marks in an HTML layer instead
  const markLayer = wrap.querySelector('.g-marks');
  markLayer.remove();
  for (const m of review.moves) {
    if (!MARK.has(m.classification)) continue;
    const dot = h('div', {
      style: {
        position: 'absolute',
        left: `calc(${(xs(m.ply) / W) * 100}% - ${DOT / 2}px)`,
        top: `calc(${Math.min(92, Math.max(8, (ys(m.ply) / H) * 100))}% - ${DOT / 2}px)`,
        width: `${DOT}px`,
        height: `${DOT}px`,
        borderRadius: '50%',
        background: CLS[m.classification].color,
        boxShadow: '0 0 0 1.5px rgba(29,28,26,.9)',
        pointerEvents: 'none',
      },
    });
    wrap.append(dot);
  }
  const cursor = h('div', { class: 'g-cursor' });
  const hover = h('div', { class: 'g-hover' });
  const tip = h('div', { class: 'g-tip' });
  wrap.append(cursor, hover, tip);

  const plyAt = (e) => {
    const r = wrap.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return Math.round(t * (n - 1));
  };
  wrap.addEventListener('mousemove', (e) => {
    const p = plyAt(e);
    const pct = (p / Math.max(1, n - 1)) * 100;
    hover.style.left = pct + '%';
    tip.style.left = Math.min(88, Math.max(12, pct)) + '%';
    const mv = review.moves[p - 1];
    const label = p === 0 ? 'Start' : `${mv.moveNumber}${mv.color === 'w' ? '.' : '...'} ${mv.san}`;
    tip.textContent = `${label}  ${evalText(review.positions[p].eval)}`;
  });
  wrap.addEventListener('click', (e) => onSelect && onSelect(plyAt(e)));

  wrap.setPly = (p) => {
    cursor.style.left = `calc(${(p / Math.max(1, n - 1)) * 100}% - 1px)`;
  };
  wrap.setPly(ply);
  return wrap;
}
