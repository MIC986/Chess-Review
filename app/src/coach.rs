//! The virtual coach: turns engine output into short, human explanations.

use crate::chess::*;
use crate::engine::Score;
use shakmaty::{Chess, Color, Move, Position, Role, Square};

pub struct Explanation {
    pub title: String,
    pub text: String,
    pub best_text: Option<String>,
}

pub struct MoveCtx<'a> {
    pub ply: usize,
    pub before: &'a Chess,
    pub after: &'a Chess,
    pub mv: Move,
    pub san: &'a str,
    pub class: &'a str,
    pub prev_move: Option<Move>,
    pub best_move: Option<Move>,
    pub best_san: Option<&'a str>,
    /// Engine line from `before` (starts with the best move).
    pub best_line: &'a [String],
    /// Engine line from `after` (opponent's best reply first).
    pub reply_line: &'a [String],
    pub best_score: Score,   // mover perspective
    pub played_score: Score, // mover perspective
    pub win_before: f64,
    pub win_after: f64,
    pub opening: Option<&'a str>,
}

fn article(word: &str) -> &'static str {
    match word.chars().next() {
        Some('a' | 'e' | 'i' | 'o' | 'u') => "an",
        _ => "a",
    }
}

pub fn title_for(san: &str, class: &str) -> String {
    match class {
        "brilliant" => format!("{san} is brilliant"),
        "great" => format!("{san} is a great move"),
        "best" => format!("{san} is best"),
        "excellent" => format!("{san} is excellent"),
        "good" => format!("{san} is good"),
        "book" => format!("{san} is a book move"),
        "inaccuracy" => format!("{san} is an inaccuracy"),
        "mistake" => format!("{san} is a mistake"),
        "miss" => format!("{san} is a miss"),
        "blunder" => format!("{san} is a blunder"),
        "forced" => format!("{san} is forced"),
        _ => san.to_string(),
    }
}

/// Plays a UCI line and returns the settled material swing for `side`
/// (positive = good), measured at the end of the line after recaptures.
pub(crate) fn line_material_swing(pos: &Chess, line: &[String], side: Color, plies: usize) -> (i32, Option<Role>) {
    let mut p = pos.clone();
    let start = material(p.board(), side) - material(p.board(), !side);
    let mut settled: i32 = 0;
    let mut cap_role = None;
    let mut biggest: Option<Role> = None;
    for (k, u) in line.iter().take(plies).enumerate() {
        let Some(m) = parse_uci(&p, u) else { break };
        if let Some(c) = m.capture() {
            if biggest.map_or(true, |b| value(c) > value(b)) {
                biggest = Some(c);
            }
        }
        p.play_unchecked(m);
        let d = material(p.board(), side) - material(p.board(), !side) - start;
        // Only trust measurements taken when no capture is pending on the board.
        if k % 2 == 1 && !m.is_capture() {
            settled = d;
            cap_role = biggest;
        }
    }
    (settled, cap_role)
}

pub(crate) fn piece_word_for_swing(delta: i32) -> &'static str {
    match delta.abs() {
        0 | 1 => "a pawn",
        2 => "material",
        3 | 4 => "a piece",
        5 | 6 => "the exchange or more",
        7 | 8 => "a lot of material",
        _ => "the queen",
    }
}

pub(crate) enum Threat {
    Fork(Role, Role, Role),
    Attack(Role, Square),
}

pub(crate) fn find_threat(after: &Chess, to: Square, mover: Color) -> Option<Threat> {
    let board = after.board();
    let moved_role = board.role_at(to)?;
    let targets = attacked_by(board, to, !mover);
    // A target is real if it is the king, worth more than the attacker, or simply hanging.
    let real: Vec<(Square, Role)> = targets
        .into_iter()
        .filter(|(sq, r)| *r == Role::King || value(*r) > value(moved_role) || see(board, *sq, mover) > 0)
        .collect();
    let big: Vec<&(Square, Role)> = real.iter().filter(|(_, r)| *r == Role::King || value(*r) >= 3).collect();
    // The forking piece must not simply be captured for free.
    let attacker_safe = see(board, to, !mover) == 0 || after.is_check();
    if big.len() >= 2 && attacker_safe {
        let mut b: Vec<Role> = big.iter().map(|(_, r)| *r).collect();
        b.sort_by_key(|r| -value(*r));
        return Some(Threat::Fork(moved_role, b[0], b[1]));
    }
    real.iter().find(|(_, r)| *r != Role::King).map(|(sq, r)| Threat::Attack(*r, *sq))
}

