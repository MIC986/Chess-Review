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
fn line_material_swing(pos: &Chess, line: &[String], side: Color, plies: usize) -> (i32, Option<Role>) {
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

fn piece_word_for_swing(delta: i32) -> &'static str {
    match delta.abs() {
        0 | 1 => "a pawn",
        2 => "material",
        3 | 4 => "a piece",
        5 | 6 => "the exchange or more",
        7 | 8 => "a lot of material",
        _ => "the queen",
    }
}

enum Threat {
    Fork(Role, Role, Role),
    Attack(Role, Square),
}

fn find_threat(after: &Chess, to: Square, mover: Color) -> Option<Threat> {
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

fn fork_text(subject: &str, f: Role, a: Role, b: Role) -> String {
    let _ = f;
    format!("{subject} forks the {} and the {}.", role_name(a), role_name(b))
}

/// What does a good move accomplish?
pub fn describe_good(before: &Chess, m: Move, rest_line: &[String], score: Score, ply: usize, prev: Option<Move>) -> String {
    let mover = before.turn();
    let mut after = before.clone();
    after.play_unchecked(m);
    if after.is_checkmate() {
        return "Checkmate!".into();
    }
    if let Some(n) = score.mate {
        if n > 0 {
            return if n == 1 {
                "This forces checkmate next move.".into()
            } else {
                format!("This leads to a forced checkmate in {n}.")
            };
        }
    }
    let (_, to) = move_squares(m);
    let to_sq: Square = to.parse().unwrap_or(m.to());
    if let Some(p) = m.promotion() {
        return format!("This promotes the pawn to {} {}.", article(role_name(p)), role_name(p));
    }
    if let Some(cap) = m.capture() {
        let prev_cap = prev.filter(|p| p.to() == m.to()).and_then(|p| p.capture());
        let lost_back = see(after.board(), m.to(), !mover);
        let net = value(cap) - lost_back;
        if m.is_en_passant() {
            return "This captures the pawn en passant.".into();
        }
        if let Some(pc) = prev_cap {
            if value(cap) <= value(pc) + 1 || net <= 1 {
                return format!("This recaptures the {}.", role_name(cap));
            }
        }
        if net >= 2 || (cap != Role::Pawn && lost_back == 0) {
            return format!("This wins {} {}.", article(role_name(cap)), role_name(cap));
        }
        if net == 1 && cap == Role::Pawn {
            return "This wins a pawn.".into();
        }
        if cap == Role::Pawn {
            return "This trades pawns.".into();
        }
        if net <= 0 && value(cap) >= 3 {
            return format!("This trades off the {}.", role_name(cap));
        }
    }
    let w = score.win_pct();
    if after.is_check() {
        if let Some(Threat::Fork(f, a, b)) = find_threat(&after, to_sq, mover) {
            return fork_text(&format!("This {}", role_name(f)), f, a, b);
        }
        let (swing, _) = line_material_swing(&after, rest_line, mover, 6);
        if swing >= 2 && w >= 60.0 {
            return format!("This check wins {}.", piece_word_for_swing(swing));
        }
        return "This puts the king in check.".into();
    }
    if m.is_castle() {
        return "Castling gets the king to safety and connects the rooks.".into();
    }
    // Saving a piece that was under attack
    let hanging_before = hanging_pieces(before.board(), mover);
    if let Some(from) = m.from() {
        if hanging_before.iter().any(|h| h.square == from) {
            return format!("This moves the {} out of danger.", role_name(m.role()));
        }
    }
    if !hanging_before.is_empty() {
        let hanging_after = hanging_pieces(after.board(), mover);
        if hanging_after.len() < hanging_before.len() {
            let h = &hanging_before[0];
            return format!("This protects the {} on {}.", role_name(h.role), h.square);
        }
    }
    match find_threat(&after, to_sq, mover) {
        Some(Threat::Fork(f, a, b)) => return fork_text(&format!("This {}", role_name(f)), f, a, b),
        Some(Threat::Attack(r, sq)) => return format!("This attacks the {} on {}.", role_name(r), sq),
        None => {}
    }
    let (swing, _) = line_material_swing(&after, rest_line, mover, 8);
    if swing >= 2 && w >= 60.0 {
        return format!("This wins {} by force.", piece_word_for_swing(swing));
    }
    let role = m.role();
    if ply < 24 && (role == Role::Knight || role == Role::Bishop) {
        if let Some(from) = m.from() {
            let back = if mover == Color::White { 0 } else { 7 };
            if from.rank().to_u32() == back {
                return format!("This develops the {} toward the center.", role_name(role));
            }
        }
    }
    if ply < 20 && role == Role::Pawn {
        let f = m.to().file().char();
        if f == 'd' || f == 'e' || f == 'c' {
            return "This fights for control of the center.".into();
        }
    }
    if role == Role::Pawn && non_pawn_material(after.board()) <= 26 {
        return "This pushes the pawn closer to promotion.".into();
    }
    if ply < 30 && role == Role::Rook {
        return "This brings the rook to a more active square.".into();
    }
    if w >= 80.0 {
        "This keeps a winning position.".into()
    } else if w >= 60.0 {
        "This keeps your advantage.".into()
    } else if w >= 40.0 {
        "This keeps the position balanced.".into()
    } else {
        "This is the toughest defense in a difficult position.".into()
    }
}

pub fn explain(ctx: &MoveCtx) -> Explanation {
    let mover = ctx.before.turn();
    let title = title_for(ctx.san, ctx.class);
    let rest_best: Vec<String> = ctx.best_line.iter().skip(1).cloned().collect();
    let best_desc = ctx.best_move.map(|bm| {
        let d = describe_good(ctx.before, bm, &rest_best, ctx.best_score, ctx.ply, ctx.prev_move);
        d
    });

    if ctx.after.is_checkmate() {
        return Explanation {
            title,
            text: format!("Checkmate! {} wins the game.", color_name(mover)),
            best_text: None,
        };
    }

    match ctx.class {
        "forced" => Explanation { title, text: "This was the only legal move.".into(), best_text: None },
        "book" => {
            let text = match ctx.opening {
                Some(name) => format!("{name}. This is a well-known opening move."),
                None => "This is a well-known opening move.".into(),
            };
            Explanation { title, text, best_text: None }
        }
        "brilliant" => {
            let after_board = ctx.after.board();
            let hp = hanging_pieces(after_board, mover);
            let piece = hp.first().map(|h| role_name(h.role)).unwrap_or("material");
            let follow = describe_good(ctx.before, ctx.mv, ctx.best_line.get(1..).unwrap_or(&[]), ctx.played_score, ctx.ply, ctx.prev_move);
            let text = if follow.contains("checkmate") {
                format!("A brilliant sacrifice! Giving up the {piece} leads to a winning attack. {follow}")
            } else {
                format!("A brilliant sacrifice! Giving up the {piece} is the strongest move in the position.")
            };
            Explanation { title, text, best_text: None }
        }
        "great" => {
            let d = describe_good(ctx.before, ctx.mv, ctx.best_line.get(1..).unwrap_or(&[]), ctx.played_score, ctx.ply, ctx.prev_move);
            Explanation {
                title,
                text: format!("Great find! This was the only good move. {d}"),
                best_text: None,
            }
        }
        "best" | "excellent" | "good" => {
            let line: Vec<String> = ctx.reply_line.to_vec();
            let d = describe_good(ctx.before, ctx.mv, &line, ctx.played_score, ctx.ply, ctx.prev_move);
            let best_text = if ctx.class != "best" {
                ctx.best_san.map(|b| match &best_desc {
                    Some(desc) => format!("{b} was best. {desc}"),
                    None => format!("{b} was best."),
                })
            } else {
                None
            };
            Explanation { title, text: d, best_text }
        }
        _ => {
            // inaccuracy / mistake / blunder / miss
            let text = describe_bad(ctx);
            let best_text = ctx.best_san.map(|b| match &best_desc {
                Some(desc) => format!("{b} was best. {desc}"),
                None => format!("{b} was best."),
            });
            Explanation { title, text, best_text }
        }
    }
}

fn describe_bad(ctx: &MoveCtx) -> String {
    let mover = ctx.before.turn();
    if ctx.class == "miss" {
        if let Some(n) = ctx.best_score.mate {
            if n > 0 {
                return format!("You missed a forced checkmate in {n}.");
            }
        }
        let (swing, role) = line_material_swing(ctx.before, ctx.best_line, mover, 8);
        if swing >= 2 && ctx.win_before >= 60.0 {
            let what = match role {
                Some(r) if r != Role::Pawn => format!("the {}", role_name(r)),
                _ => piece_word_for_swing(swing).to_string(),
            };
            return format!("You missed a chance to win {what}.");
        }
        return "You missed a chance to take advantage of your opponent's mistake.".into();
    }
    if let Some(n) = ctx.played_score.mate {
        if n < 0 {
            let n = -n;
            return if n <= 1 {
                "This allows checkmate in one.".into()
            } else {
                format!("This allows a forced checkmate in {n}.")
            };
        }
    }
    if let Some(n) = ctx.best_score.mate {
        if n > 0 && ctx.played_score.mate.map_or(true, |m| m <= 0) {
            return format!("This misses a forced checkmate in {n}.");
        }
    }
    // Newly hanging pieces
    let before_h = hanging_pieces(ctx.before.board(), mover);
    let after_h = hanging_pieces(ctx.after.board(), mover);
    for h in &after_h {
        let was = before_h.iter().find(|b| b.square == h.square);
        let newly = was.map_or(true, |b| h.gain > b.gain);
        let moved_here = h.square == ctx.mv.to();
        if (newly || moved_here) && h.gain >= 1 {
            if moved_here {
                return format!(
                    "This hangs your {}. It can be captured on {}.",
                    role_name(h.role),
                    h.square
                );
            }
            return format!("This leaves your {} on {} undefended.", role_name(h.role), h.square);
        }
    }
    if let Some(h) = after_h.first() {
        if h.gain >= 2 {
            return format!("Your {} on {} is still under attack.", role_name(h.role), h.square);
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
                return format!("This allows {reply_san}, a {} fork of your {} and {}.", role_name(f), role_name(a), role_name(b));
            }
            let (swing, _) = line_material_swing(ctx.after, ctx.reply_line, !mover, 8);
            if swing >= 2 && ctx.win_after < 45.0 {
                return format!(
                    "This allows {reply_san}, and your opponent wins {}.",
                    piece_word_for_swing(swing)
                );
            }
        }
    }
    let wb = ctx.win_before;
    let wa = ctx.win_after;
    if wb >= 70.0 && wa < 60.0 {
        "This throws away most of your advantage.".into()
    } else if wb >= 55.0 && wa < 50.0 {
        "This lets your opponent back into the game.".into()
    } else if wb >= 45.0 && wa < 40.0 {
        "This gives your opponent the advantage.".into()
    } else if wa < 25.0 {
        "This makes a difficult position even worse.".into()
    } else if wb >= 60.0 {
        "This lets some of your advantage slip away.".into()
    } else if ctx.class == "inaccuracy" {
        "There was a more precise move in this position.".into()
    } else {
        "This weakens your position.".into()
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
