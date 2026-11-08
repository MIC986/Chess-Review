// Settings window.
import { invoke, listen, h, esc, toast, modal } from './api.js';
import { icons } from './icons.js';
import { settings, BOARD_THEMES, PIECE_SETS, ACCENTS, STRENGTH, DEFAULTS, pieceUrl } from './settings.js';
import * as voice from './voice.js';
import { play } from './sound.js';
import { COACHES } from './coaches.js';

const SECTIONS = [
  ['board', 'Board & Pieces', 'board'],
  ['coach', 'Coach & Voice', 'mic'],
  ['analysis', 'Analysis Engine', 'cpu'],
  ['interface', 'Interface & Sound', 'palette'],
  ['account', 'Account', 'user'],
  ['extension', 'Browser Extension', 'plug'],
  ['keys', 'Shortcuts', 'keyboard'],
  ['about', 'About', 'info'],
];

function row(label, desc, ctrl) {
  return h('div', { class: 'set-row' }, h('div', { class: 'sr-text' }, h('div', { class: 'sr-label' }, label), desc ? h('div', { class: 'sr-desc' }, desc) : null), h('div', { class: 'sr-ctrl' }, ctrl));
}

function sw(key, onChange) {
  const b = h('button', { class: 'switch' + (settings[key] ? ' on' : '') });
  b.onclick = () => {
    settings[key] = !settings[key];
    b.classList.toggle('on', settings[key]);
    play('click');
    onChange && onChange(settings[key]);
  };
  return b;
}

function seg(key, options, onChange) {
  const wrap = h('div', { class: 'seg' });
  for (const [val, label] of options) {
    const b = h('button', { class: settings[key] === val ? 'active' : '' }, label);
    b.onclick = () => {
      settings[key] = val;
      wrap.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      onChange && onChange(val);
    };
    wrap.append(b);
  }
  return wrap;
}

function range(key, min, max, step, fmt = (v) => v, onChange) {
  const val = h('span', { class: 'range-val' }, fmt(settings[key]));
  const r = h('input', { type: 'range', class: 'range', min, max, step, value: settings[key] });
  r.oninput = () => {
    const v = step < 1 ? parseFloat(r.value) : parseInt(r.value, 10);
    settings[key] = v;
    val.textContent = fmt(v);
    onChange && onChange(v);
  };
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, r, val);
}

export function openSettings(app, section = 'board') {
  const nav = h('div', { class: 'set-nav' });
  const body = h('div', { class: 'set-body' });
  const unsubs = [];
  const show = (id) => {
    section = id;
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
    body.replaceChildren();
    body.scrollTop = 0;
    RENDER[id](body, app, unsubs);
  };
  for (const [id, label, ico] of SECTIONS) nav.append(h('button', { 'data-id': id, html: `${icons[ico]}${label}`, onclick: () => show(id) }));
  const m = modal({
    title: 'Settings',
    icon: `<span style="color:var(--accent);display:flex">${icons.settings}</span>`,
    wide: true,
    body: h('div', { class: 'settings' }, nav, body),
    onClose: () => unsubs.forEach((u) => u && u()),
  });
  m.box.style.padding = '0';
  show(section);
  return m;
}

