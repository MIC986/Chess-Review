// Rewrites coach text (written from the mover's point of view: "your knight", "your opponent")
// so it reads correctly for the person reviewing:
//   your move           -> "your knight", "your opponent"
//   opponent's move     -> "their knight", "you"
//   someone else's game -> "White's knight", "Black"

const COLOR = { w: 'White', b: 'Black' };

/**
 * @param {string} text      coach text from the mover's perspective
 * @param {'w'|'b'} mover    color that played the move
 * @param {'w'|'b'|null} me  color of the person reviewing (null if neither player)
 */
export function perspective(text, mover, me) {
  if (!text || me === mover) return text || '';
  const opp = mover === 'w' ? 'b' : 'w';
  const meIsOpp = me === opp;

  // Words for the mover and for the mover's opponent.
  const M = meIsOpp
    ? { subj: 'they', Subj: 'They', poss: 'their', Poss: 'Their' }
    : { subj: COLOR[mover], Subj: COLOR[mover], poss: `${COLOR[mover]}'s`, Poss: `${COLOR[mover]}'s` };
  const O = meIsOpp
    ? { subj: 'you', Subj: 'You', poss: 'your', Poss: 'Your', verbS: '' }
    : { subj: COLOR[opp], Subj: COLOR[opp], poss: `${COLOR[opp]}'s`, Poss: `${COLOR[opp]}'s`, verbS: 's' };

  const tok = [];
  const hold = (s) => `\u0000${tok.push(s) - 1}\u0000`;
  let t = String(text);

  // Opponent references first (they contain "your").
  t = t.replace(/\byour opponent's\b/g, () => hold(O.poss));
  t = t.replace(/\bYour opponent's\b/g, () => hold(O.Poss));
  t = t.replace(/\byour opponent (win|gain|get|take)s\b/g, (_, v) => hold(`${O.subj} ${v}${O.verbS}`));
  t = t.replace(/\byour opponent\b/g, () => hold(O.subj));
  t = t.replace(/\bYour opponent\b/g, () => hold(O.Subj));

  // Mover references.
  t = t.replace(/\byour\b/g, () => hold(M.poss));
  t = t.replace(/\bYour\b/g, () => hold(M.Poss));
  t = t.replace(/\bYou\b/g, () => hold(M.Subj));
  t = t.replace(/\byou\b/g, () => hold(M.subj));

  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => tok[+i]);
}

/** Which color is the reviewer, given their chess.com username. */
export function myColor(username, white, black) {
  const u = (username || '').trim().toLowerCase();
  if (!u) return null;
  if (white?.name?.toLowerCase() === u) return 'w';
  if (black?.name?.toLowerCase() === u) return 'b';
  return null;
}
