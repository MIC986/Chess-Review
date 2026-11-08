//! Chess helpers: PGN parsing, move conversion, static exchange evaluation.

use shakmaty::fen::{Epd, Fen};
use shakmaty::san::{San, SanPlus};
use shakmaty::uci::UciMove;
use shakmaty::{
    Bitboard, Board, CastlingMode, Chess, Color, EnPassantMode, Move, Position, Role, Square,
};

pub const START_FEN: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

#[derive(Debug, Clone)]
pub struct ParsedMove {
    pub mv: Move,
    pub san: String,
    pub uci: String,
    pub clock: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct ParsedGame {
    pub headers: Vec<(String, String)>,
    pub start: Chess,
    pub start_fen: String,
    pub moves: Vec<ParsedMove>,
}

impl ParsedGame {
    pub fn header(&self, key: &str) -> Option<String> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.clone())
    }
}

pub fn fen_of(pos: &Chess) -> String {
    Fen::from_position(pos, EnPassantMode::Legal).to_string()
}

pub fn epd_of(pos: &Chess) -> String {
    Epd::from_position(pos, EnPassantMode::Legal).to_string()
}

pub fn pos_from_fen(fen: &str) -> Result<Chess, String> {
    let f = Fen::from_ascii(fen.trim().as_bytes()).map_err(|e| format!("bad FEN: {e}"))?;
    f.into_position(CastlingMode::Standard).map_err(|e| format!("illegal FEN: {e}"))
}

pub fn uci_of(m: Move) -> String {
    m.to_uci(CastlingMode::Standard).to_string()
}

pub fn parse_uci(pos: &Chess, uci: &str) -> Option<Move> {
    let u = UciMove::from_ascii(uci.as_bytes()).ok()?;
    u.to_move(pos).ok()
}

pub fn san_of(pos: &Chess, m: Move) -> String {
    SanPlus::from_move(pos.clone(), m).to_string()
}

/// Squares a move visually goes from/to (castling -> king destination).
pub fn move_squares(m: Move) -> (String, String) {
    match m {
        Move::Castle { king, rook } => {
            let to_file = if rook.file() > king.file() { 'g' } else { 'c' };
            let rank = king.rank().char();
            (king.to_string(), format!("{to_file}{rank}"))
        }
        _ => (m.from().map(|s| s.to_string()).unwrap_or_default(), m.to().to_string()),
    }
}

/// Convert a UCI principal variation to SAN, stopping at the first illegal move.
pub fn pv_to_san(pos: &Chess, pv: &[String], max: usize) -> Vec<String> {
    let mut p = pos.clone();
    let mut out = Vec::new();
    for u in pv.iter().take(max) {
        match parse_uci(&p, u) {
            Some(m) => {
                out.push(san_of(&p, m));
                p.play_unchecked(m);
            }
            None => break,
        }
    }
    out
}

fn parse_clock(comment: &str) -> Option<f64> {
    let idx = comment.find("%clk")?;
    let rest = comment[idx + 4..].trim_start();
    let token: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == ':' || *c == '.').collect();
    let parts: Vec<&str> = token.split(':').collect();
    let mut secs = 0.0;
    for p in parts {
        secs = secs * 60.0 + p.parse::<f64>().ok()?;
    }
    Some(secs)
}

