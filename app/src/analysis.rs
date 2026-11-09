//! Full game review: engine pass, move classification, accuracy, coach text.

use crate::chess::*;
use crate::coach::{self, MoveCtx};
use crate::engine::{Engine, Line, Score};
use crate::openings::book;
use serde::{Deserialize, Serialize};
use shakmaty::{Chess, Color, Move, Position, Role, Square};
use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineOpts {
    pub depth: u32,
    pub threads: u32,
    pub hash: u32,
    pub instances: u32,
    pub multipv: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineOut {
    pub eval: Score, // white perspective
    pub uci: Vec<String>,
    pub san: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionOut {
    pub fen: String,
    pub eval: Score, // white perspective
    pub win: f64,    // white win %
    pub lines: Vec<LineOut>,
    pub terminal: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveOut {
    pub ply: usize,
    pub move_number: u32,
    pub color: String,
    pub san: String,
    pub uci: String,
    pub from: String,
    pub to: String,
    pub capture: bool,
    pub check: bool,
    pub castle: bool,
    pub promotion: bool,
    pub classification: String,
    pub epl: f64,
    pub accuracy: f64,
    pub win_before: f64,
    pub win_after: f64,
    pub best_san: Option<String>,
    pub best_uci: Option<String>,
    pub best_line: Vec<String>,
    pub reply_line: Vec<String>,
    pub title: String,
    pub text: String,
    pub best_text: Option<String>,
    pub clock: Option<f64>,
    pub opening: Option<String>,
    pub phase: String,
    pub retry: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SideStats {
    pub accuracy: f64,
    pub rating: i32,
    pub counts: BTreeMap<String, u32>,
    pub phases: BTreeMap<String, Option<String>>,
    pub acpl: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub key: String,
    pub headers: BTreeMap<String, String>,
    pub start_fen: String,
    pub result: String,
    pub opening: Option<String>,
    pub eco: Option<String>,
    pub positions: Vec<PositionOut>,
    pub moves: Vec<MoveOut>,
    pub white: SideStats,
    pub black: SideStats,
    pub key_moments: Vec<usize>,
    pub summary: String,
    pub engine: String,
    pub depth: u32,
    pub analyzed_at: u64,
    pub meta: serde_json::Value,
    /// Version of the coach wording; older saved reviews get their text rebuilt.
    #[serde(default)]
    pub coach_version: u32,
}

pub(crate) struct PosEval {
    pub(crate) lines: Vec<Line>, // side-to-move perspective
    pub(crate) terminal: Option<String>,
}

fn stm_score(pe: &PosEval) -> Score {
    match pe.terminal.as_deref() {
        Some("checkmate") => Score::mate(0),
        Some(_) => Score::cp(0),
        None => pe.lines.first().map(|l| l.score).unwrap_or(Score::cp(0)),
    }
}

fn to_white(s: Score, turn: Color) -> Score {
    if turn == Color::White {
        s
    } else {
        s.negate()
    }
}

pub fn move_accuracy(win_before: f64, win_after: f64) -> f64 {
    let diff = (win_before - win_after).max(0.0);
    let raw = 103.1668100711649 * (-0.04354415386753951 * diff).exp() - 3.166924740191411;
    (raw + 1.0).clamp(0.0, 100.0)
}

fn std_dev(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    let mean = xs.iter().sum::<f64>() / xs.len() as f64;
    (xs.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / xs.len() as f64).sqrt()
}

fn harmonic(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    let s: f64 = xs.iter().map(|x| 1.0 / x.max(1.0)).sum();
    xs.len() as f64 / s
}

pub fn rating_from_accuracy(acc: f64, n_moves: usize) -> i32 {
    const T: [(f64, f64); 13] = [
        (0.0, 100.0),
        (40.0, 250.0),
        (50.0, 450.0),
        (60.0, 750.0),
        (70.0, 1100.0),
        (75.0, 1300.0),
        (80.0, 1550.0),
        (85.0, 1850.0),
        (90.0, 2200.0),
        (93.0, 2450.0),
        (96.0, 2750.0),
        (98.0, 3000.0),
        (100.0, 3250.0),
    ];
    let mut r = T[T.len() - 1].1;
    for w in T.windows(2) {
        if acc <= w[1].0 {
            let t = (acc - w[0].0) / (w[1].0 - w[0].0);
            r = w[0].1 + t * (w[1].1 - w[0].1);
            break;
        }
    }
    // Very short games are less informative; pull toward the middle.
    if n_moves < 15 {
        let k = n_moves as f64 / 15.0;
        r = 1200.0 + (r - 1200.0) * k;
    }
    (r / 25.0).round() as i32 * 25
}

fn phase_label(avg: f64, all_book: bool) -> String {
    if all_book {
        return "book".into();
    }
    if avg >= 95.0 {
        "best"
    } else if avg >= 85.0 {
        "excellent"
    } else if avg >= 72.0 {
        "good"
    } else if avg >= 58.0 {
        "inaccuracy"
    } else if avg >= 42.0 {
        "mistake"
    } else {
        "blunder"
    }
    .into()
}

pub fn classify_epl(epl: f64, is_best: bool) -> &'static str {
    if is_best || epl < 0.002 {
        "best"
    } else if epl <= 0.02 {
        "excellent"
    } else if epl <= 0.05 {
        "good"
    } else if epl <= 0.10 {
        "inaccuracy"
    } else if epl <= 0.20 {
        "mistake"
    } else {
        "blunder"
    }
}

/// Is `m` (played from `before`) a real material sacrifice? Returns the piece offered.
///
/// Counts a piece moved to (or left on) a square where the opponent can legally take it and
/// come out at least two points ahead, including a piece that was already attacked and could
/// have been saved but was left en prise for something stronger.
fn is_sacrifice(before: &Chess, after: &Chess, m: Move, prev_pos: Option<&Chess>) -> Option<Role> {
    let mover = before.turn();
    if m.is_promotion() {
        return None;
    }
    let captured = m.capture().map(value).unwrap_or(0);
    let hp_before = hanging_pieces(before.board(), mover);
    let legal_captures: Vec<Square> = after.legal_moves().iter().filter(|x| x.is_capture()).map(|x| x.to()).collect();
    let mut best: Option<(Role, i32)> = None;
    for h in hanging_pieces(after.board(), mover) {
        if h.role == Role::Pawn || !legal_captures.contains(&h.square) {
            continue;
        }
        if h.gain - captured < 2 {
            continue;
        }
        let was = hp_before.iter().find(|b| b.square == h.square);
        let fresh = h.square == m.to() || was.map_or(true, |b| h.gain > b.gain);
        // Leaving a piece en prise only counts on the move right after it came under attack,
        // not again on every later move of an earlier sacrifice.
        let newly_attacked = prev_pos.map_or(true, |pp| !hanging_pieces(pp.board(), mover).iter().any(|x| x.square == h.square && x.role == h.role));
        let left_en_prise = !fresh && newly_attacked && could_save(before, h.square);
        if (fresh || left_en_prise) && best.map_or(true, |b| h.gain > b.1) {
            best = Some((h.role, h.gain));
        }
    }
    best.map(|b| b.0)
}

/// Could the piece on `sq` have moved to a square where it is not lost?
fn could_save(before: &Chess, sq: Square) -> bool {
    let mover = before.turn();
    before.legal_moves().iter().any(|mv| {
        if mv.from() != Some(sq) {
            return false;
        }
        let mut p = before.clone();
        p.play_unchecked(*mv);
        see(p.board(), mv.to(), !mover) == 0
    })
}

fn is_material_win_capture(before: &Chess, m: Move) -> bool {
    if let Some(cap) = m.capture() {
        let mut after = before.clone();
        after.play_unchecked(m);
        let back = see(after.board(), m.to(), !before.turn());
        return value(cap) - back >= 2 || (back == 0 && cap != Role::Pawn);
    }
    false
}

pub type ProgressFn = dyn Fn(usize, usize) + Send + Sync;

fn run_engines(
    engine_path: &Path,
    positions: &[Chess],
    opts: &EngineOpts,
    cancel: Arc<AtomicBool>,
    progress: Arc<ProgressFn>,
) -> Result<(Vec<PosEval>, String), String> {
    let n = positions.len();
    let mut results: Vec<Option<PosEval>> = (0..n).map(|_| None).collect();
    let mut queue = VecDeque::new();
    for (i, p) in positions.iter().enumerate() {
        if p.is_checkmate() {
            results[i] = Some(PosEval { lines: vec![], terminal: Some("checkmate".into()) });
        } else if p.is_stalemate() {
            results[i] = Some(PosEval { lines: vec![], terminal: Some("stalemate".into()) });
        } else if p.is_insufficient_material() {
            results[i] = Some(PosEval { lines: vec![], terminal: Some("insufficient".into()) });
        } else {
            queue.push_back(i);
        }
    }
    let total = queue.len();
    let done = Arc::new(AtomicUsize::new(0));
    let queue = Arc::new(Mutex::new(queue));
    let results = Arc::new(Mutex::new(results));
    let errors: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let name = Arc::new(Mutex::new(String::from("Stockfish")));
    let fens: Arc<Vec<String>> = Arc::new(positions.iter().map(fen_of).collect());
    let instances = opts.instances.clamp(1, 32).min(total.max(1) as u32);
    progress(0, total);

    let mut handles = Vec::new();
    for _ in 0..instances {
        let queue = queue.clone();
        let results = results.clone();
        let errors = errors.clone();
        let cancel = cancel.clone();
        let progress = progress.clone();
        let done = done.clone();
        let fens = fens.clone();
        let name = name.clone();
        let path = engine_path.to_path_buf();
        let o = opts.clone();
        handles.push(std::thread::spawn(move || {
            let mut eng = match Engine::start(&path, o.threads, o.hash) {
                Ok(e) => e,
                Err(e) => {
                    *errors.lock().unwrap() = Some(e);
                    return;
                }
            };
            *name.lock().unwrap() = eng.name.clone();
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                let next = queue.lock().unwrap().pop_front();
                let Some(i) = next else { return };
                match eng.analyse(&fens[i], o.depth, o.multipv.clamp(1, 5), None) {
                    Ok(lines) => {
                        results.lock().unwrap()[i] = Some(PosEval { lines, terminal: None });
                        let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                        progress(d, total);
                    }
                    Err(e) => {
                        *errors.lock().unwrap() = Some(e);
                        return;
                    }
                }
            }
        }));
    }
    for h in handles {
        let _ = h.join();
    }
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    if let Some(e) = errors.lock().unwrap().take() {
        if done.load(Ordering::Relaxed) < total {
            return Err(e);
        }
    }
    let res = Arc::try_unwrap(results).map_err(|_| "internal error")?.into_inner().unwrap();
    let mut out = Vec::with_capacity(n);
    for r in res {
        out.push(r.ok_or("analysis incomplete")?);
    }
    let engine_name = name.lock().unwrap().clone();
    Ok((out, engine_name))
}

pub fn review_game(
    engine_path: &Path,
    pgn: &str,
    key: String,
    meta: serde_json::Value,
    opts: &EngineOpts,
    cancel: Arc<AtomicBool>,
    progress: Arc<ProgressFn>,
) -> Result<Review, String> {
    let game = parse_pgn(pgn)?;
    if game.moves.is_empty() {
        return Err("This game has no moves to review.".into());
    }
    let mut positions: Vec<Chess> = vec![game.start.clone()];
    for pm in &game.moves {
        let mut p = positions.last().unwrap().clone();
        p.play_unchecked(pm.mv);
        positions.push(p);
    }
    let (evals, engine_name) = run_engines(engine_path, &positions, opts, cancel, progress)?;
    Ok(build_review(&game, &positions, &evals, key, meta, opts.depth, engine_name))
}

pub(crate) fn build_review(
    game: &ParsedGame,
    positions: &[Chess],
    evals: &[PosEval],
    key: String,
    meta: serde_json::Value,
    depth: u32,
    engine_name: String,
) -> Review {
    let n = game.moves.len();
    let bk = book();

    // ---- positions output
    let mut pos_out = Vec::with_capacity(positions.len());
    for (i, p) in positions.iter().enumerate() {
        let pe = &evals[i];
        let turn = p.turn();
        let white_eval = to_white(stm_score(pe), turn);
        let lines = pe
            .lines
            .iter()
            .map(|l| LineOut {
                eval: to_white(l.score, turn),
                uci: l.pv.iter().take(16).cloned().collect(),
                san: pv_to_san(p, &l.pv, 16),
            })
            .collect();
        pos_out.push(PositionOut {
            fen: fen_of(p),
            eval: white_eval,
            win: white_eval.win_pct(),
            lines,
            terminal: pe.terminal.clone(),
        });
    }

    // ---- book detection + opening name
    let mut book_end = 0usize; // number of plies in book
    let mut opening: Option<(String, String)> = None;
    for i in 0..n.min(40) {
        let epd = epd_of(&positions[i + 1]);
        if let Some(named) = bk.named.get(&epd) {
            opening = Some(named.clone());
        }
        if book_end == i && bk.positions.contains(&epd) && game.start_fen == START_FEN {
            book_end = i + 1;
        }
    }
    if game.start_fen != START_FEN {
        opening = None;
    }
    let mut opening_at: Vec<Option<String>> = vec![None; n];
    {
        let mut cur: Option<String> = None;
        for i in 0..n.min(40) {
            if let Some((_, name)) = bk.named.get(&epd_of(&positions[i + 1])) {
                cur = Some(name.clone());
            }
            if i < book_end {
                opening_at[i] = cur.clone();
            }
        }
    }

    // ---- per move classification
    let mut moves: Vec<MoveOut> = Vec::with_capacity(n);
    let mut epls: Vec<f64> = Vec::with_capacity(n);
    let mut win_befores: Vec<f64> = Vec::with_capacity(n);
    let opening_end = book_end.max(20).min(30);

    for i in 0..n {
        let pm = &game.moves[i];
        let before = &positions[i];
        let after = &positions[i + 1];
        let mover = before.turn();
        let pe = &evals[i];
        let pe_after = &evals[i + 1];

        let best_line = pe.lines.first();
        let best_uci = best_line.and_then(|l| l.pv.first().cloned());
        let best_score = best_line.map(|l| l.score).unwrap_or(Score::cp(0));
        let best_w = best_score.win_pct();
        let played_is_best = best_uci.as_deref() == Some(pm.uci.as_str());

        let after_stm = stm_score(pe_after); // opponent perspective
        let mut played_score = after_stm.negate();
        if after.is_checkmate() {
            played_score = Score::mate(1);
        }
        if let Some(l) = pe.lines.iter().find(|l| l.pv.first() == Some(&pm.uci)) {
            played_score = l.score;
        }
        let mut played_w = played_score.win_pct();
        if played_is_best {
            played_w = best_w;
            played_score = best_score;
        }
        let epl = ((best_w - played_w) / 100.0).max(0.0);

        let legal_count = before.legal_moves().len();
        let in_book = i < book_end;
        let mut class: String = if legal_count == 1 {
            "forced".into()
        } else if in_book {
            "book".into()
        } else {
            classify_epl(epl, played_is_best).into()
        };

        let prev_move = if i > 0 { Some(game.moves[i - 1].mv) } else { None };

        if class == "best" || class == "excellent" {
            // Strongest alternative to the move actually played (never the played move itself).
            let alt_w = pe
                .lines
                .iter()
                .filter(|l| l.pv.first() != Some(&pm.uci))
                .map(|l| l.score.win_pct())
                .fold(None, |a: Option<f64>, w| Some(a.map_or(w, |a| a.max(w))));
            let mating = played_score.mate.map_or(false, |n| n > 0);
            // Brilliant: a sound sacrifice. Mating sacrifices always count; otherwise the
            // position must not be completely winning anyway without it.
            let winning_anyway = !mating && alt_w.map_or(false, |w| w >= 97.0);
            if epl <= 0.02 && played_w >= 45.0 && !winning_anyway && is_sacrifice(before, after, pm.mv, if i > 0 { Some(&positions[i - 1]) } else { None }).is_some() {
                class = "brilliant".into();
            } else if let Some(alt) = alt_w {
                // Great: the only good move, finding it changes the outcome.
                let gap = played_w - alt;
                let recapture = prev_move.map_or(false, |p| p.is_capture() && p.to() == pm.mv.to() && pm.mv.is_capture());
                let escaping = pm.mv.from().map_or(false, |f| {
                    hanging_pieces(before.board(), mover).iter().any(|h| h.square == f && value(h.role) >= 3)
                });
                let obvious = is_material_win_capture(before, pm.mv) || recapture || after.is_checkmate() || escaping;
                let only_move = (played_is_best || epl <= 0.005) && gap >= 12.0;
                if only_move && played_w >= 30.0 && !obvious {
                    class = "great".into();
                }
            }
        }

        if class == "mistake" || class == "blunder" {
            // Miss: failing to punish the opponent's error, or missing a mate.
            let mut miss = false;
            if i > 0 {
                let prev_epl = epls[i - 1];
                let opp_before_err = 100.0 - win_befores[i - 1]; // mover's chances before opponent erred
                if prev_epl >= 0.10 && played_w >= opp_before_err - 5.0 && best_w - opp_before_err >= 10.0 {
                    miss = true;
                }
            }
            if best_score.mate.map_or(false, |m| m > 0) && played_w >= 50.0 {
                miss = true;
            }
            if miss {
                class = "miss".into();
            }
        }

        let acc = if in_book || class == "forced" { 100.0 } else { move_accuracy(best_w, played_w) };
        epls.push(epl);
        win_befores.push(best_w);

        let best_move = best_uci.as_deref().and_then(|u| parse_uci(before, u));
        let best_san = best_move.map(|m| san_of(before, m));
        let best_line_uci: Vec<String> = best_line.map(|l| l.pv.clone()).unwrap_or_default();
        let reply_uci: Vec<String> = pe_after.lines.first().map(|l| l.pv.clone()).unwrap_or_default();

        let phase = if i < opening_end && non_pawn_material(before.board()) > 40 {
            "opening"
        } else if non_pawn_material(before.board()) <= 26
            || (before.board().queens().is_empty() && non_pawn_material(before.board()) <= 32)
        {
            "endgame"
        } else {
            "middlegame"
        };

        let ctx = MoveCtx {
            ply: i,
            before,
            after,
            mv: pm.mv,
            san: &pm.san,
            class: &class,
            prev_move,
            best_move,
            best_san: best_san.as_deref(),
            best_line: &best_line_uci,
            reply_line: &reply_uci,
            best_score,
            played_score,
            win_before: best_w,
            win_after: played_w,
            opening: opening_at[i].as_deref(),
        };
        let ex = coach::explain(&ctx);
        let (from, to) = move_squares(pm.mv);
        let retry = matches!(class.as_str(), "inaccuracy" | "mistake" | "blunder" | "miss") && best_move.is_some();

        moves.push(MoveOut {
            ply: i + 1,
            move_number: before.fullmoves().get(),
            color: if mover == Color::White { "w".into() } else { "b".into() },
            san: pm.san.clone(),
            uci: pm.uci.clone(),
            from,
            to,
            capture: pm.mv.is_capture(),
            check: after.is_check(),
            castle: pm.mv.is_castle(),
            promotion: pm.mv.is_promotion(),
            classification: class.clone(),
            epl,
            accuracy: acc,
            win_before: best_w,
            win_after: played_w,
            best_san: if played_is_best { None } else { best_san.clone() },
            best_uci: if played_is_best { None } else { best_uci.clone() },
            best_line: pv_to_san(before, &best_line_uci, 12),
            reply_line: pv_to_san(after, &reply_uci, 12),
            title: ex.title,
            text: ex.text,
            best_text: ex.best_text,
            clock: pm.clock,
            opening: opening_at[i].clone(),
            phase: phase.into(),
            retry,
        });
    }

    // ---- accuracy (lichess-style volatility weighted + harmonic mean)
    let wins: Vec<f64> = pos_out.iter().map(|p| p.win).collect();
    let window = (n / 10).clamp(2, 8);
    let mut windows: Vec<Vec<f64>> = Vec::new();
    for _ in 0..window.min(wins.len()).saturating_sub(2) {
        windows.push(wins[..window.min(wins.len())].to_vec());
    }
    for w in wins.windows(window.min(wins.len()).max(1)) {
        windows.push(w.to_vec());
    }
    let weights: Vec<f64> = windows.iter().map(|w| std_dev(w).clamp(0.5, 12.0)).collect();

    let mut white = SideStats::default();
    let mut black = SideStats::default();
    for (side, stats) in [(Color::White, &mut white), (Color::Black, &mut black)] {
        let c = if side == Color::White { "w" } else { "b" };
        let idx: Vec<usize> = (0..n).filter(|&i| moves[i].color == c).collect();
        let accs: Vec<f64> = idx.iter().map(|&i| moves[i].accuracy).collect();
        let (mut ws, mut wsum) = (0.0, 0.0);
        for &i in &idx {
            let w = weights.get(i).copied().unwrap_or(1.0);
            ws += moves[i].accuracy * w;
            wsum += w;
        }
        let weighted = if wsum > 0.0 { ws / wsum } else { 0.0 };
        let acc = if accs.is_empty() { 0.0 } else { (weighted + harmonic(&accs)) / 2.0 };
        stats.accuracy = (acc * 10.0).round() / 10.0;
        stats.rating = rating_from_accuracy(stats.accuracy, idx.len());
        for k in [
            "brilliant", "great", "best", "excellent", "good", "book", "inaccuracy", "mistake", "miss", "blunder",
        ] {
            stats.counts.insert(k.into(), 0);
        }
        let mut cpl = 0.0;
        for &i in &idx {
            *stats.counts.entry(moves[i].classification.clone()).or_insert(0) += 1;
            cpl += moves[i].epl * 100.0;
        }
        stats.acpl = if idx.is_empty() { 0.0 } else { cpl / idx.len() as f64 };
        for ph in ["opening", "middlegame", "endgame"] {
            let pm: Vec<&MoveOut> = idx.iter().map(|&i| &moves[i]).filter(|m| m.phase == ph).collect();
            if pm.is_empty() {
                stats.phases.insert(ph.into(), None);
            } else {
                let all_book = pm.iter().all(|m| m.classification == "book");
                let avg = pm.iter().map(|m| m.accuracy).sum::<f64>() / pm.len() as f64;
                stats.phases.insert(ph.into(), Some(phase_label(avg, all_book)));
            }
        }
    }

    // ---- key moments
    let key_moments: Vec<usize> = moves
        .iter()
        .filter(|m| matches!(m.classification.as_str(), "brilliant" | "great" | "miss" | "mistake" | "blunder"))
        .map(|m| m.ply)
        .collect();

    let headers: BTreeMap<String, String> = game.headers.iter().cloned().collect();
    let result = game.header("Result").unwrap_or_else(|| "*".into());
    let summary = make_summary(&headers, &result, &white, &black, &moves, positions.last().unwrap());

    Review {
        key,
        headers,
        start_fen: game.start_fen.clone(),
        result,
        opening: opening.as_ref().map(|o| o.1.clone()),
        eco: opening.as_ref().map(|o| o.0.clone()).or_else(|| game.header("ECO")),
        positions: pos_out,
        moves,
        white,
        black,
        key_moments,
        summary,
        engine: engine_name,
        depth,
        analyzed_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        meta,
        coach_version: COACH_VERSION,
    }
}

pub const COACH_VERSION: u32 = 3;

/// Rebuild classifications and coach text of a saved review from its stored engine lines.
pub fn rebuild_text(old: Review) -> Result<Review, String> {
    let start = pos_from_fen(&old.start_fen)?;
    let mut positions = vec![start.clone()];
    let mut moves = Vec::with_capacity(old.moves.len());
    for m in &old.moves {
        let p = positions.last().unwrap();
        let mv = parse_uci(p, &m.uci).ok_or("bad move in saved review")?;
        let mut next = p.clone();
        next.play_unchecked(mv);
        moves.push(ParsedMove { mv, san: m.san.clone(), uci: m.uci.clone(), clock: m.clock });
        positions.push(next);
    }
    if old.positions.len() != positions.len() {
        return Err("saved review does not match its moves".into());
    }
    let evals: Vec<PosEval> = old
        .positions
        .iter()
        .zip(&positions)
        .map(|(po, p)| PosEval {
            lines: po
                .lines
                .iter()
                .enumerate()
                .map(|(k, l)| Line {
                    multipv: k as u32 + 1,
                    depth: old.depth,
                    score: if p.turn() == Color::White { l.eval } else { l.eval.negate() },
                    pv: l.uci.clone(),
                })
                .collect(),
            terminal: po.terminal.clone(),
        })
        .collect();
    let game = ParsedGame { headers: old.headers.clone().into_iter().collect(), start, start_fen: old.start_fen.clone(), moves };
    let mut r = build_review(&game, &positions, &evals, old.key, old.meta, old.depth, old.engine);
    r.analyzed_at = old.analyzed_at;
    Ok(r)
}

fn make_summary(
    headers: &BTreeMap<String, String>,
    result: &str,
    white: &SideStats,
    black: &SideStats,
    moves: &[MoveOut],
    last: &Chess,
) -> String {
    let wn = headers.get("White").cloned().unwrap_or_else(|| "White".into());
    let bn = headers.get("Black").cloned().unwrap_or_else(|| "Black".into());
    let blunders = |c: &str| moves.iter().filter(|m| m.color == c && m.classification == "blunder").count();
    let brill = |c: &str| moves.iter().filter(|m| m.color == c && m.classification == "brilliant").count();
    let mut s = String::new();
    let (winner, loser, wst, lst, lc) = match result {
        "1-0" => (Some(&wn), Some(&bn), white, black, "b"),
        "0-1" => (Some(&bn), Some(&wn), black, white, "w"),
        _ => (None, None, white, black, ""),
    };
    if let (Some(w), Some(l)) = (winner, loser) {
        let lb = blunders(lc);
        if last.is_checkmate() {
            s.push_str(&format!("{w} delivered checkmate"));
        } else {
            s.push_str(&format!("{w} won the game"));
        }
        s.push_str(&format!(" with {:.0}% accuracy. ", wst.accuracy));
        if lb >= 2 {
            s.push_str(&format!("{lb} blunders cost {l} the game."));
        } else if lb == 1 {
            s.push_str(&format!("One blunder turned the game against {l}."));
        } else if lst.accuracy >= 85.0 {
            s.push_str(&format!("{l} played well too, with {:.0}% accuracy.", lst.accuracy));
        } else {
            s.push_str(&format!("{l} slowly lost control of the position."));
        }
    } else if result == "1/2-1/2" {
        if white.accuracy >= 85.0 && black.accuracy >= 85.0 {
            s.push_str("A well-balanced game from both sides that ended in a draw.");
        } else {
            s.push_str("The game ended in a draw after chances for both sides.");
        }
    } else {
        s.push_str("Let's look at the key moments of this game.");
    }
    let total_brill = brill("w") + brill("b");
    if total_brill > 0 {
        s.push_str(&format!(" There {} {} brilliant move{} to find!", if total_brill == 1 { "is" } else { "are" }, total_brill, if total_brill == 1 { "" } else { "s" }));
    }
    s
}

/// Score a single move in a position (used by Retry).
pub fn evaluate_attempt(
    engine_path: &Path,
    fen: &str,
    uci: &str,
    depth: u32,
) -> Result<serde_json::Value, String> {
    let pos = pos_from_fen(fen)?;
    let m = parse_uci(&pos, uci).ok_or("Illegal move")?;
    let san = san_of(&pos, m);
    let mut after = pos.clone();
    after.play_unchecked(m);
    let mut eng = Engine::start(engine_path, 2, 64)?;
    let lines = eng.analyse(fen, depth, 1, None)?;
    let best = lines.first().ok_or("no engine output")?;
    let best_w = best.score.win_pct();
    let is_best = best.pv.first().map(|b| b == uci).unwrap_or(false);
    let played = if after.is_checkmate() {
        Score::mate(1)
    } else if is_best {
        best.score
    } else {
        let l = eng.analyse(fen, depth, 1, Some(&[uci.to_string()]))?;
        l.first().map(|l| l.score).unwrap_or(Score::cp(0))
    };
    let played_w = if is_best { best_w } else { played.win_pct() };
    let epl = ((best_w - played_w) / 100.0).max(0.0);
    let class = classify_epl(epl, is_best);
    let best_san = best.pv.first().and_then(|u| parse_uci(&pos, u)).map(|bm| san_of(&pos, bm));
    Ok(serde_json::json!({
        "san": san,
        "uci": uci,
        "classification": class,
        "epl": epl,
        "bestSan": best_san,
        "bestUci": best.pv.first(),
        "fen": fen_of(&after),
        "winBefore": best_w,
        "winAfter": played_w,
    }))
}
