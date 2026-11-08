// Icon set (original artwork).

const S = (body, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;
const F = (body) => `<svg viewBox="0 0 24 24" fill="currentColor">${body}</svg>`;

export const icons = {
  home: S('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h5v-6h4v6h5V9.5"/>'),
  search: S('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  history: S('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>'),
  settings: S('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  star: F('<path d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8l-5.4 2.9 1.1-6.1L3.2 9.4l6.1-.8z"/>'),
  review: F('<path d="M12 2.5l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 8.8l6.1-.7z"/>'),
  flip: S('<path d="M7 4v16"/><path d="m3 8 4-4 4 4"/><path d="M17 20V4"/><path d="m21 16-4 4-4-4"/>'),
  first: S('<path d="M18 6 11 12l7 6"/><path d="M6 6v12"/>'),
  prev: S('<path d="m15 6-6 6 6 6"/>', 'stroke-width="2.6"'),
  next: S('<path d="m9 6 6 6-6 6"/>', 'stroke-width="2.6"'),
  last: S('<path d="m6 6 7 6-7 6"/><path d="M18 6v12"/>'),
  play: F('<path d="M7 4.5v15l12.5-7.5z"/>'),
  pause: F('<rect x="6" y="4.5" width="4.2" height="15" rx="1"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1"/>'),
  speaker: S('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>'),
  mute: S('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>'),
  close: S('<path d="M18 6 6 18M6 6l12 12"/>'),
  min: S('<path d="M5 12h14"/>'),
  max: S('<rect x="5" y="5" width="14" height="14" rx="1"/>'),
  restore: S('<rect x="4" y="8" width="12" height="12" rx="1"/><path d="M8 8V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-3"/>'),
  external: S('<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>'),
  copy: S('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  refresh: S('<path d="M20 12a8 8 0 1 1-2.3-5.7L20 8"/><path d="M20 3v5h-5"/>'),
  trash: S('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>'),
  retry: S('<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5"/>'),
  bulb: S('<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1.1 2.2h5c.1-1 .5-1.7 1.1-2.2A6 6 0 0 0 12 3z"/>'),
  eye: S('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  key: S('<circle cx="7.5" cy="15.5" r="4.5"/><path d="m11 12 9-9"/><path d="m17 6 3 3"/>'),
  list: S('<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>'),
  cpu: S('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>'),
  board: S('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>'),
  palette: S('<circle cx="13.5" cy="6.5" r="1.2"/><circle cx="17.5" cy="10.5" r="1.2"/><circle cx="8.5" cy="7.5" r="1.2"/><circle cx="6.5" cy="12.5" r="1.2"/><path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2H17a5 5 0 0 0 5-5C22 5.9 17.5 2 12 2z"/>'),
  mic: S('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v4"/>'),
  plug: S('<path d="M9 2v6M15 2v6"/><path d="M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/>'),
  info: S('<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5h.01"/>'),
  check: S('<path d="m5 12.5 4.5 4.5L19 7.5"/>', 'stroke-width="3"'),
  x: S('<path d="M6 6l12 12M18 6 6 18"/>', 'stroke-width="3"'),
  equal: S('<path d="M6 9h12M6 15h12"/>', 'stroke-width="3"'),
  pgn: S('<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>'),
  user: S('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>'),
  chart: S('<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 6-7"/>'),
  sound: S('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'),
  download: S('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
  folder: S('<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>'),
  keyboard: S('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  bolt: F('<path d="M13.5 2 4.5 13.5h6L9.5 22l9-11.5h-6z"/>'),
  bullet: F('<path d="M15.7 3.3c2.3-.6 4.4-.6 5 0s.6 2.7 0 5c-.5 2-1.6 3.9-3.1 5.4L12 19.3 4.7 12l5.6-5.6c1.5-1.5 3.4-2.6 5.4-3.1zM3.3 13.4l7.3 7.3-1.4 1.4-7.3-7.3z"/>'),
  timer: S('<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5V9.5"/><path d="M10 2.5h4"/><path d="m19 6 1.5-1.5"/>', 'stroke-width="2.4"'),
  sun: S('<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.5M12 19.5V22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2 12h2.5M19.5 12H22M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>', 'stroke-width="2.4"'),
  book: F('<path d="M3 5.2c3-.9 5.9-.6 8 .9v13.6c-2.1-1.4-5-1.8-8-.9zM21 5.2c-3-.9-5.9-.6-8 .9v13.6c2.1-1.4 5-1.8 8-.9z"/>'),
  analysis: S('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M8 11h6M11 8v6"/>'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  stop: F('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  sparkle: F('<path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8zM19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9z"/>'),
};

export const TC_ICON = { bullet: 'bullet', blitz: 'bolt', rapid: 'timer', daily: 'sun' };

// ---------------------------------------------------- classification icons

export const CLS = {
  brilliant: { label: 'Brilliant', color: '#26c2a3', glyph: 'txt:!!' },
  great: { label: 'Great', color: '#749bbf', glyph: 'txt:!' },
  best: { label: 'Best', color: '#81b64c', glyph: 'star' },
  excellent: { label: 'Excellent', color: '#96bc4b', glyph: 'thumb' },
  good: { label: 'Good', color: '#95b776', glyph: 'check' },
  book: { label: 'Book', color: '#d5a47d', glyph: 'book' },
  inaccuracy: { label: 'Inaccuracy', color: '#f7c631', glyph: 'txt:?!' },
  mistake: { label: 'Mistake', color: '#ffa459', glyph: 'txt:?' },
  miss: { label: 'Miss', color: '#ff7769', glyph: 'x' },
  blunder: { label: 'Blunder', color: '#fa412d', glyph: 'txt:??' },
  forced: { label: 'Forced', color: '#97af8b', glyph: 'arrow' },
};

export const CLS_ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];

function glyphSvg(g) {
  if (g.startsWith('txt:')) {
    const t = g.slice(4);
    const size = t.length >= 2 ? 9.6 : 11.5;
    return `<text x="9" y="${t.length >= 2 ? 12.4 : 13.1}" font-size="${size}" font-weight="900" text-anchor="middle" fill="#fff" font-family="Segoe UI, Arial, sans-serif" letter-spacing="${t.length >= 2 ? -0.6 : 0}">${t}</text>`;
  }
  switch (g) {
    case 'star':
      return '<path fill="#fff" d="M9 3.6l1.62 3.42 3.73.47-2.74 2.58.7 3.7L9 11.96l-3.3 1.8.7-3.7L3.65 7.5l3.73-.47z"/>';
    case 'thumb':
      return '<path fill="#fff" d="M4.6 8.3h2.1v5.6H4.6zM7.6 13.9V8.1l2.2-3.3c.3-.4.9-.5 1.2-.1.2.2.2.5.2.8l-.4 2.3h2.6c.7 0 1.2.6 1.1 1.3l-.6 3.6c-.1.7-.7 1.2-1.4 1.2z"/>';
    case 'check':
      return '<path d="M5.3 9.4l2.5 2.5 4.9-5.2" stroke="#fff" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
    case 'book':
      return '<path fill="#fff" d="M4.2 5.5c1.7-.5 3.3-.3 4.4.5v7.4c-1.1-.8-2.7-1-4.4-.5zM13.8 5.5c-1.7-.5-3.3-.3-4.4.5v7.4c1.1-.8 2.7-1 4.4-.5z"/>';
    case 'x':
      return '<path d="M6.2 6.2l5.6 5.6M11.8 6.2l-5.6 5.6" stroke="#fff" stroke-width="2.3" stroke-linecap="round"/>';
    case 'arrow':
      return '<path d="M4.8 9h7.2M9.4 6l3 3-3 3" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
  }
  return '';
}

export function clsIcon(cls, cssClass = 'cls-ico') {
  const c = CLS[cls];
  if (!c) return '';
  return `<svg class="${cssClass}" viewBox="0 0 18 18"><circle cx="9" cy="9.7" r="8.6" fill="rgba(0,0,0,0.22)"/><circle cx="9" cy="9" r="8.6" fill="${c.color}"/>${glyphSvg(c.glyph)}</svg>`;
}

export function clsArticle(cls) {
  return ['inaccuracy', 'excellent'].includes(cls) ? 'an' : 'a';
}