pub fn parse_pgn(pgn: &str) -> Result<ParsedGame, String> {
    let mut headers = Vec::new();
    let mut movetext = String::new();
    for line in pgn.lines() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') && movetext.trim().is_empty() {
            let inner = &t[1..t.len() - 1];
            if let Some(sp) = inner.find(' ') {
                let key = inner[..sp].to_string();
                let val = inner[sp + 1..].trim().trim_matches('"').replace("\\\"", "\"");
                headers.push((key, val));
            }
        } else {
            movetext.push_str(line);
            movetext.push('\n');
        }
    }

    let fen_header = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("FEN")).map(|(_, v)| v.clone());
    let start: Chess = match &fen_header {
        Some(f) if !f.is_empty() => pos_from_fen(f)?,
        _ => Chess::default(),
    };
    let start_fen = fen_of(&start);
    let mut pos = start.clone();
    let mut moves: Vec<ParsedMove> = Vec::new();

    let chars: Vec<char> = movetext.chars().collect();
    let mut i = 0;
    let mut depth = 0usize; // variation nesting
    while i < chars.len() {
        let c = chars[i];
        if c == '{' {
            let start_i = i;
            while i < chars.len() && chars[i] != '}' {
                i += 1;
            }
            let comment: String = chars[start_i..i.min(chars.len())].iter().collect();
            if depth == 0 {
                if let (Some(clk), Some(last)) = (parse_clock(&comment), moves.last_mut()) {
                    last.clock = Some(clk);
                }
            }
            i += 1;
            continue;
        }
        if c == ';' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '(' {
            depth += 1;
            i += 1;
            continue;
        }
        if c == ')' {
            depth = depth.saturating_sub(1);
            i += 1;
            continue;
        }
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        // read token
        let s = i;
        while i < chars.len() && !chars[i].is_whitespace() && !"{}();".contains(chars[i]) {
            i += 1;
        }
        if depth > 0 {
            continue;
        }
        let mut tok: String = chars[s..i].iter().collect();
        if tok.starts_with('$') {
            continue;
        }
        if matches!(tok.as_str(), "1-0" | "0-1" | "1/2-1/2" | "*") {
            break;
        }
        // strip move numbers like "12." or "12..." possibly glued: "12.e4"
        if let Some(pos_dot) = tok.rfind('.') {
            if tok[..pos_dot].chars().all(|ch| ch.is_ascii_digit() || ch == '.') {
                tok = tok[pos_dot + 1..].to_string();
            }
        }
        let tok = tok.trim_end_matches(['!', '?']).to_string();
        if tok.is_empty() || tok.chars().all(|ch| ch.is_ascii_digit()) {
            continue;
        }
        let tok = tok.replace('0', "O"); // 0-0 castling notation
        let san = SanPlus::from_ascii(tok.as_bytes())
            .map(|sp| sp.san)
            .or_else(|_| San::from_ascii(tok.as_bytes()))
            .map_err(|_| format!("Could not read move \"{tok}\" (move {})", moves.len() / 2 + 1))?;
        let mv = san
            .to_move(&pos)
            .map_err(|_| format!("Illegal move \"{tok}\" (move {})", moves.len() / 2 + 1))?;
        let san_str = san_of(&pos, mv);
        moves.push(ParsedMove { mv, san: san_str, uci: uci_of(mv), clock: None });
        pos.play_unchecked(mv);
    }

    Ok(ParsedGame { headers, start, start_fen, moves })
}

/// chess.com TCN move-list decoding (used as a fallback source of moves).
pub fn decode_tcn(tcn: &str, start: &Chess) -> Result<Vec<Move>, String> {
    const T: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?{~}(^)[_]@#$,./&-*++=";
    let tchars: Vec<char> = T.chars().collect();
    let idx = |c: char| tchars.iter().position(|&x| x == c);
    let chars: Vec<char> = tcn.chars().collect();
    let mut pos = start.clone();
    let mut out = Vec::new();
    for pair in chars.chunks(2) {
        if pair.len() < 2 {
            break;
        }
        let from = idx(pair[0]).ok_or("bad tcn")?;
        let mut to = idx(pair[1]).ok_or("bad tcn")?;
        let mut promo = None;
        if to > 63 {
            promo = "qnrbkp".chars().nth((to - 64) / 3);
            let dir: i32 = if from < 16 { -8 } else { 8 };
            to = (from as i32 + dir + ((to as i32 - 1) % 3) - 1) as usize;
        }
        let f = Square::new(from as u32);
        let t = Square::new(to as u32);
        let mut uci = format!("{f}{t}");
        if let Some(p) = promo {
            uci.push(p);
        }
        let m = parse_uci(&pos, &uci).ok_or_else(|| format!("illegal tcn move {uci}"))?;
        out.push(m);
        pos.play_unchecked(m);
    }
    Ok(out)
}

pub fn value(role: Role) -> i32 {
    match role {
        Role::Pawn => 1,
        Role::Knight => 3,
        Role::Bishop => 3,
        Role::Rook => 5,
        Role::Queen => 9,
        Role::King => 100,
    }
}

pub fn role_name(role: Role) -> &'static str {
    match role {
        Role::Pawn => "pawn",
        Role::Knight => "knight",
        Role::Bishop => "bishop",
        Role::Rook => "rook",
        Role::Queen => "queen",
        Role::King => "king",
    }
}