fn plural(role: Role) -> String {
    format!("{}s", role_name(role))
}

fn cap_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// Picks one of several phrasings, stable for a given move, so the coach doesn't repeat itself.
fn pick(seed: usize, salt: usize, opts: Vec<String>) -> String {
    if opts.is_empty() {
        return String::new();
    }
    let h = seed.wrapping_mul(2654435761).wrapping_add(salt.wrapping_mul(40503)) >> 3;
    opts[h % opts.len()].clone()
}

macro_rules! v {
    ($($e:expr),+ $(,)?) => { vec![$($e.to_string()),+] };
}

fn fork_text(seed: usize, f: Role, a: Role, b: Role) -> String {
    let (f, a, b) = (role_name(f), role_name(a), role_name(b));
    pick(seed, 1, v![
        format!("A {f} fork! It hits the {a} and the {b} at once."),
        format!("Forks the {a} and the {b}."),
        format!("The {f} attacks the {a} and the {b} at the same time."),
        format!("Double attack: the {f} goes after the {a} and the {b}."),
    ])
}

/// What does a good move accomplish?
pub fn describe_good(before: &Chess, m: Move, rest_line: &[String], score: Score, ply: usize, prev: Option<Move>) -> String {
    describe_good_ex(before, m, rest_line, score, ply, prev, ply).0
}

/// Like `describe_good`, with its own phrasing seed. The flag is true when the text is only a
/// general verdict ("keeps the balance") rather than something concrete the move does.
fn describe_good_ex(before: &Chess, m: Move, rest_line: &[String], score: Score, ply: usize, prev: Option<Move>, seed: usize) -> (String, bool) {
    let s = seed;
    (describe_inner(before, m, rest_line, score, ply, prev, s), GENERIC.with(|g| g.replace(false)))
}

