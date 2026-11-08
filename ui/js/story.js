// Coach's opening line for a review: one short verdict + at most one pointer, chess.com style.

const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];

export function gameStory(review, white, black, me) {
  const moves = review.moves;
  const pos = review.positions;
  const n = moves.length;
  if (!n) return "Let's look at this game together.";
  me = (me || '').toLowerCase();
  const name = { w: white.name, b: black.name };
  const isMe = { w: !!me && white.name.toLowerCase() === me, b: !!me && black.name.toLowerCase() === me };
  const mine = isMe.w || isMe.b;
  const other = (c) => (c === 'w' ? 'b' : 'w');
  const winOf = (c, p) => (c === 'w' ? p.win : 100 - p.win);
  const seed = n + Math.round(review.white.accuracy + review.black.accuracy);

  const res = review.result;
  const winner = res === '1-0' ? 'w' : res === '0-1' ? 'b' : null;

  // Biggest single mistake after the opening.
  const book = moves.filter((m) => m.classification === 'book').length;
  const turn = moves
    .filter((m) => ['blunder', 'mistake', 'miss'].includes(m.classification) && m.ply > book)
    .map((m) => ({ m, drop: m.winBefore - m.winAfter }))
    .sort((a, b) => b.drop - a.drop)[0];
  const brilliant = moves.find((m) => m.classification === 'brilliant');

  let verdict;
  let pointer = '';

  if (winner) {
    const after = pos.slice(Math.min(book + 2, n));
    const ahead = after.filter((p) => winOf(winner, p) >= 55).length / Math.max(1, after.length);
    const loser = other(winner);
    const decidedBy = turn && turn.m.color === loser && turn.drop >= 20 ? turn.m : null;

    // Real comeback: the winner was clearly lost for a while (not just a one-move dip).
    let run = 0;
    let longest = 0;
    for (const p of after) {
      run = winOf(winner, p) <= 20 ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    let leader = null;
    let swings = 0;
    for (const p of after) {
      const l = p.win >= 65 ? 'w' : p.win <= 35 ? 'b' : null;
      if (l && leader && l !== leader) swings++;
      if (l) leader = l;
    }

    if (longest >= 6) {
      verdict = isMe[winner]
        ? pick(['What a comeback! You turned a lost position around.', 'Great fight! You came back from a losing position.'], seed)
        : isMe[loser]
          ? 'So close! You were winning, but let it slip away.'
          : `${name[winner]} came back from a losing position to win.`;
    } else if (swings >= 2) {
      verdict = isMe[winner]
        ? pick(['A wild game! It went back and forth, but you came out on top.', 'What a battle! The lead changed hands, but you won it.'], seed)
        : isMe[loser]
          ? 'A wild game that went back and forth. You had your chances!'
          : `A wild, back-and-forth game that ${name[winner]} won in the end.`;
    } else if (ahead >= 0.75) {
      verdict = isMe[winner]
        ? pick(['Well played! You were in control from start to finish.', 'A clean win. You were better the whole game.'], seed)
        : isMe[loser]
          ? 'A tough game. Your opponent was in control throughout.'
          : `${name[winner]} was in control from start to finish.`;
    } else if (decidedBy) {
      verdict = isMe[winner]
        ? `Nice win! Your opponent's mistake on move ${decidedBy.moveNumber} decided it.`
        : isMe[loser]
          ? `A tough loss. The game turned on move ${decidedBy.moveNumber}.`
          : `A close game, decided by a mistake on move ${decidedBy.moveNumber}.`;
    } else {
      verdict = isMe[winner] ? 'Good win in a close game!' : isMe[loser] ? 'A close game that got away from you.' : `${name[winner]} won a close game.`;
    }
    if (!decidedBy && turn && turn.drop >= 20 && swings < 2) pointer = `The key moment came on move ${turn.m.moveNumber}.`;
  } else if (res === '1/2-1/2') {
    const maxEdge = Math.max(...pos.map((p) => Math.abs(p.win - 50)));
    verdict = maxEdge >= 30 ? 'A draw, but there were winning chances along the way.' : 'A balanced game that ended in a draw.';
  } else {
    verdict = "Let's look at the key moments of this game.";
  }

  if (brilliant) pointer = mine && isMe[brilliant.color] ? 'You found a brilliant move. Can you spot it?' : 'There is a brilliant move in this game!';
  return pointer ? `${verdict} ${pointer}` : verdict;
}