const RENDER = {
  board(b) {
    const themeGrid = h('div', { class: 'theme-grid' });
    for (const [id, t] of Object.entries(BOARD_THEMES)) {
      const mini = h('div', { class: 'mini' });
      for (let i = 0; i < 16; i++) {
        const light = (Math.floor(i / 4) + (i % 4)) % 2 === 0;
        mini.append(h('i', { style: { background: light ? t.light : t.dark } }));
      }
      mini.append(h('span', { class: 'pc', style: { left: '0', top: '50%', backgroundImage: `url(${pieceUrl('w', 'n')})` } }));
      mini.append(h('span', { class: 'pc', style: { left: '50%', top: '0', backgroundImage: `url(${pieceUrl('b', 'q')})` } }));
      const opt = h('div', { class: 'theme-opt' + (settings.boardTheme === id ? ' active' : ''), onclick: () => { settings.boardTheme = id; themeGrid.querySelectorAll('.theme-opt').forEach((o) => o.classList.remove('active')); opt.classList.add('active'); } }, mini, h('div', { class: 'tname' }, t.name));
      themeGrid.append(opt);
    }
    const pieceGrid = h('div', { class: 'theme-grid' });
    for (const [id, name] of Object.entries(PIECE_SETS)) {
      const opt = h(
        'div',
        { class: 'theme-opt piece-opt' + (settings.pieceSet === id ? ' active' : ''), onclick: () => { settings.pieceSet = id; pieceGrid.querySelectorAll('.theme-opt').forEach((o) => o.classList.remove('active')); opt.classList.add('active'); } },
        h('div', { class: 'mini', style: { background: `linear-gradient(135deg, var(--sq-light) 50%, var(--sq-dark) 50%)` } }, h('span', { style: { backgroundImage: `url(pieces/${id}/wN.svg)` } }), h('span', { style: { backgroundImage: `url(pieces/${id}/bK.svg)` } })),
        h('div', { class: 'tname' }, name),
      );
      pieceGrid.append(opt);
    }
    b.append(
      h('h3', {}, 'Board & Pieces'),
      h('h4', {}, 'Board theme'),
      themeGrid,
      h('h4', {}, 'Pieces'),
      pieceGrid,
      h('h4', {}, 'Display'),
      row('Coordinates', 'Show rank and file labels on the board.', seg('coords', [['inside', 'Inside'], ['off', 'Off']])),
      row('Piece animation', 'How pieces glide between squares.', seg('animMs', [[0, 'Off'], [110, 'Fast'], [180, 'Normal'], [300, 'Slow']])),
      row('Highlight last move', null, sw('highlightLast')),
      row('Color squares by move quality', 'Tint the last move with its classification color, just like a game review.', sw('classHighlight')),
      row('Classification icons on the board', 'Show the !!, ?? … badge on the moved piece.', sw('showBadges')),
      row('Best move arrows', 'Draw a green arrow for the better move after an inaccuracy or mistake.', sw('showArrows')),
      row('Show legal moves', 'Dots for legal moves when you pick up a piece.', sw('showLegal')),
      row('Evaluation bar', null, sw('evalBar')),
      row('Clocks', 'Show the remaining time from the game.', sw('showClocks')),
      row('Figurine notation', 'Use piece icons (♞f3) instead of letters (Nf3) in move lists.', sw('figurine')),
    );
  },

  coach(b, app) {
    const cards = h('div', { class: 'coach-grid' });
    const renderCards = async () => {
      const st = await invoke('kokoro_status').catch(() => ({ installed: false }));
      cards.replaceChildren(
        ...Object.entries(COACHES).map(([id, c]) => {
          const active = settings.coach === id;
          const preview = h('button', {
            class: 'btn small' + (active ? ' primary' : ''),
            html: `${icons.speaker} Listen`,
            onclick: (e) => {
              e.stopPropagation();
              if (!st.installed) return app.requireVoice();
              voice.speak(c.hello, { force: true, voice: c.voice });
            },
          });
          return h(
            'div',
            {
              class: 'coach-card' + (active ? ' active' : ''),
              onclick: () => {
                settings.coach = id;
                renderCards();
                if (st.installed) voice.speak(c.hello, { force: true, voice: c.voice });
              },
            },
            h('div', { class: 'coach-avatar big', style: { background: c.gradient } }, h('img', { src: pieceUrl('w', c.piece, 'cburnett'), alt: '' })),
            h('div', { class: 'cc-name' }, c.name),
            h('div', { class: 'cc-tag' }, c.tagline),
            preview,
            active ? h('div', { class: 'cc-check', html: icons.check }) : null,
          );
        }),
      );
      if (!st.installed) {
        cards.append(
          h('div', { class: 'info-card', style: { gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '12px' } },
            h('span', { style: { flex: 1 } }, 'The coach voices are not installed yet (one-time download, runs offline).'),
            h('button', { class: 'btn small primary', html: `${icons.download} Install voices`, onclick: () => app.requireVoice() }),
          ),
        );
      }
    };
    renderCards();

    const sysSel = h('select', { class: 'input', onchange: (e) => (settings.systemVoice = e.target.value) });
    const fillVoices = () => {
      const vs = voice.systemVoices();
      sysSel.replaceChildren(h('option', { value: '' }, 'Automatic'), ...vs.map((v) => h('option', { value: v.name, selected: settings.systemVoice === v.name ? true : null }, v.name.replace(/^Microsoft /, ''))));
    };
    fillVoices();
    if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = fillVoices;

    b.append(
      h('h3', {}, 'Coach & Voice'),
      h('h4', {}, 'Choose your coach'),
      cards,
      h('h4', {}, 'Voice'),
      row('Coach speaks', 'Read each move explanation aloud during the review.', sw('voiceOn')),
      row('Also read the better move', 'After a mistake, also read what was best. Off = only the short explanation.', sw('speakBest')),
      row('Show best move in the coach bubble', null, sw('showBestInBubble')),
      row('Speaking speed', null, range('voiceRate', 0.8, 1.4, 0.05, (v) => v.toFixed(2) + '×')),
      row('Volume', null, range('voiceVolume', 0.1, 1, 0.05, (v) => Math.round(v * 100) + '%')),
      h('h4', {}, 'Fallback'),
      row('Use Windows voices instead', 'Not recommended: the built-in Windows voices sound robotic.', seg('voiceEngine', [['kokoro', 'Coach voices'], ['system', 'Windows']])),
      row('Windows voice', null, sysSel),
    );
  },

  async analysis(b) {
    const status = h('div', { class: 'info-card' }, 'Checking engine…');
    const refresh = async () => {
      const st = await invoke('engine_status', { custom: settings.customEngine || null });
      status.innerHTML = `<div><span class="status-dot ${st.installed ? 'ok' : 'bad'}"></span><b>${st.installed ? 'Engine ready' : 'Engine not installed'}</b></div><div style="margin-top:6px">Path: <code>${esc(st.path)}</code></div><div style="margin-top:4px">CPU threads available: <b>${st.cores}</b></div>`;
      return st;
    };
    const st = await refresh();
    const cores = st.cores || 8;
    const depthRow = range('depth', 8, 30, 1, (v) => v);
    b.append(
      h('h3', {}, 'Analysis Engine'),
      row('Review strength', 'Higher depth is more accurate but takes longer.', seg('engineStrength', Object.entries(STRENGTH).map(([k, v]) => [k, v.label]), (v) => { settings.depth = STRENGTH[v].depth; depthRow.querySelector('input').value = settings.depth; depthRow.querySelector('.range-val').textContent = settings.depth; })),
      row('Search depth', 'Plies searched for every position of the game.', depthRow),
      row('Parallel engines', 'Positions analyzed at the same time. More = faster reviews.', range('instances', 1, Math.max(1, cores), 1)),
      row('Threads per engine', null, range('threads', 1, 4, 1)),
      row('Hash per engine', null, seg('hash', [[32, '32 MB'], [64, '64 MB'], [128, '128 MB'], [256, '256 MB']])),
      row('Candidate lines', 'Lines compared per position. 2 or more is needed to detect "Great" moves.', seg('reviewMultipv', [[2, '2'], [3, '3'], [4, '4']])),
      row('Retry check depth', 'Depth used to grade your Retry attempts and explored moves.', range('retryDepth', 10, 22, 1)),
      h('h4', {}, 'Live analysis'),
      row('Engine lines', 'Lines shown in the Analysis tab.', seg('liveLines', [[1, '1'], [2, '2'], [3, '3'], [5, '5']])),
      row('Live engine threads', null, range('liveThreads', 1, Math.max(1, cores), 1)),
      h('h4', {}, 'Engine'),
      status,
      h('div', { style: { height: '10px' } }),
      row('Custom UCI engine', 'Optional: full path to another engine .exe. Leave empty to use the bundled Stockfish.', h('input', { class: 'input', value: settings.customEngine, placeholder: 'C:\\Engines\\stockfish.exe', onchange: async (e) => { settings.customEngine = e.target.value.trim(); await refresh(); } })),
      row('Reinstall Stockfish', 'Download the latest official Stockfish release again.', h('button', { class: 'btn small', html: `${icons.download} Download`, onclick: async (e) => { const btn = e.currentTarget; btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> Downloading…'; try { await invoke('install_engine'); toast('Stockfish installed'); } catch (err) { toast(String(err), 'err'); } btn.disabled = false; btn.innerHTML = `${icons.download} Download`; refresh(); } })),
    );
  },

  interface(b) {
    const sw2 = h('div', { class: 'swatches' });
    for (const [id, c] of Object.entries(ACCENTS)) {
      const s = h('div', { class: 'swatch' + (settings.accent === id ? ' active' : ''), style: { background: c[0] }, onclick: () => { settings.accent = id; sw2.querySelectorAll('.swatch').forEach((x) => x.classList.remove('active')); s.classList.add('active'); } });
      sw2.append(s);
    }
    b.append(
      h('h3', {}, 'Interface & Sound'),
      row('Theme', null, seg('uiTheme', [['default', 'Classic'], ['midnight', 'Midnight'], ['slate', 'Slate']])),
      row('Accent color', 'Buttons, highlights and the coach.', sw2),
      row('Interface size', null, range('uiScale', 0.85, 1.25, 0.05, (v) => Math.round(v * 100) + '%')),
      row('Autoplay speed', 'Time per move when autoplaying the game.', range('autoplayMs', 500, 4000, 100, (v) => (v / 1000).toFixed(1) + 's')),
      row('Celebrate correct retries', 'Confetti when you find the right move.', sw('confetti')),
      h('h4', {}, 'Sound'),
      row('Board sounds', null, sw('sound')),
      row('Volume', null, range('volume', 0, 1, 0.05, (v) => Math.round(v * 100) + '%', () => play('move'))),
      h('h4', {}, 'Reset'),
      row('Restore defaults', 'Resets every setting except your username.', h('button', { class: 'btn small danger', onclick: () => { const u = settings.username; for (const [k, v] of Object.entries(DEFAULTS)) settings[k] = v; settings.username = u; toast('Settings restored'); } }, 'Reset all')),
    );
  },

  account(b) {
    b.append(
      h('h3', {}, 'Account'),
      row('Your chess.com username', 'Used to load your games and to show the board from your side.', h('input', { class: 'input', value: settings.username, placeholder: 'username', onchange: (e) => (settings.username = e.target.value.trim()) })),
      row('Board faces my side', 'Automatically flip the board when you played Black.', sw('autoFlip')),
      h('div', { class: 'info-card', style: { marginTop: '16px' } }, 'Chess Review only reads public data from the chess.com API — no login or password is needed.'),
    );
  },

  async extension(b) {
    const st = h('div', { class: 'info-card' });
    const check = async () => {
      try {
        const path = await invoke('protocol_register');
        st.innerHTML = `<div><span class="status-dot ok"></span><b>Link handler active</b></div><div style="margin-top:6px">Links starting with <code>chessreview://</code> open this app:<br><code>${esc(path)}</code></div>`;
      } catch (e) {
        st.innerHTML = `<div><span class="status-dot bad"></span><b>Link handler unavailable</b></div><div style="margin-top:6px">${esc(e)}</div>`;
      }
    };
    check();
    b.append(
      h('h3', {}, 'Browser Extension'),
      h('div', { class: 'info-card', html: `The <b>Chess Review</b> extension adds an <b>“Review in App”</b> button next to chess.com's own review buttons — in your game archive, on finished game pages and on the game-over screen. Clicking it opens the game right here.` }),
      h('h4', {}, 'Install (Chrome, Edge, Brave, Opera)'),
      h('div', { class: 'info-card', html: `1. Open <code>chrome://extensions</code> (or <code>edge://extensions</code>).<br>2. Turn on <b>Developer mode</b>.<br>3. Click <b>Load unpacked</b> and choose the <code>extension</code> folder that ships next to this app.<br>4. Visit chess.com — the green <b>Review in App</b> buttons appear automatically.<br><br>The first time you click one, the browser asks to open <b>Chess Review</b>. Tick “Always allow” so it opens instantly next time.` }),
      h('h4', {}, 'Status'),
      st,
      h('div', { style: { height: '10px' } }),
      row('Repair link handler', 'Re-register chessreview:// links for this copy of the app.', h('button', { class: 'btn small', html: `${icons.refresh} Repair`, onclick: () => { check(); toast('Link handler registered'); } })),
    );
  },

  keys(b) {
    const k = (keys, what) => h('div', { class: 'set-row' }, h('div', { class: 'sr-text' }, h('div', { class: 'sr-label' }, what)), h('div', { class: 'sr-ctrl' }, ...keys.map((x) => h('span', { class: 'kbd' }, x))));
    b.append(
      h('h3', {}, 'Keyboard shortcuts'),
      k(['→'], 'Next move'),
      k(['←'], 'Previous move'),
      k(['↓'], 'Next key moment'),
      k(['↑'], 'Previous key moment'),
      k(['Home'], 'Start of the game'),
      k(['End'], 'End of the game'),
      k(['Space'], 'Autoplay'),
      k(['F'], 'Flip board'),
      k(['B'], 'Show best move'),
      k(['R'], 'Retry the current mistake'),
      k(['Esc'], 'Leave retry / exploration'),
      k(['Right-drag'], 'Draw arrows and mark squares'),
      k(['Mouse wheel'], 'Scroll through moves on the board'),
    );
  },

  about(b) {
    b.append(
      h('div', { style: { textAlign: 'center', padding: '20px 0 10px' } }, h('img', { src: 'logo.png', style: { width: '84px', height: '84px', borderRadius: '18px', boxShadow: '0 8px 24px rgba(0,0,0,.4)' } }), h('h3', { style: { margin: '14px 0 4px', fontSize: '22px' } }, 'Chess Review'), h('div', { style: { color: 'var(--text-3)' } }, 'Version 1.0.0')),
      h('div', { class: 'info-card', html: `A fast, offline game-review app for your chess.com games, powered by <b>Stockfish</b>. Move classifications follow the widely used expected-points model (win-probability loss per move), and accuracy uses a volatility-weighted harmonic mean — so results feel familiar, though they are computed independently and can differ slightly from chess.com's own numbers.` }),
      h('h4', {}, 'Credits'),
      h('div', { class: 'info-card', html: `Engine: Stockfish (GPLv3), downloaded from the official release page.<br>Openings: lichess-org/chess-openings (CC0).<br>Piece sets: Colin M.L. Burnett (cburnett, GPLv2+), sadsnake1 (staunty, maestro, cardinal, tatiana — CC BY-NC-SA 4.0), Jerry S. (california, CC BY-NC-SA 4.0), Armando H. Marroquin (merida, GPLv2+), Alexis Luengas (chessnut, Apache 2.0), Maurizio Monge (fantasy, celtic — MIT), Eric Bentzen (alpha), David L. Brown (companion).<br>Neural voices: Piper by Rhasspy (MIT) with voices from rhasspy/piper-voices.<br><br>Not affiliated with or endorsed by Chess.com.` }),
    );
  },
};