thread_local! {
    static GENERIC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn describe_inner(before: &Chess, m: Move, rest_line: &[String], score: Score, ply: usize, prev: Option<Move>, s: usize) -> String {
    GENERIC.with(|g| g.set(false));
    let mover = before.turn();
    let mut after = before.clone();
    after.play_unchecked(m);
    if after.is_checkmate() {
        return "Checkmate!".into();
    }
    if let Some(n) = score.mate {
        if n > 0 {
            return if n == 1 {
                pick(s, 2, v!["Checkmate is coming next move.", "Sets up checkmate on the next move.", "Now there is mate in one."])
            } else {
                pick(s, 3, v![
                    format!("Starts a forced checkmate in {n}."),
                    format!("Leads to a forced mate in {n}."),
                    format!("From here it is mate in {n} by force."),
                ])
            };
        }
    }
    let (_, to) = move_squares(m);
    let to_sq: Square = to.parse().unwrap_or(m.to());
    if let Some(p) = m.promotion() {
        let r = role_name(p);
        let a = article(r);
        return pick(s, 4, v![
            format!("Promotes the pawn to {a} {r}."),
            format!("The pawn reaches the last rank and becomes {a} {r}."),
            format!("A new {r} joins the game."),
        ]);
    }
    if let Some(cap) = m.capture() {
        let prev_cap = prev.filter(|p| p.to() == m.to()).and_then(|p| p.capture());
        let lost_back = see(after.board(), m.to(), !mover);
        let net = value(cap) - lost_back;
        let r = role_name(cap);
        let a = article(r);
        if m.is_en_passant() {
            return pick(s, 5, v!["Captures the pawn en passant.", "Takes en passant.", "An en passant capture."]);
        }
        if let Some(pc) = prev_cap {
            if value(cap) <= value(pc) + 1 || net <= 1 {
                return pick(s, 6, v![
                    format!("Recaptures the {r}."),
                    format!("Takes back the {r}, restoring the balance."),
                    format!("A natural recapture of the {r}."),
                    format!("Wins back the {r}."),
                ]);
            }
        }
        if net >= 2 || (cap != Role::Pawn && lost_back == 0) {
            return pick(s, 7, v![
                format!("Wins {a} {r}."),
                format!("Picks up {a} {r} for free."),
                format!("Grabs {a} {r} that was not properly defended."),
                format!("The {r} was loose, and now it falls."),
            ]);
        }
        if net == 1 && cap == Role::Pawn {
            return pick(s, 8, v!["Wins a pawn.", "Picks up a pawn.", "Grabs a pawn and comes out ahead in material."]);
        }
        if cap == Role::Pawn {
            return pick(s, 9, v!["Trades pawns.", "Exchanges a pair of pawns.", "Swaps off a pair of pawns."]);
        }
        if net <= 0 && value(cap) >= 3 {
            let rs = plural(cap);
            return pick(s, 10, v![
                format!("Trades off the {r}."),
                format!("Exchanges the {rs}."),
                format!("Simplifies by trading {rs}."),
            ]);
        }
    }
    let w = score.win_pct();
    if after.is_check() {
        if let Some(Threat::Fork(f, a, b)) = find_threat(&after, to_sq, mover) {
            return fork_text(s, f, a, b);
        }
        let (swing, _) = line_material_swing(&after, rest_line, mover, 6);
        if swing >= 2 && w >= 60.0 {
            let what = piece_word_for_swing(swing);
            return pick(s, 11, v![
                format!("A check that wins {what}."),
                format!("Wins {what} with a well-timed check."),
                format!("Checks, and {what} falls next."),
            ]);
        }
        return pick(s, 12, v!["Puts the king in check.", "Check! The king has to deal with it.", "Gives check and forces a reply."]);
    }
    if m.is_castle() {
        return pick(s, 13, v![
            "Castling gets the king to safety and connects the rooks.",
            "Tucks the king away and brings a rook toward the center.",
            "King safety first. Castling also connects the rooks.",
        ]);
    }
    // Saving a piece that was under attack
    let hanging_before = hanging_pieces(before.board(), mover);
    if let Some(from) = m.from() {
        if hanging_before.iter().any(|h| h.square == from) {
            let r = role_name(m.role());
            return pick(s, 14, v![
                format!("Moves the {r} out of danger."),
                format!("Rescues the {r}, which was under attack."),
                format!("Gets the {r} to safety."),
            ]);
        }
    }
    if !hanging_before.is_empty() {
        let hanging_after = hanging_pieces(after.board(), mover);
        if hanging_after.len() < hanging_before.len() {
            let h = &hanging_before[0];
            let (r, sq) = (role_name(h.role), h.square);
            return pick(s, 15, v![
                format!("Protects the {r} on {sq}."),
                format!("Defends the {r} on {sq}."),
                format!("Covers the {r} on {sq}, which needed help."),
            ]);
        }
    }
    match find_threat(&after, to_sq, mover) {
        Some(Threat::Fork(f, a, b)) => return fork_text(s, f, a, b),
        Some(Threat::Attack(r, sq)) => {
            let r = role_name(r);
            return pick(s, 16, v![
                format!("Attacks the {r} on {sq}."),
                format!("Goes after the {r} on {sq}."),
                format!("Puts pressure on the {r} on {sq}."),
                format!("Targets the {r} on {sq}."),
            ]);
        }
        None => {}
    }
    let (swing, _) = line_material_swing(&after, rest_line, mover, 8);
    if swing >= 2 && w >= 60.0 {
        let what = piece_word_for_swing(swing);
        return pick(s, 17, v![
            format!("Wins {what} by force."),
            format!("Sets up a sequence that wins {what}."),
            format!("Starts a combination that wins {what}."),
        ]);
    }
    let role = m.role();
    if ply < 24 && (role == Role::Knight || role == Role::Bishop) {
        if let Some(from) = m.from() {
            let back = if mover == Color::White { 0 } else { 7 };
            if from.rank().to_u32() == back {
                let r = role_name(role);
                return pick(s, 18, v![
                    format!("Develops the {r} toward the center."),
                    format!("Brings the {r} into the game."),
                    format!("Gets the {r} out, aiming at the center."),
                    format!("Good development. The {r} joins the fight."),
                ]);
            }
        }
    }
    if ply < 20 && role == Role::Pawn {
        let f = m.to().file().char();
        if f == 'd' || f == 'e' || f == 'c' {
            return pick(s, 19, v![
                "Fights for control of the center.",
                "Stakes a claim in the center.",
                "Grabs space in the center.",
                "Strengthens your hold on the center.",
            ]);
        }
    }
    if role == Role::Pawn && non_pawn_material(after.board()) <= 26 {
        return pick(s, 20, v![
            "Pushes the pawn closer to promotion.",
            "The pawn marches toward promotion.",
            "One step closer to a new queen.",
        ]);
    }
    if ply < 30 && role == Role::Rook {
        return pick(s, 21, v!["Brings the rook to a more active square.", "Activates the rook.", "Puts the rook on a more useful file."]);
    }
    GENERIC.with(|g| g.set(true));
    if w >= 80.0 {
        pick(s, 22, v!["Keeps a winning position.", "Stays firmly on the winning path.", "Keeps everything under control.", "The win is still in hand."])
    } else if w >= 60.0 {
        pick(s, 23, v!["Keeps your advantage.", "Holds on to the advantage.", "Keeps the pressure on.", "Your edge stays intact."])
    } else if w >= 40.0 {
        pick(s, 24, v!["Keeps the position balanced.", "A solid move. The game stays level.", "Keeps things equal.", "Maintains the balance."])
    } else {
        pick(s, 25, v![
            "The toughest defense in a difficult position.",
            "Puts up the most resistance.",
            "The best try in a tough spot.",
            "Makes it as hard as possible for your opponent.",
        ])
    }
}

pub fn explain(ctx: &MoveCtx) -> Explanation {
    let mover = ctx.before.turn();
    let s = ctx.ply;
    let title = title_for(ctx.san, ctx.class);
    let rest_best: Vec<String> = ctx.best_line.iter().skip(1).cloned().collect();
    let best_desc = ctx.best_move.map(|bm| describe_good_ex(ctx.before, bm, &rest_best, ctx.best_score, ctx.ply, ctx.prev_move, ctx.ply + 7919));
    let best_line_text = |b: &str| -> String {
        match &best_desc {
            Some((desc, false)) => format!("{b} was best. {desc}"),
            _ => pick(s, 34, v![format!("{b} was best."), format!("{b} was the most accurate move."), format!("{b} was a little stronger.")]),
        }
    };

    if ctx.after.is_checkmate() {
        return Explanation {
            title,
            text: format!("Checkmate! {} wins the game.", color_name(mover)),
            best_text: None,
        };
    }

    match ctx.class {
        "forced" => Explanation {
            title,
            text: pick(s, 30, v!["The only legal move.", "There was no other choice.", "Forced. Nothing else was legal."]),
            best_text: None,
        },
        "book" => {
            let tail = pick(s, 31, v!["A standard opening move.", "Well-known opening theory.", "A common move in this opening.", "Straight out of the opening books."]);
            let text = match ctx.opening {
                Some(name) => format!("{name}. {tail}"),
                None => tail,
            };
            Explanation { title, text, best_text: None }
        }
        "brilliant" => {
            let after_board = ctx.after.board();
            let hp = hanging_pieces(after_board, mover);
            let piece = hp.first().map(|h| role_name(h.role)).unwrap_or("material");
            let follow = describe_good(ctx.before, ctx.mv, ctx.best_line.get(1..).unwrap_or(&[]), ctx.played_score, ctx.ply, ctx.prev_move);
            let text = if follow.to_lowercase().contains("mate") {
                format!("Giving up the {piece} leads to a winning attack. {follow}")
            } else {
                pick(s, 32, v![
                    format!("Giving up the {piece} is the strongest move in the position."),
                    format!("A bold sacrifice. The {piece} is offered, and it works."),
                    format!("Sacrifices the {piece}, and the engine agrees it is the best move."),
                ])
            };
            Explanation { title, text, best_text: None }
        }
        "great" => {
            let d = describe_good(ctx.before, ctx.mv, ctx.best_line.get(1..).unwrap_or(&[]), ctx.played_score, ctx.ply, ctx.prev_move);
            let lead = pick(s, 33, v![
                "The only good move in the position.",
                "Every other move was clearly worse.",
                "A hard move to find, and the only one that works.",
            ]);
            Explanation { title, text: format!("{lead} {d}"), best_text: None }
        }
        "best" | "excellent" | "good" => {
            let line: Vec<String> = ctx.reply_line.to_vec();
            let d = describe_good(ctx.before, ctx.mv, &line, ctx.played_score, ctx.ply, ctx.prev_move);
            let best_text = if ctx.class != "best" {
                ctx.best_san.map(best_line_text)
            } else {
                None
            };
            let best_text = best_text.map(|bt| same_job(bt, &d, ctx.best_san, s));
            Explanation { title, text: d, best_text }
        }
        _ => {
            // inaccuracy / mistake / blunder / miss
            let text = describe_bad(ctx);
            let best_text = ctx.best_san.map(|b| match &best_desc {
                Some((desc, _)) => format!("{b} was best. {desc}"),
                None => format!("{b} was best."),
            });
            let best_text = best_text.map(|bt| same_job(bt, &text, ctx.best_san, s));
            Explanation { title, text, best_text }
        }
    }
}

/// If the best move would be described with exactly the played move's words, say it differently.
fn same_job(best_text: String, played: &str, best_san: Option<&str>, s: usize) -> String {
    match best_san {
        Some(b) if best_text.ends_with(played) && !played.is_empty() => pick(s, 35, v![
            format!("{b} was best. It does the same job more precisely."),
            format!("{b} was best, with the same idea in a stronger form."),
        ]),
        _ => best_text,
    }
}

fn describe_bad(ctx: &MoveCtx) -> String {
    let s = ctx.ply;
    let mover = ctx.before.turn();
    if ctx.class == "miss" {
        if let Some(n) = ctx.best_score.mate {
            if n > 0 {
                return pick(s, 40, v![
                    format!("You missed a forced checkmate in {n}."),
                    format!("There was a forced mate in {n} here."),
                    format!("Checkmate in {n} was on the board."),
                ]);
            }
        }
        let (swing, role) = line_material_swing(ctx.before, ctx.best_line, mover, 8);
        if swing >= 2 && ctx.win_before >= 60.0 {
            let what = match role {
                Some(r) if r != Role::Pawn => format!("the {}", role_name(r)),
                _ => piece_word_for_swing(swing).to_string(),
            };
            return pick(s, 41, v![
                format!("You missed a chance to win {what}."),
                format!("{} was there for the taking.", cap_first(&what)),
                format!("A chance to win {what} slipped by."),
            ]);
        }
        return pick(s, 42, v![
            "You missed a chance to punish your opponent's mistake.",
            "Your opponent's mistake goes unpunished.",
            "There was a way to take advantage of your opponent's error.",
        ]);
    }
    if let Some(n) = ctx.played_score.mate {
        if n < 0 {
            let n = -n;
            return if n <= 1 {
                pick(s, 43, v!["Allows checkmate in one.", "Walks into a mate in one.", "Now your opponent has checkmate in one."])
            } else {
                pick(s, 44, v![
                    format!("Allows a forced checkmate in {n}."),
                    format!("Gives your opponent a forced mate in {n}."),
                    format!("Lets your opponent force checkmate in {n}."),
                ])
            };
        }
    }
    if let Some(n) = ctx.best_score.mate {
        if n > 0 && ctx.played_score.mate.map_or(true, |m| m <= 0) {
            return pick(s, 45, v![
                format!("Misses a forced checkmate in {n}."),
                format!("Overlooks a forced mate in {n}."),
                format!("There was a forced checkmate in {n}."),
            ]);
        }
    }
    // Newly hanging pieces
    let before_h = hanging_pieces(ctx.before.board(), mover);
    let after_h = hanging_pieces(ctx.after.board(), mover);
    for h in &after_h {
        let was = before_h.iter().find(|b| b.square == h.square);
        let newly = was.map_or(true, |b| h.gain > b.gain);
        let moved_here = h.square == ctx.mv.to();
        let (r, sq) = (role_name(h.role), h.square);
        if (newly || moved_here) && h.gain >= 1 {
            if moved_here {
                return pick(s, 46, v![
                    format!("Hangs your {r}. It can be captured on {sq}."),
                    format!("Your {r} can simply be taken on {sq}."),
                    format!("Puts your {r} on {sq}, where it can be captured."),
                    format!("Your {r} on {sq} is left hanging."),
                ]);
            }
            return pick(s, 47, v![
                format!("Leaves your {r} on {sq} undefended."),
                format!("Your {r} on {sq} is now unprotected."),
                format!("Forgets about the {r} on {sq}, which is now loose."),
            ]);
        }
    }
    if let Some(h) = after_h.first() {
        if h.gain >= 2 {
            let (r, sq) = (role_name(h.role), h.square);
            return pick(s, 48, v![
                format!("Your {r} on {sq} is still under attack."),
                format!("Ignores the threat to your {r} on {sq}."),
                format!("The {r} on {sq} is still hanging."),
            ]);
        }
    }
    // Opponent's tactical reply
    if let Some(reply_uci) = ctx.reply_line.first() {
        if let Some(reply) = parse_uci(ctx.after, reply_uci) {
            let reply_san = san_of(ctx.after, reply);
            let mut p = ctx.after.clone();
            p.play_unchecked(reply);
            let (_, rto) = move_squares(reply);
            let rto_sq: Square = rto.parse().unwrap_or(reply.to());
            if let Some(Threat::Fork(f, a, b)) = find_threat(&p, rto_sq, !mover) {
                let (f, a, b) = (role_name(f), role_name(a), role_name(b));
                return pick(s, 49, v![
                    format!("Allows {reply_san}, a {f} fork of your {a} and {b}."),
                    format!("Walks into {reply_san}, forking your {a} and {b}."),
                    format!("After {reply_san}, the {f} forks your {a} and {b}."),
                ]);
            }
            let (swing, _) = line_material_swing(ctx.after, ctx.reply_line, !mover, 8);
            if swing >= 2 && ctx.win_after < 45.0 {
                let what = piece_word_for_swing(swing);
                return pick(s, 50, v![
                    format!("Allows {reply_san}, and your opponent wins {what}."),
                    format!("After {reply_san}, your opponent wins {what}."),
                    format!("Runs into {reply_san}, which wins {what} for your opponent."),
                ]);
            }
        }
    }
    let wb = ctx.win_before;
    let wa = ctx.win_after;
    if wb >= 70.0 && wa < 60.0 {
        pick(s, 51, v!["Throws away most of your advantage.", "Most of your advantage is gone now.", "A big part of your edge slips away."])
    } else if wb >= 55.0 && wa < 50.0 {
        pick(s, 52, v!["Lets your opponent back into the game.", "Gives your opponent a way back.", "Your opponent is back in the game now."])
    } else if wb >= 45.0 && wa < 40.0 {
        pick(s, 53, v!["Gives your opponent the advantage.", "Hands the advantage to your opponent.", "Now your opponent is better."])
    } else if wa < 25.0 {
        pick(s, 54, v!["Makes a difficult position even worse.", "An already tough position gets worse.", "Digs the hole deeper."])
    } else if wb >= 60.0 {
        pick(s, 55, v!["Lets some of your advantage slip away.", "Gives back part of your advantage.", "Your edge shrinks."])
    } else if ctx.class == "inaccuracy" {
        pick(s, 56, v!["There was a more precise move.", "A more accurate move was available.", "Not the most precise choice here."])
    } else {
        pick(s, 57, v!["Weakens your position.", "Makes your position harder to play.", "Gives your opponent easier play."])
    }
}

pub fn eval_phrase(white_win: f64) -> &'static str {
    if white_win >= 90.0 {
        "White is winning"
    } else if white_win >= 70.0 {
        "White is much better"
    } else if white_win >= 57.0 {
        "White is slightly better"
    } else if white_win > 43.0 {
        "The position is equal"
    } else if white_win > 30.0 {
        "Black is slightly better"
    } else if white_win > 10.0 {
        "Black is much better"
    } else {
        "Black is winning"
    }
}