pub fn color_name(c: Color) -> &'static str {
    match c {
        Color::White => "White",
        Color::Black => "Black",
    }
}

/// Material in pawns for a side.
pub fn material(board: &Board, color: Color) -> i32 {
    let m = board.material_side(color);
    m.pawn as i32 + 3 * m.knight as i32 + 3 * m.bishop as i32 + 5 * m.rook as i32 + 9 * m.queen as i32
}

/// Non-pawn material (both sides).
pub fn non_pawn_material(board: &Board) -> i32 {
    let mut t = 0;
    for c in [Color::White, Color::Black] {
        let m = board.material_side(c);
        t += 3 * m.knight as i32 + 3 * m.bishop as i32 + 5 * m.rook as i32 + 9 * m.queen as i32;
    }
    t
}

fn least_valuable(board: &Board, attackers: Bitboard) -> Option<(Square, Role)> {
    for role in [Role::Pawn, Role::Knight, Role::Bishop, Role::Rook, Role::Queen, Role::King] {
        let bb = attackers & board.by_role(role);
        if let Some(sq) = bb.first() {
            return Some((sq, role));
        }
    }
    None
}

/// Static exchange evaluation: material `attacker` wins by starting a capture
/// sequence on `sq` (>= 0 means at least break-even; 0 if not attacked).
pub fn see(board: &Board, sq: Square, attacker: Color) -> i32 {
    let target = match board.role_at(sq) {
        Some(r) => r,
        None => return 0,
    };
    let mut occ = board.occupied();
    let mut gains: Vec<i32> = Vec::with_capacity(32);
    let mut side = attacker;
    let mut on_square_value = value(target);
    loop {
        let atk = board.attacks_to(sq, side, occ) & occ & board.by_color(side);
        let Some((from, role)) = least_valuable(board, atk) else { break };
        // King cannot capture into a defended square.
        if role == Role::King {
            let defenders = board.attacks_to(sq, !side, occ ^ Bitboard::from(from)) & occ & board.by_color(!side);
            if defenders.any() {
                break;
            }
        }
        let prev = gains.last().copied().unwrap_or(0);
        gains.push(on_square_value - prev);
        on_square_value = value(role);
        occ ^= Bitboard::from(from);
        side = !side;
        if gains.len() > 32 {
            break;
        }
    }
    if gains.is_empty() {
        return 0;
    }
    // negamax back-propagation (either side may stop capturing)
    for d in (1..gains.len()).rev() {
        gains[d - 1] = -((-gains[d - 1]).max(gains[d]));
    }
    gains[0].max(0)
}

#[derive(Debug, Clone)]
pub struct Hanging {
    pub square: Square,
    pub role: Role,
    pub gain: i32,
}

/// Pieces of `victim` that the other side can win material on.
pub fn hanging_pieces(board: &Board, victim: Color) -> Vec<Hanging> {
    let mut out = Vec::new();
    for sq in board.by_color(victim) {
        let role = board.role_at(sq).unwrap();
        if role == Role::King {
            continue;
        }
        let g = see(board, sq, !victim);
        if g > 0 {
            out.push(Hanging { square: sq, role, gain: g });
        }
    }
    out.sort_by(|a, b| b.gain.cmp(&a.gain));
    out
}

/// Pieces of `victim` attacked by the piece on `from`.
pub fn attacked_by(board: &Board, from: Square, victim: Color) -> Vec<(Square, Role)> {
    let mut v = Vec::new();
    for sq in board.attacks_from(from) & board.by_color(victim) {
        if let Some(r) = board.role_at(sq) {
            v.push((sq, r));
        }
    }
    v
}

pub fn legal_dests(pos: &Chess) -> Vec<(String, Vec<String>)> {
    let mut map: Vec<(String, Vec<String>)> = Vec::new();
    for m in pos.legal_moves() {
        let (f, t) = move_squares(m);
        // Also allow clicking the rook square for castling.
        let mut targets = vec![t];
        if let Move::Castle { rook, .. } = m {
            targets.push(rook.to_string());
        }
        match map.iter_mut().find(|(k, _)| *k == f) {
            Some((_, v)) => {
                for t in targets {
                    if !v.contains(&t) {
                        v.push(t);
                    }
                }
            }
            None => map.push((f, targets)),
        }
    }
    map
}
