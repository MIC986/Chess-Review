// Profile Review: turns a player's games (chess.com metadata + engine digests) into
// statistics, ranked weaknesses/strengths and a training plan.

const DRAWS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);
export const HOW = {
  checkmated: 'Checkmate',
  resigned: 'Resignation',
  timeout: 'On time',
  abandoned: 'Abandoned',
  agreed: 'Agreement',
  repetition: 'Repetition',
  stalemate: 'Stalemate',
  insufficient: 'Insufficient material',
  '50move': '50-move rule',
  timevsinsufficient: 'Time vs. no material',
};
export const PHASE_NAME = { o: 'Opening', m: 'Middlegame', e: 'Endgame' };
export const TAGS = {
  hung_moved: { label: 'Moved a piece where it can be taken', group: 'hanging' },
  hung_left: { label: 'Left a piece undefended', group: 'hanging' },
  threat_ignored: { label: 'Ignored a threat to a piece', group: 'hanging' },
  fork_allowed: { label: 'Walked into a fork', group: 'tactics' },
  tactic_allowed: { label: 'Allowed a tactic that wins material', group: 'tactics' },
  mate_allowed: { label: 'Allowed a checkmate', group: 'king' },
  mate_missed: { label: 'Missed a checkmate', group: 'missed' },
  win_missed: { label: 'Missed a chance to win material', group: 'missed' },
  punish_missed: { label: "Didn't punish a mistake", group: 'missed' },
  pawn_dropped: { label: 'Dropped a pawn', group: 'positional' },
  positional: { label: 'Positional or strategic error', group: 'positional' },
};
const BAD = new Set(['mistake', 'blunder', 'miss']);

// ------------------------------------------------------------ small helpers
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const round1 = (x) => Math.round(x * 10) / 10;
const scoreOf = (rs) => (rs.length ? (rs.filter((r) => r === 'W').length + rs.filter((r) => r === 'D').length * 0.5) / rs.length : 0);
const expected = (me, opp) => 1 / (1 + Math.pow(10, (opp - me) / 400));
const plural = (n, w, p = w + 's') => `${n} ${n === 1 ? w : p}`;

const FIX = [
  [/\bQueens\b/g, "Queen's"],
  [/\bKings\b/g, "King's"],
  [/\bCaro Kann\b/g, 'Caro-Kann'],
  [/\bPetrovs\b/g, "Petrov's"],
  [/\bAlekhines\b/g, "Alekhine's"],
  [/\bOwens\b/g, "Owen's"],
  [/\bBirds\b/g, "Bird's"],
  [/\bLarsens\b/g, "Larsen's"],
  [/\bPircs\b/g, "Pirc's"],
  [/\bNimzo Indian\b/g, 'Nimzo-Indian'],
  [/\bGruenfeld\b/g, 'Grünfeld'],
];
export function prettyOpening(name) {
  let s = String(name || '').trim();
  for (const [a, b] of FIX) s = s.replace(a, b);
  return s;
}
/** "Sicilian Defense Bowdler Attack" -> "Sicilian Defense" */
export function openingFamily(name) {
  if (!name) return 'Unknown opening';
  const w = String(name).split(/\s+/);
  for (let i = 0; i < w.length; i++) {
    if (/^(Defense|Defence|Opening|Game|Attack|Gambit|System|Countergambit)$/.test(w[i])) {
      const end = /^(Declined|Accepted)$/.test(w[i + 1] || '') ? i + 2 : i + 1;
      return prettyOpening(w.slice(0, end).join(' '));
    }
  }
  return prettyOpening(w.slice(0, 3).join(' '));
}

export function parseTC(tc) {
  const s = String(tc || '');
  if (s.includes('/')) return { daily: true, base: 0, inc: 0 };
  const [b, i] = s.split('+');
  return { daily: false, base: +b || 0, inc: +i || 0 };
}

function pgnClocks(pgn) {
  const out = [];
  const re = /\[%clk (\d+):(\d+):(\d+(?:\.\d+)?)\]/g;
  let m;
  while ((m = re.exec(pgn))) out.push(+m[1] * 3600 + +m[2] * 60 + +m[3]);
  return out;
}

function pgnFirstMoves(pgn) {
  const body = String(pgn || '').replace(/^\s*\[[^\]]*\]\s*$/gm, '').replace(/\{[^}]*\}/g, ' ').replace(/\([^)]*\)/g, ' ');
  return body
    .split(/\s+/)
    .filter((t) => t && !/^\d+\.+$/.test(t) && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t))
    .map((t) => t.replace(/^\d+\.+/, ''))
    .filter(Boolean)
    .slice(0, 4);
}

export function ratingFromAccuracy(acc) {
  const T = [[0, 100], [40, 250], [50, 450], [60, 750], [70, 1100], [75, 1300], [80, 1550], [85, 1850], [90, 2200], [93, 2450], [96, 2750], [98, 3000], [100, 3250]];
  for (let i = 1; i < T.length; i++) {
    if (acc <= T[i][0]) {
      const t = (acc - T[i - 1][0]) / (T[i][0] - T[i - 1][0]);
      return Math.round((T[i - 1][1] + t * (T[i][1] - T[i - 1][1])) / 25) * 25;
    }
  }
  return 3250;
}

/** Minimal copy of a chess.com game, enough to open it in the review later. */
export function miniGame(g) {
  return { id: g.id, pgn: g.pgn, url: g.url, timeClass: g.timeClass, accuracies: g.accuracies, white: g.white, black: g.black };
}

// ------------------------------------------------------------ per-game records
export function gameRecord(g, user) {
  const u = user.toLowerCase();
  const color = g.white?.username?.toLowerCase() === u ? 'w' : g.black?.username?.toLowerCase() === u ? 'b' : null;
  if (!color) return null;
  const me = color === 'w' ? g.white : g.black;
  const op = color === 'w' ? g.black : g.white;
  let res, how;
  if (me.result === 'win') {
    res = 'W';
    how = op.result;
  } else if (op.result === 'win') {
    res = 'L';
    how = me.result;
  } else {
    res = 'D';
    how = DRAWS.has(me.result) ? me.result : 'agreed';
  }
  const tc = parseTC(g.timeControl);
  const first = pgnFirstMoves(g.pgn);
  return {
    id: g.id,
    g,
    color,
    res,
    how,
    my: +me.rating || 0,
    opp: +op.rating || 0,
    oppName: op.username,
    end: +g.endTime || 0,
    tc: g.timeClass,
    tcInfo: tc,
    family: openingFamily(g.opening),
    opening: prettyOpening(g.opening || ''),
    first,
    moves: +g.moves || 0,
    clocks: pgnClocks(g.pgn),
  };
}

// ------------------------------------------------------------ report
export function buildReport({ user, profile, mode, rangeLabel, records, digests }) {
  const R = { user, avatar: profile?.avatar || null, title: profile?.title || null, mode, rangeLabel, at: Math.floor(Date.now() / 1000) };
  const recs = [...records].sort((a, b) => a.end - b.end);
  const N = recs.length;
  // chess.com reports ratings after the game, which makes winners look higher-rated.
  // Rebuild pre-game ratings: mine from my previous game in the same time control,
  // the opponent's by undoing the same rating change.
  const lastBy = {};
  for (const r of recs) {
    const prev = lastBy[r.tc];
    const delta = prev != null ? Math.max(-40, Math.min(40, r.my - prev)) : 0;
    r.myPre = r.my - delta;
    r.oppPre = r.opp + delta;
    lastBy[r.tc] = r.my;
  }
  R.games = N;
  if (!N) return R;

  // ---- results
  const results = recs.map((r) => r.res);
  R.wdl = { W: results.filter((x) => x === 'W').length, D: results.filter((x) => x === 'D').length, L: results.filter((x) => x === 'L').length };
  R.score = round1(scoreOf(results) * 100);
  const byColor = (c) => {
    const rs = recs.filter((r) => r.color === c).map((r) => r.res);
    return { n: rs.length, score: round1(scoreOf(rs) * 100), W: rs.filter((x) => x === 'W').length, D: rs.filter((x) => x === 'D').length, L: rs.filter((x) => x === 'L').length };
  };
  R.white = byColor('w');
  R.black = byColor('b');
  R.winHow = {};
  R.lossHow = {};
  R.drawHow = {};
  for (const r of recs) {
    const bucket = r.res === 'W' ? R.winHow : r.res === 'L' ? R.lossHow : R.drawHow;
    bucket[r.how] = (bucket[r.how] || 0) + 1;
  }

  // ---- time classes and rating
  const classes = {};
  for (const r of recs) (classes[r.tc] = classes[r.tc] || []).push(r);
  R.byClass = Object.entries(classes)
    .map(([tc, rs]) => ({ tc, n: rs.length, score: round1(scoreOf(rs.map((x) => x.res)) * 100), first: rs[0].my, last: rs[rs.length - 1].my, peak: Math.max(...rs.map((x) => x.my)) }))
    .sort((a, b) => b.n - a.n);
  const main = R.byClass[0];
  R.ratingClass = main.tc;
  R.rating = { first: main.first, last: main.last, peak: main.peak, change: main.last - main.first, series: classes[main.tc].map((r) => [r.end, r.my]) };
  const avgOpp = avg(recs.map((r) => r.oppPre));
  R.avgOpp = Math.round(avgOpp);
  R.performance = Math.round(avgOpp + 400 * ((R.wdl.W - R.wdl.L) / N));

  // ---- opponent strength
  const strength = [
    ['Much lower (−100 or more)', (d) => d <= -100],
    ['Lower (−25 to −100)', (d) => d > -100 && d <= -25],
    ['Similar (±25)', (d) => d > -25 && d < 25],
    ['Higher (+25 to +100)', (d) => d >= 25 && d < 100],
    ['Much higher (+100 or more)', (d) => d >= 100],
  ];
  R.vsStrength = strength.map(([label, f]) => {
    const rs = recs.filter((r) => f(r.oppPre - r.myPre));
    return { label, n: rs.length, score: round1(scoreOf(rs.map((x) => x.res)) * 100), exp: round1(avg(rs.map((x) => expected(x.myPre, x.oppPre))) * 100) };
  });

  // ---- openings
  const openingTable = (list) => {
    const m = new Map();
    for (const r of list) {
      const o = m.get(r.family) || { name: r.family, n: 0, W: 0, D: 0, L: 0, rs: [] };
      o.n++;
      o[r.res]++;
      o.rs.push(r);
      m.set(r.family, o);
    }
    return [...m.values()]
      .map((o) => ({ name: o.name, n: o.n, W: o.W, D: o.D, L: o.L, score: round1(((o.W + o.D / 2) / o.n) * 100) }))
      .sort((a, b) => b.n - a.n);
  };
  R.openWhite = openingTable(recs.filter((r) => r.color === 'w')).slice(0, 8);
  R.openBlack = openingTable(recs.filter((r) => r.color === 'b')).slice(0, 8);
  const vsFirst = (mv) => recs.filter((r) => r.color === 'b' && r.first[0] === mv);
  R.blackVs = ['e4', 'd4', 'c4', 'Nf3']
    .map((mv) => {
      const rs = vsFirst(mv);
      const replies = {};
      rs.forEach((r) => r.first[1] && (replies[r.first[1]] = (replies[r.first[1]] || 0) + 1));
      const top = Object.entries(replies).sort((a, b) => b[1] - a[1])[0];
      return { mv, n: rs.length, score: round1(scoreOf(rs.map((x) => x.res)) * 100), reply: top ? top[0] : null };
    })
    .filter((x) => x.n >= 3);
  const firsts = {};
  recs.filter((r) => r.color === 'w' && r.first[0]).forEach((r) => (firsts[r.first[0]] = firsts[r.first[0]] || []).push(r.res));
  R.whiteFirst = Object.entries(firsts)
    .map(([mv, rs]) => ({ mv, n: rs.length, score: round1(scoreOf(rs) * 100) }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 4);

  // ---- habits: time of day, sessions, streaks, game length
  const dayparts = [
    ['Night', [0, 6]],
    ['Morning', [6, 12]],
    ['Afternoon', [12, 18]],
    ['Evening', [18, 24]],
  ];
  R.dayparts = dayparts.map(([label, [a, b]]) => {
    const rs = recs.filter((r) => {
      const hr = new Date(r.end * 1000).getHours();
      return hr >= a && hr < b;
    });
    return { label, n: rs.length, score: round1(scoreOf(rs.map((x) => x.res)) * 100) };
  });
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  R.weekdays = days.map((label, d) => {
    const rs = recs.filter((r) => new Date(r.end * 1000).getDay() === d);
    return { label, n: rs.length, score: round1(scoreOf(rs.map((x) => x.res)) * 100) };
  });
  const afterW = [];
  const afterL = [];
  const late = [];
  let sessIdx = 0;
  let sessions = 1;
  for (let i = 0; i < N; i++) {
    const r = recs[i];
    const prev = recs[i - 1];
    const gap = prev ? r.end - prev.end : Infinity;
    const sameSession = gap < 45 * 60 + (r.tcInfo.base || 600) * 2;
    if (prev && sameSession && r.tc !== 'daily') {
      sessIdx++;
      if (prev.res === 'W') afterW.push(r.res);
      if (prev.res === 'L') afterL.push(r.res);
    } else {
      if (prev) sessions++;
      sessIdx = 0;
    }
    if (sessIdx >= 5) late.push(r.res);
  }
  R.tilt = { afterWin: { n: afterW.length, score: round1(scoreOf(afterW) * 100) }, afterLoss: { n: afterL.length, score: round1(scoreOf(afterL) * 100) }, late: { n: late.length, score: round1(scoreOf(late) * 100) }, sessions, perSession: round1(N / sessions) };
  let best = 0;
  let worst = 0;
  let cw = 0;
  let cl = 0;
  for (const r of recs) {
    cw = r.res === 'W' ? cw + 1 : 0;
    cl = r.res === 'L' ? cl + 1 : 0;
    best = Math.max(best, cw);
    worst = Math.max(worst, cl);
  }
  R.streaks = { win: best, loss: worst };
  R.avgMoves = Math.round(avg(recs.map((r) => r.moves)));
  const losses = recs.filter((r) => r.res === 'L');
  R.quickLosses = losses.filter((r) => r.moves <= 25 && r.how !== 'timeout' && r.how !== 'abandoned').length;

  // ---- clocks (all games with clock data)
  let lowGames = 0;
  let lowGamesScore = [];
  let openingShare = [];
  for (const r of recs) {
    const { base, daily } = r.tcInfo;
    if (daily || !base || r.clocks.length < 6) continue;
    const mine = r.clocks.filter((_, i) => (i % 2 === 0) === (r.color === 'w'));
    if (mine.some((c) => c < base * 0.1)) {
      lowGames++;
      lowGamesScore.push(r.res);
    }
    if (mine.length > 12) openingShare.push((base - mine[9]) / base);
  }
  R.clock = {
    lowGames,
    lowScore: round1(scoreOf(lowGamesScore) * 100),
    timeoutLosses: R.lossHow.timeout || 0,
    openingTime: round1(avg(openingShare) * 100),
  };

  // ---- engine analysis
  const E = engineStats(recs, digests);
  R.engine = E;

  // ---- insights
  const { weak, strong } = insights(R, E, recs);
  R.focus = weak;
  R.strengths = strong;
  R.plan = trainingPlan(R, weak);
  R.coachText = coachSummary(R, weak, strong);
  return R;
}

function engineStats(recs, digests) {
  const E = { games: 0, list: [], phases: { o: { acc: [], lost: 0, n: 0 }, m: { acc: [], lost: 0, n: 0 }, e: { acc: [], lost: 0, n: 0 } }, counts: {}, tags: {}, roles: {}, totalLost: 0, moves: 0 };
  const conv = { chances: 0, W: 0, D: 0, L: 0, thrown: [] };
  const back = { chances: 0, saved: 0, W: 0 };
  const punish = { chances: 0, ok: 0 };
  const time = { low: { n: 0, bad: 0, acc: [] }, norm: { n: 0, bad: 0, acc: [] }, fast: { n: 0, bad: 0 }, slow: { n: 0, bad: 0 } };
  const openWin = [];
  const openByFam = new Map();
  const endgame = { games: 0, rs: [] };
  const examples = [];
  const greats = [];
  for (const r of recs) {
    const d = digests.get(r.id);
    if (!d || d.skip || !d.moves) continue;
    E.games++;
    const c = r.color;
    const side = c === 'w' ? d.white : d.black;
    E.list.push({ id: r.id, acc: side.acc, res: r.res, end: r.end, opp: r.oppName, g: miniGame(r.g) });
    const myWin = (d.w || []).map((x) => (c === 'w' ? x : 100 - x));
    const { base, inc, daily } = r.tcInfo;
    let prevClock = base;
    let reachedEnd = false;
    for (let i = 0; i < d.moves.length; i++) {
      const m = d.moves[i];
      if (m.c !== c) {
        // Opponent's serious mistake: did we punish it?
        const lostOpp = m.wb - m.wa;
        const nxt = d.moves[i + 1];
        if (BAD.has(m.k) && lostOpp >= 12 && nxt && m.wa < 75) {
          punish.chances++;
          if (Math.max(0, nxt.wb - nxt.wa) < 6) punish.ok++;
        }
        continue;
      }
      E.moves++;
      E.counts[m.k] = (E.counts[m.k] || 0) + 1;
      const lost = Math.max(0, m.wb - m.wa);
      const ph = E.phases[m.ph] || E.phases.m;
      if (m.ph === 'e') reachedEnd = true;
      if (m.k !== 'book' && m.k !== 'forced') {
        ph.acc.push(m.a);
        ph.n++;
      }
      const isBad = BAD.has(m.k);
      if (isBad) ph.lost += 1;
      if (m.tag === 'mate_allowed' && m.wb >= 35 && lost >= 20) E.kingReal = (E.kingReal || 0) + 1;
      if (m.tag && (isBad || m.k === 'inaccuracy')) {
        const t = (E.tags[m.tag] = E.tags[m.tag] || { n: 0, lost: 0, bad: 0 });
        t.n++;
        t.lost += lost;
        if (isBad) t.bad++;
        E.totalLost += lost;
        if (m.role && /^(hung|threat)/.test(m.tag)) E.roles[m.role] = (E.roles[m.role] || 0) + 1;
      }
      if ((isBad && lost >= 15) || (m.k === 'inaccuracy' && lost >= 10)) {
        examples.push({ gid: r.id, idx: i, fen: m.fen, uci: m.uci, bu: m.bu, best: m.best, reply: m.reply, san: m.san, tag: m.tag, role: m.role, k: m.k, lost: round1(lost), wb: m.wb, wa: m.wa, color: c, opp: r.oppName, end: r.end, res: r.res, ph: m.ph });
      }
      if ((m.k === 'brilliant' || m.k === 'great') && m.fen) greats.push({ gid: r.id, idx: i, fen: m.fen, uci: m.uci, san: m.san, k: m.k, color: c, opp: r.oppName, end: r.end });
      // clocks
      if (!daily && base && m.t != null) {
        const spent = Math.max(0, prevClock - m.t + inc);
        prevClock = m.t;
        if (m.k !== 'book' && m.k !== 'forced') {
          const low = m.t < Math.max(base * 0.12, 8);
          const b = low ? time.low : time.norm;
          b.n++;
          b.acc.push(m.a);
          if (isBad) b.bad++;
          if (!low && r.tc !== 'bullet') {
            const crit = m.wb > 15 && m.wb < 85;
            if (crit && spent <= Math.max(2, base * 0.008)) {
              time.fast.n++;
              if (isBad) time.fast.bad++;
            } else if (crit && spent >= base * 0.03) {
              time.slow.n++;
              if (isBad) time.slow.bad++;
            }
          }
        }
      }
    }
    if (reachedEnd) {
      endgame.games++;
      endgame.rs.push(r.res);
    }
    // conversion / comebacks (sustained for two positions)
    let hi = false;
    let lo = false;
    let hiAt = -1;
    for (let i = 10; i + 1 < myWin.length; i++) {
      if (!hi && myWin[i] >= 85 && myWin[i + 1] >= 85) {
        hi = true;
        hiAt = i;
      }
      if (myWin[i] <= 15 && myWin[i + 1] <= 15) lo = true;
    }
    if (hi) {
      conv.chances++;
      conv[r.res]++;
      if (r.res !== 'W') conv.thrown.push({ gid: r.id, idx: hiAt, opp: r.oppName, end: r.end, res: r.res, g: miniGame(r.g) });
    }
    if (lo) {
      back.chances++;
      if (r.res !== 'L') back.saved++;
      if (r.res === 'W') back.W++;
    }
    const at = Math.min(20, myWin.length - 1);
    if (at >= 12) {
      openWin.push(myWin[at]);
      const key = r.family + '|' + c;
      const o = openByFam.get(key) || { name: r.family, color: c, v: [], rs: [] };
      o.v.push(myWin[at]);
      o.rs.push(r.res);
      openByFam.set(key, o);
    }
  }
  if (!E.games) return null;
  const accs = E.list.map((x) => x.acc);
  E.acc = round1(avg(accs));
  E.estRating = ratingFromAccuracy(E.acc);
  const half = Math.floor(accs.length / 2);
  E.trend = accs.length >= 10 ? round1(avg(accs.slice(half)) - avg(accs.slice(0, half))) : 0;
  const accBy = (res) => round1(avg(E.list.filter((x) => x.res === res).map((x) => x.acc)));
  E.accWin = accBy('W');
  E.accLoss = accBy('L');
  E.accDraw = accBy('D');
  for (const k of Object.keys(E.phases)) {
    const p = E.phases[k];
    E.phases[k] = { acc: p.acc.length ? round1(avg(p.acc)) : null, n: p.n, errPerGame: round1(p.lost / E.games) };
  }
  E.perGame = {};
  for (const k of ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder']) E.perGame[k] = round1((E.counts[k] || 0) / E.games);
  E.conv = { chances: conv.chances, W: conv.W, D: conv.D, L: conv.L, rate: conv.chances ? pct(conv.W, conv.chances) : null, thrown: conv.thrown.slice(-6).reverse() };
  E.back = { chances: back.chances, saved: back.saved, W: back.W, rate: back.chances ? pct(back.saved, back.chances) : null };
  E.punish = { chances: punish.chances, ok: punish.ok, rate: punish.chances ? pct(punish.ok, punish.chances) : null };
  const rate = (b) => (b.n ? round1((b.bad / b.n) * 100) : null);
  E.time = {
    low: { n: time.low.n, badRate: rate(time.low), acc: round1(avg(time.low.acc)) },
    norm: { n: time.norm.n, badRate: rate(time.norm), acc: round1(avg(time.norm.acc)) },
    fast: { n: time.fast.n, badRate: rate(time.fast) },
    slow: { n: time.slow.n, badRate: rate(time.slow) },
  };
  E.openWin = openWin.length ? round1(avg(openWin)) : null;
  E.openFams = [...openByFam.values()]
    .filter((o) => o.v.length >= 3)
    .map((o) => ({ name: o.name, color: o.color, n: o.v.length, win: round1(avg(o.v)), score: round1(scoreOf(o.rs) * 100) }))
    .sort((a, b) => a.win - b.win);
  E.endgame = { games: endgame.games, score: round1(scoreOf(endgame.rs) * 100) };
  const tagList = Object.entries(E.tags).map(([tag, t]) => ({ tag, label: TAGS[tag]?.label || tag, group: TAGS[tag]?.group || 'positional', n: t.n, bad: t.bad, lost: round1(t.lost), share: E.totalLost ? round1((t.lost / E.totalLost) * 100) : 0 }));
  E.tagList = tagList.sort((a, b) => b.lost - a.lost);
  const groups = {};
  for (const t of tagList) {
    const g = (groups[t.group] = groups[t.group] || { n: 0, bad: 0, lost: 0, share: 0 });
    g.n += t.n;
    g.bad += t.bad;
    g.lost += t.lost;
    g.share = round1(g.share + t.share);
  }
  E.groups = groups;
  E.roleList = Object.entries(E.roles).sort((a, b) => b[1] - a[1]);
  E.examples = examples.sort((a, b) => b.lost - a.lost).slice(0, 40);
  E.greats = greats.slice(-6).reverse();
  return E;
}

// ------------------------------------------------------------ insights
function examplesFor(E, pred, n = 3) {
  const seen = new Set();
  const out = [];
  for (const x of E.examples) {
    if (!pred(x) || seen.has(x.gid)) continue;
    seen.add(x.gid);
    out.push(x);
    if (out.length >= n) break;
  }
  return out;
}

function sevLabel(s) {
  return s >= 60 ? 'High impact' : s >= 35 ? 'Medium impact' : 'Worth a look';
}

function insights(R, E, recs) {
  const weak = [];
  const strong = [];
  const add = (list, o) => list.push({ ...o, sevLabel: sevLabel(o.sev || 0) });
  const nLoss = R.wdl.L;

  if (E) {
    const G = E.groups;
    const conf = (n) => Math.min(1, n / 5);
    const perGame = (n) => round1(n / E.games);

    // Hanging pieces
    const hang = G.hanging;
    if (hang && hang.bad >= 3 && hang.share >= 12) {
      const role = E.roleList[0];
      const ignored = E.tags.threat_ignored?.n || 0;
      const advice = [
        'Before you let go of a piece, do a blunder check: "After this move, what can my opponent capture, and is it defended?"',
        ignored >= 2 ? 'When your opponent attacks something, answer the threat first. Only then go on with your own plan.' : 'Count attackers and defenders on the square you move to. If attackers win, find another square.',
        'Solve 10 minutes of "hanging piece" and "defend" puzzles every day. It trains your eyes to spot loose pieces.',
      ];
      if (E.time.fast.n >= 20 && E.time.fast.badRate > (E.time.slow.badRate || 0) * 1.4) advice.push('Most of these happen on quick moves. Slow down in sharp positions, even if you are comfortable on the clock.');
      add(weak, {
        id: 'hanging',
        icon: 'blunder',
        sev: Math.round(Math.min(95, hang.share * 1.6) * conf(hang.bad)),
        title: 'You leave pieces hanging',
        stat: `${plural(hang.bad, 'time')} in ${plural(E.games, 'game')}`,
        detail: `Pieces left where they could be taken cost you ${Math.round(hang.share)}% of all the advantage you gave away, ${perGame(hang.bad) >= 1.5 ? `about ${perGame(hang.bad)} serious slips per game` : perGame(hang.bad) >= 0.75 ? 'about one serious slip per game' : `roughly one serious slip every ${Math.max(2, Math.round(E.games / hang.bad))} games`}.${role ? ` Your ${role[0]} is the piece you lose most often (${plural(role[1], 'time')}).` : ''}`,
        advice,
        examples: examplesFor(E, (x) => TAGS[x.tag]?.group === 'hanging'),
      });
    }
    // Walking into tactics
    const tac = G.tactics;
    if (tac && tac.bad >= 3 && tac.share >= 12) {
      const forks = E.tags.fork_allowed?.n || 0;
      add(weak, {
        id: 'tactics',
        icon: 'mistake',
        sev: Math.round(Math.min(95, tac.share * 1.5) * conf(tac.bad)),
        title: 'You walk into tactics',
        stat: `${plural(tac.bad, 'time')} in ${plural(E.games, 'game')}`,
        detail: `Your opponents found a winning tactic after ${plural(tac.bad, 'move')} of yours, ${Math.round(tac.share)}% of the advantage you lost.${forks >= 2 ? ` ${plural(forks, 'of them was a fork', 'of them were forks')}.` : ''}`,
        advice: [
          'Before each move, look at the board through your opponent\'s eyes: every check, every capture and every threat they would have.',
          forks >= 2 ? 'Watch the squares a knight can jump to. Don\'t leave your king, queen and rooks a knight\'s jump apart.' : 'Avoid lining up your king and queen, or queen and rook, on the same file, rank or diagonal.',
          'Study the main tactical patterns (fork, pin, skewer, discovered attack) and solve 15 puzzles a day.',
        ],
        examples: examplesFor(E, (x) => TAGS[x.tag]?.group === 'tactics'),
      });
    }
    // Not punishing mistakes
    const missed = G.missed;
    const pr = E.punish;
    if ((missed && missed.bad >= 3 && missed.share >= 10) || (pr.chances >= 8 && pr.rate < 55)) {
      add(weak, {
        id: 'missed',
        icon: 'miss',
        sev: Math.round(Math.min(90, Math.max(missed ? missed.share * 1.3 : 0, pr.rate != null ? (70 - pr.rate) * 1.2 : 0)) * conf(Math.max(missed?.bad || 0, pr.chances / 2))),
        title: 'You let your opponents off the hook',
        stat: pr.rate != null ? `${pr.rate}% of mistakes punished` : `${plural(missed.bad, 'missed chance')}`,
        detail: `Your opponents made ${plural(pr.chances, 'serious mistake')}. You found the right reply to only ${pr.ok} of them${E.tags.mate_missed ? `, and missed ${plural(E.tags.mate_missed.n, 'forced checkmate')}` : ''}. Free points are slipping away.`,
        advice: [
          'After every move your opponent makes, ask: "What did that move change? What is undefended now?"',
          'Look at your own checks, captures and threats first, in that order, before thinking about quiet moves.',
          'Do Puzzle Rush or timed tactic sets a few times a week. Spotting chances fast is a trainable skill.',
        ],
        examples: examplesFor(E, (x) => TAGS[x.tag]?.group === 'missed'),
      });
    }
    // King safety
    const km = E.tags.mate_allowed;
    const kingN = E.kingReal || 0;
    if (km && kingN >= 2) {
      add(weak, {
        id: 'king',
        icon: 'blunder',
        sev: Math.round(Math.min(85, (E.groups.king?.share || 0) * 1.4 + kingN * 2.5) * conf(kingN + 1)),
        title: 'Your king gets caught',
        stat: `${plural(kingN, 'mating attack')} allowed`,
        detail: `${plural(kingN, 'time')} you let your opponent force checkmate from a position that was still playable. A safe king is worth more than any pawn.`,
        advice: [
          'Castle early, and think twice before pushing the pawns in front of your castled king.',
          'Give your king an escape square (a pawn move like h3 or h6) once the position is calm, so back-rank mates are impossible.',
          'When your opponent brings pieces toward your king, bring defenders back before going after material.',
        ],
        examples: examplesFor(E, (x) => x.tag === 'mate_allowed' && x.wb >= 35),
      });
    }
    // Time pressure
    const T = E.time;
    if (T.low.n >= 25 && T.norm.badRate != null && T.low.badRate >= Math.max(T.norm.badRate * 1.5, T.norm.badRate + 2)) {
      const ratio = T.low.badRate / Math.max(0.5, T.norm.badRate);
      add(weak, {
        id: 'time',
        icon: 'timer',
        sev: Math.round(Math.min(95, (ratio - 1) * 30 + pct(R.clock.timeoutLosses, nLoss) * 0.6)),
        title: 'Low on time, you fall apart',
        stat: `${ratio.toFixed(1)}× more errors`,
        detail: `With little time left, ${T.low.badRate}% of your moves are serious mistakes, against ${T.norm.badRate}% normally.${R.clock.timeoutLosses ? ` You also lost ${plural(R.clock.timeoutLosses, 'game')} on time.` : ''}`,
        advice: [
          R.clock.openingTime >= 20 ? `You use ${Math.round(R.clock.openingTime)}% of your clock on the first 10 moves. Play the opening faster so you have time when it matters.` : 'Budget your time: aim to have at least a third of your clock left when the middlegame ends.',
          'In time trouble, choose safe, simple moves and keep pieces defended rather than looking for the best move.',
          'Play some games with increment (like 10+5 or 3+2). The extra seconds teach good habits without the panic.',
        ],
        examples: [],
      });
    } else if (nLoss >= 6 && R.clock.timeoutLosses >= 3 && pct(R.clock.timeoutLosses, nLoss) >= 20) {
      add(weak, {
        id: 'time',
        icon: 'timer',
        sev: Math.round(pct(R.clock.timeoutLosses, nLoss) * 1.3),
        title: 'You lose on the clock',
        stat: `${pct(R.clock.timeoutLosses, nLoss)}% of losses on time`,
        detail: `${plural(R.clock.timeoutLosses, 'loss', 'losses')} came from running out of time, not from the position.`,
        advice: [
          R.clock.openingTime >= 20 ? `You spend ${Math.round(R.clock.openingTime)}% of your clock on the first 10 moves. Play your opening on autopilot and save time for later.` : 'Keep an eye on the clock every few moves and speed up early, before it is critical.',
          'When you are ahead and short on time, simplify: trade pieces and make safe moves.',
          'Try games with increment so you never get stuck with seconds left in a long endgame.',
        ],
        examples: [],
      });
    }
    // Impulsive moves
    if (T.fast.n >= 25 && T.slow.n >= 25 && T.fast.badRate >= Math.max(T.slow.badRate * 1.6, T.slow.badRate + 3)) {
      add(weak, {
        id: 'impulsive',
        icon: 'bolt',
        sev: Math.round(Math.min(80, (T.fast.badRate / Math.max(0.5, T.slow.badRate) - 1) * 28)),
        title: 'Your quick moves cost you',
        stat: `${T.fast.badRate}% vs ${T.slow.badRate}% errors`,
        detail: `In sharp positions, moves you play almost instantly are serious mistakes ${T.fast.badRate}% of the time. When you take a moment to think, that drops to ${T.slow.badRate}%.`,
        advice: [
          'When the position is tense (pieces attacking each other, kings exposed), take three seconds for a quick safety check.',
          'Premove only in simple positions, like recaptures or obvious king moves in the endgame.',
          'Sit on your hands: decide on a move, then look once more at what your opponent threatens.',
        ],
        examples: [],
      });
    }
    // Phases
    const ph = E.phases;
    const phs = ['o', 'm', 'e'].filter((k) => ph[k].acc != null && ph[k].n >= 30);
    if (phs.length >= 2) {
      const sorted = [...phs].sort((a, b) => ph[a].acc - ph[b].acc);
      const lo = sorted[0];
      const hi = sorted[sorted.length - 1];
      const gap = ph[hi].acc - ph[lo].acc;
      if (gap >= 6) {
        const ADV = {
          o: ['Pick one opening as White and one defense against 1.e4 and 1.d4, and stick with them.', 'Learn the ideas behind your openings (where the pieces belong, which pawn breaks matter), not only the moves.', 'After each game, check where you left the book and what the main line was.'],
          m: ['Before each move in the middlegame, find a plan: which piece is your worst, and where should it go?', 'Look for weaknesses in your opponent\'s camp (loose pieces, weak squares, an exposed king) and aim your pieces at them.', 'Solve tactics daily. Most middlegame mistakes are missed tactics.'],
          e: ['In the endgame, your king is a fighting piece. Bring it to the center early.', 'Learn the key rook endgames (Lucena and Philidor) and basic king and pawn endings like opposition.', 'Practice converting winning endgames against the computer from a set position.'],
        };
        add(weak, {
          id: 'phase-' + lo,
          icon: lo === 'o' ? 'book' : lo === 'e' ? 'excellent' : 'cpu',
          sev: Math.round(Math.min(70, gap * 3)),
          title: `Your ${PHASE_NAME[lo].toLowerCase()} is the weak link`,
          stat: `${ph[lo].acc}% vs ${ph[hi].acc}% accuracy`,
          detail: `You play the ${PHASE_NAME[hi].toLowerCase()} at ${ph[hi].acc}% accuracy, but the ${PHASE_NAME[lo].toLowerCase()} at only ${ph[lo].acc}%. That is where ${ph[lo].errPerGame >= ph[hi].errPerGame ? `most of your serious mistakes happen (${ph[lo].errPerGame} per game)` : 'your play is least precise'}.`,
          advice: ADV[lo],
          examples: examplesFor(E, (x) => x.ph === lo),
        });
        add(strong, { id: 'phase-' + hi, icon: 'best', title: `Strong ${PHASE_NAME[hi].toLowerCase()}`, detail: `${ph[hi].acc}% accuracy, your best phase of the game.` });
      }
    }
    // Opening outcome
    if (E.openWin != null && E.openWin < 45 && E.games >= 8) {
      const worst = E.openFams[0];
      add(weak, {
        id: 'opening',
        icon: 'book',
        sev: Math.round(Math.min(80, (50 - E.openWin) * 4)),
        title: 'You come out of the opening worse',
        stat: `${Math.round(E.openWin)}% win chance after move 10`,
        detail: `After 10 moves your winning chances are ${Math.round(E.openWin)}% on average, so you start the middlegame on the back foot.${worst && worst.win < 42 ? ` The ${worst.name} as ${worst.color === 'w' ? 'White' : 'Black'} is the biggest problem (${Math.round(worst.win)}% after move 10).` : ''}`,
        advice: [
          worst ? `Study the first 8 to 10 moves of the ${worst.name} and the plans that follow.` : 'Study the first 8 to 10 moves of your main openings and the plans that follow.',
          'Follow the opening principles: control the center, develop knights and bishops, castle, and don\'t move the same piece twice.',
          "Don't grab pawns in the opening if it costs you development.",
        ],
        examples: [],
      });
    }
    // Conversion
    const cv = E.conv;
    if (cv.chances >= 4 && cv.rate < 75) {
      add(weak, {
        id: 'conversion',
        icon: 'inaccuracy',
        sev: Math.round(Math.min(90, (85 - cv.rate) * 1.4)),
        title: 'You let winning games slip',
        stat: `${cv.rate}% of winning positions won`,
        detail: `You had a winning position in ${plural(cv.chances, 'game')} but won only ${cv.W}. ${cv.D ? `${plural(cv.D, 'draw')} and ` : ''}${plural(cv.L, 'loss', 'losses')} came from positions you should have won.`,
        advice: [
          'When you are winning, simplify: trade pieces (not pawns) and head for an endgame.',
          'Keep asking what your opponent is threatening. Winning positions get lost to one tactic, not to slow play.',
          "Don't rush. Being up material means time is on your side, so remove your opponent's counterplay first.",
        ],
        examples: [],
        thrown: cv.thrown,
      });
    } else if (cv.chances >= 4 && cv.rate >= 88) {
      add(strong, { id: 'conversion', icon: 'best', title: 'Clinical finisher', detail: `You won ${cv.rate}% of the games where you got a winning position.` });
    }
    if (pr.chances >= 8 && pr.rate >= 65) add(strong, { id: 'punish', icon: 'great', title: 'You punish mistakes', detail: `${pr.rate}% of your opponents' serious mistakes were answered with the right move.` });
    if (E.back.chances >= 4 && E.back.rate >= 30) add(strong, { id: 'fighter', icon: 'brilliant', title: 'Never gives up', detail: E.back.W === E.back.saved ? `You turned ${E.back.W} of ${plural(E.back.chances, 'lost position')} into wins.` : `You saved ${E.back.saved} of ${plural(E.back.chances, 'lost position')}${E.back.W ? ` and won ${E.back.W} of them` : ''}.` });
    const brill = (E.counts.brilliant || 0) + (E.counts.great || 0);
    if (brill >= 3) add(strong, { id: 'finds', icon: 'brilliant', title: 'You find great moves', detail: `${plural(E.counts.brilliant || 0, 'brilliant move')} and ${plural(E.counts.great || 0, 'great move')} in ${plural(E.games, 'game')}.` });
    if (T.low.n >= 25 && T.norm.badRate != null && T.low.badRate <= T.norm.badRate * 1.15) add(strong, { id: 'cool', icon: 'timer', title: 'Cool under pressure', detail: 'Your play barely gets worse when the clock runs low.' });
    if (E.trend >= 3) add(strong, { id: 'improving', icon: 'chart', title: 'You are improving', detail: `Your accuracy in recent games is ${E.trend} points higher than before.` });
  }

  // ---- results-based insights (all games)
  if (R.tilt.afterLoss.n >= 8 && R.tilt.afterWin.n >= 8 && R.tilt.afterWin.score - R.tilt.afterLoss.score >= 10) {
    const gap = Math.round(R.tilt.afterWin.score - R.tilt.afterLoss.score);
    add(weak, {
      id: 'tilt',
      icon: 'blunder',
      sev: Math.round(Math.min(85, gap * 2.2)),
      title: 'Losses carry over into the next game',
      stat: `${Math.round(R.tilt.afterLoss.score)}% after a loss`,
      detail: `Right after a win you score ${Math.round(R.tilt.afterWin.score)}%, but right after a loss only ${Math.round(R.tilt.afterLoss.score)}%. Playing on straight away after a loss is costing you rating.`,
      advice: [
        'After a loss, take a 5 to 10 minute break before the next game. Stand up, get some water.',
        'Set a stop rule: two losses in a row means the session is over.',
        "Review a loss before playing again. Understanding what happened takes the sting out of it.",
      ],
      examples: [],
    });
  }
  if (R.tilt.late.n >= 10 && R.score - R.tilt.late.score >= 8) {
    add(weak, {
      id: 'sessions',
      icon: 'history',
      sev: Math.round(Math.min(70, (R.score - R.tilt.late.score) * 2)),
      title: 'Long sessions wear you down',
      stat: `${Math.round(R.tilt.late.score)}% from game 6 on`,
      detail: `From the sixth game of a session onward you score ${Math.round(R.tilt.late.score)}%, compared with ${Math.round(R.score)}% overall.`,
      advice: ['Keep sessions to about five games, then take a real break.', 'Quality over quantity: one focused game is worth more than five tired ones.', 'If you feel yourself playing faster and angrier, stop for the day.'],
      examples: [],
    });
  }
  if (R.white.n >= 10 && R.black.n >= 10) {
    const d = R.white.score - R.black.score;
    if (Math.abs(d) >= 12) {
      const weakC = d > 0 ? 'Black' : 'White';
      const strongC = d > 0 ? 'White' : 'Black';
      const list = d > 0 ? R.openBlack : R.openWhite;
      const worst = [...list].filter((o) => o.n >= 4).sort((a, b) => a.score - b.score)[0];
      add(weak, {
        id: 'color',
        icon: 'flip',
        sev: Math.round(Math.min(75, Math.abs(d) * 2)),
        title: `You struggle with ${weakC}`,
        stat: `${Math.round(Math.min(R.white.score, R.black.score))}% vs ${Math.round(Math.max(R.white.score, R.black.score))}%`,
        detail: `You score ${Math.round(Math.max(R.white.score, R.black.score))}% with ${strongC} but only ${Math.round(Math.min(R.white.score, R.black.score))}% with ${weakC}.${worst ? ` The ${worst.name} is your weakest line as ${weakC} (${Math.round(worst.score)}% in ${worst.n} games).` : ''}`,
        advice: [
          worst ? `Rework your ${worst.name} as ${weakC}, or switch to a simpler line you understand well.` : `Build a small, solid repertoire for ${weakC} and play it every game.`,
          `Study a few model games by strong players in your ${weakC} openings to learn the typical plans.`,
          `Review your last five losses as ${weakC} and look for a pattern in where things go wrong.`,
        ],
        examples: [],
      });
    }
  }
  const lowerOpp = R.vsStrength.slice(0, 2).reduce((a, b) => ({ n: a.n + b.n, s: a.s + (b.score * b.n) / 100, e: a.e + (b.exp * b.n) / 100 }), { n: 0, s: 0, e: 0 });
  if (lowerOpp.n >= 10 && (lowerOpp.s - lowerOpp.e) / lowerOpp.n <= -0.12) {
    add(weak, {
      id: 'upsets',
      icon: 'mistake',
      sev: Math.round(Math.min(70, ((lowerOpp.e - lowerOpp.s) / lowerOpp.n) * 220)),
      title: 'Lower-rated players beat you too often',
      stat: `${pct(lowerOpp.s, lowerOpp.n)}% (expected ${pct(lowerOpp.e, lowerOpp.n)}%)`,
      detail: `Against opponents rated lower than you, you score ${pct(lowerOpp.s, lowerOpp.n)}% while your rating says you should score ${pct(lowerOpp.e, lowerOpp.n)}%.`,
      advice: ['Respect every opponent. Lower-rated players punish careless moves too.', 'Against weaker players, play solid chess and wait for their mistakes instead of forcing things.', 'Keep the same blunder check routine no matter who you play.'],
      examples: [],
    });
  }
  const higherOpp = R.vsStrength.slice(3).reduce((a, b) => ({ n: a.n + b.n, s: a.s + (b.score * b.n) / 100, e: a.e + (b.exp * b.n) / 100 }), { n: 0, s: 0, e: 0 });
  if (higherOpp.n >= 8 && (higherOpp.s - higherOpp.e) / higherOpp.n >= 0.08) add(strong, { id: 'giant', icon: 'great', title: 'Giant killer', detail: `You score ${pct(higherOpp.s, higherOpp.n)}% against higher-rated players, more than the ${pct(higherOpp.e, higherOpp.n)}% expected.` });
  if (nLoss >= 8 && R.quickLosses >= 3 && R.quickLosses / nLoss >= 0.2) {
    add(weak, {
      id: 'quick',
      icon: 'book',
      sev: Math.round(Math.min(65, (R.quickLosses / nLoss) * 120)),
      title: 'Too many short losses',
      stat: `${plural(R.quickLosses, 'loss', 'losses')} in 25 moves or fewer`,
      detail: `${pct(R.quickLosses, nLoss)}% of your losses are over by move 25. Early disasters usually mean opening traps or an unsafe king.`,
      advice: ['Learn the common traps in your openings, both to avoid them and to use them.', "Castle before starting an attack, and don't bring the queen out too early.", 'Look out for early checks and captures on f7 and f2, the weakest squares at the start.'],
      examples: [],
    });
  }
  const goodDay = R.dayparts.filter((x) => x.n >= 10).sort((a, b) => b.score - a.score);
  if (goodDay.length >= 2 && goodDay[0].score - goodDay[goodDay.length - 1].score >= 15) {
    const b = goodDay[0];
    const w = goodDay[goodDay.length - 1];
    add(weak, {
      id: 'daytime',
      icon: 'sun',
      sev: Math.round(Math.min(50, (b.score - w.score) * 1.4)),
      title: `You play worse in the ${w.label.toLowerCase()}`,
      stat: `${Math.round(w.score)}% vs ${Math.round(b.score)}%`,
      detail: `In the ${b.label.toLowerCase()} you score ${Math.round(b.score)}%, in the ${w.label.toLowerCase()} only ${Math.round(w.score)}%.`,
      advice: [`Play your rated games in the ${b.label.toLowerCase()} when you can, and keep the ${w.label.toLowerCase()} for puzzles or unrated games.`, 'Being tired or distracted shows up on the board. Play when you can fully focus.'],
      examples: [],
    });
  }
  const bestOpen = [...R.openWhite, ...R.openBlack].filter((o) => o.n >= 6).sort((a, b) => b.score - a.score)[0];
  if (bestOpen && bestOpen.score >= 60) add(strong, { id: 'weapon', icon: 'book', title: `${bestOpen.name} is your weapon`, detail: `${Math.round(bestOpen.score)}% score in ${bestOpen.n} games. Keep playing it.` });

  weak.sort((a, b) => b.sev - a.sev);
  return { weak: weak.slice(0, 5), strong: strong.slice(0, 4) };
}

const PLAN = {
  hanging: { freq: 'Every game', text: 'Blunder check before each move: what can be captured after I play this?' },
  tactics: { freq: 'Daily · 15 min', text: 'Tactics puzzles on forks, pins and skewers.' },
  missed: { freq: '3× a week', text: 'Puzzle Rush or timed tactics to spot chances faster.' },
  king: { freq: 'Weekly', text: 'Study king safety: castling, luft and back-rank mates.' },
  time: { freq: 'Daily', text: 'Play 2 or 3 games with increment and keep a third of your clock for the endgame.' },
  impulsive: { freq: 'Every game', text: 'In sharp positions, take three seconds for a safety check before moving.' },
  'phase-o': { freq: 'Weekly · 1 h', text: 'Opening study: main lines and plans of your repertoire.' },
  'phase-m': { freq: 'Weekly · 1 h', text: 'Middlegame plans: play through two annotated master games.' },
  'phase-e': { freq: 'Weekly · 1 h', text: 'Endgame lessons: king activity, rook endgames, opposition.' },
  opening: { freq: 'Weekly · 1 h', text: 'Fix the opening that leaves you worse after move 10.' },
  conversion: { freq: 'Weekly', text: 'Practice winning won positions against the engine.' },
  tilt: { freq: 'Every session', text: 'Take a 10 minute break after every loss.' },
  sessions: { freq: 'Every session', text: 'Stop after five games or two losses in a row.' },
  color: { freq: 'Weekly · 1 h', text: 'Work on your repertoire for your weaker color.' },
  upsets: { freq: 'Every game', text: 'Same focus against everyone: no relaxing against lower-rated players.' },
  quick: { freq: 'Weekly', text: 'Learn the traps in your openings.' },
  daytime: { freq: 'Ongoing', text: 'Play rated games at the time of day you play best.' },
};

function trainingPlan(R, weak) {
  const out = [];
  for (const w of weak) {
    const p = PLAN[w.id];
    if (p && !out.some((x) => x.text === p.text)) out.push({ ...p, from: w.title });
    if (out.length >= 4) break;
  }
  out.push({ freq: 'After every loss', text: 'Review your losses in Chess Review, starting with the key moments.', from: null });
  return out;
}

function coachSummary(R, weak, strong) {
  const parts = [];
  const mode = R.mode === 'all' ? '' : ` ${R.mode}`;
  parts.push(`I looked at your last ${R.games}${mode} games. You scored ${Math.round(R.score)} percent${R.rating.change ? ` and your ${R.ratingClass} rating ${R.rating.change > 0 ? 'went up' : 'went down'} by ${Math.abs(R.rating.change)}` : ''}.`);
  if (R.engine) parts.push(`Your average accuracy was ${R.engine.acc} percent.`);
  if (strong[0]) parts.push(`Your biggest strength: ${strong[0].title.toLowerCase()}.`);
  if (weak[0]) {
    parts.push(`The thing holding you back the most: ${weak[0].title.toLowerCase()}.`);
    if (weak[0].advice?.[0]) parts.push(weak[0].advice[0].replace(/"/g, ''));
  } else parts.push('There is no single big weakness. Keep playing and reviewing your games.');
  return parts.join(' ');
}
