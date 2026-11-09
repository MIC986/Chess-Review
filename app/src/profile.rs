//! Profile Review: analyses many games quickly and boils each one down to a compact digest
//! (per-move accuracy, win chances, clocks and a label for every mistake) that the UI
//! aggregates into statistics and coaching advice.

use crate::analysis::{build_review, PosEval};
use crate::chess::*;
use crate::coach::{find_threat, line_material_swing, Threat};
use crate::engine::{Engine, Line};
use serde::Deserialize;
use serde_json::{json, Value};
use shakmaty::{Chess, Move, Position, Role};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// Bump when the digest format or the labels change, so old cache entries are rebuilt.
const DIGEST_VERSION: u64 = 2;

#[derive(Debug, Clone, Deserialize)]
pub struct ProfileGame {
    pub id: String,
    pub pgn: String,
}

pub type DigestFn = dyn Fn(usize, usize, Value) + Send + Sync;

fn cache_path(dir: &Path, id: &str) -> PathBuf {
    let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(60).collect();
    dir.join(format!("{safe}.json"))
}

fn read_cached(dir: &Path, id: &str, depth: u32) -> Option<Value> {
    let s = std::fs::read_to_string(cache_path(dir, id)).ok()?;
    let v: Value = serde_json::from_str(&s).ok()?;
    let ok = v.get("v").and_then(|x| x.as_u64()) == Some(DIGEST_VERSION)
        && v.get("depth").and_then(|x| x.as_u64()).unwrap_or(0) >= depth as u64;
    ok.then_some(v)
}

fn write_cached(dir: &Path, id: &str, v: &Value) {
    let _ = std::fs::create_dir_all(dir);
    let p = cache_path(dir, id);
    let tmp = p.with_extension("tmp");
    if std::fs::write(&tmp, v.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, &p);
    }
}

/// Analyse `games`, calling `on_digest(done, total, digest)` as each game finishes.
pub fn analyze_many(
    engine_path: &Path,
    cache_dir: &Path,
    games: Vec<ProfileGame>,
    depth: u32,
    workers: u32,
    cancel: Arc<AtomicBool>,
    on_digest: Arc<DigestFn>,
) -> Result<(), String> {
    let total = games.len();
    let done = Arc::new(AtomicUsize::new(0));
    let mut todo = VecDeque::new();
    for g in games {
        if let Some(d) = read_cached(cache_dir, &g.id, depth) {
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            on_digest(n, total, d);
        } else {
            todo.push_back(g);
        }
    }
    if todo.is_empty() {
        return Ok(());
    }
    let workers = workers.clamp(1, 32).min(todo.len() as u32);
    let queue = Arc::new(Mutex::new(todo));
    let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let mut handles = Vec::new();
    for _ in 0..workers {
        let queue = queue.clone();
        let error = error.clone();
        let cancel = cancel.clone();
        let done = done.clone();
        let on_digest = on_digest.clone();
        let path = engine_path.to_path_buf();
        let cache = cache_dir.to_path_buf();
        handles.push(std::thread::spawn(move || {
            let mut eng = match Engine::start(&path, 1, 32) {
                Ok(e) => e,
                Err(e) => {
                    *error.lock().unwrap() = Some(e);
                    return;
                }
            };
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                let next = queue.lock().unwrap().pop_front();
                let Some(g) = next else { return };
                match digest_game(&mut eng, &g, depth, &cancel) {
                    Ok(Some(d)) => {
                        write_cached(&cache, &g.id, &d);
                        let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                        on_digest(n, total, d);
                    }
                    Ok(None) => {
                        // Unreviewable game (no moves, odd start position): count it and move on.
                        let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                        on_digest(n, total, json!({ "id": g.id, "skip": true }));
                    }
                    Err(e) => {
                        if cancel.load(Ordering::Relaxed) {
                            return;
                        }
                        *error.lock().unwrap() = Some(e);
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
    if let Some(e) = error.lock().unwrap().take() {
        if done.load(Ordering::Relaxed) < total {
            return Err(e);
        }
    }
    Ok(())
}

fn digest_game(eng: &mut Engine, g: &ProfileGame, depth: u32, cancel: &AtomicBool) -> Result<Option<Value>, String> {
    let Ok(game) = parse_pgn(&g.pgn) else { return Ok(None) };
    if game.moves.len() < 2 {
        return Ok(None);
    }
    let mut positions: Vec<Chess> = vec![game.start.clone()];
    for pm in &game.moves {
        let mut p = positions.last().unwrap().clone();
        p.play_unchecked(pm.mv);
        positions.push(p);
    }
    eng.new_game()?;
    let mut evals: Vec<PosEval> = Vec::with_capacity(positions.len());
    for p in &positions {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let terminal = if p.is_checkmate() {
            Some("checkmate")
        } else if p.is_stalemate() {
            Some("stalemate")
        } else if p.is_insufficient_material() {
            Some("insufficient")
        } else {
            None
        };
        if let Some(t) = terminal {
            evals.push(PosEval { lines: vec![], terminal: Some(t.into()) });
        } else {
            let lines = eng.analyse(&fen_of(p), depth, 2, None)?;
            evals.push(PosEval { lines, terminal: None });
        }
    }
    let review = build_review(&game, &positions, &evals, format!("pr-{}", g.id), json!({}), depth, eng.name.clone());

    let mut moves = Vec::with_capacity(review.moves.len());
    for (i, m) in review.moves.iter().enumerate() {
        let ph = match m.phase.as_str() {
            "opening" => "o",
            "endgame" => "e",
            _ => "m",
        };
        let mut o = json!({
            "c": m.color,
            "k": m.classification,
            "a": (m.accuracy * 10.0).round() / 10.0,
            "wb": (m.win_before * 10.0).round() / 10.0,
            "wa": (m.win_after * 10.0).round() / 10.0,
            "ph": ph,
            "t": m.clock,
            "san": m.san,
        });
        let bad = matches!(m.classification.as_str(), "inaccuracy" | "mistake" | "blunder" | "miss");
        if bad {
            let (tag, role) = tag_move(
                &positions[i],
                &positions[i + 1],
                game.moves[i].mv,
                &m.classification,
                evals[i].lines.first(),
                evals[i + 1].lines.first(),
            );
            o["tag"] = json!(tag);
            o["role"] = json!(role.map(role_name));
            o["fen"] = json!(fen_of(&positions[i]));
            o["uci"] = json!(m.uci);
            o["best"] = json!(m.best_san);
            o["bu"] = json!(m.best_uci);
            o["reply"] = json!(m.reply_line.first());
        }
        if matches!(m.classification.as_str(), "brilliant" | "great") {
            o["fen"] = json!(fen_of(&positions[i]));
            o["uci"] = json!(m.uci);
        }
        moves.push(o);
    }
    let side = |s: &crate::analysis::SideStats| json!({ "acc": s.accuracy, "counts": s.counts, "acpl": (s.acpl * 10.0).round() / 10.0 });
    let wins: Vec<i64> = review.positions.iter().map(|p| p.win.round() as i64).collect();
    Ok(Some(json!({
        "id": g.id,
        "v": DIGEST_VERSION,
        "depth": depth,
        "opening": review.opening,
        "eco": review.eco,
        "result": review.result,
        "white": side(&review.white),
        "black": side(&review.black),
        "moves": moves,
        "w": wins,
    })))
}

/// Why was a move bad? Returns a short label and the piece involved.
fn tag_move(before: &Chess, after: &Chess, mv: Move, class: &str, best: Option<&Line>, reply: Option<&Line>) -> (&'static str, Option<Role>) {
    let mover = before.turn();
    if let Some(n) = reply.and_then(|l| l.score.mate) {
        if n > 0 {
            return ("mate_allowed", None);
        }
    }
    let best_mate = best.and_then(|l| l.score.mate).map_or(false, |n| n > 0);
    if best_mate && class != "inaccuracy" {
        return ("mate_missed", None);
    }
    if class == "miss" {
        if let Some(b) = best {
            let (swing, role) = line_material_swing(before, &b.pv, mover, 8);
            if swing >= 2 {
                return ("win_missed", role);
            }
        }
        return ("punish_missed", None);
    }
    let before_h = hanging_pieces(before.board(), mover);
    let after_h = hanging_pieces(after.board(), mover);
    for h in &after_h {
        let was = before_h.iter().find(|b| b.square == h.square);
        let newly = was.map_or(true, |b| h.gain > b.gain);
        let moved_here = h.square == mv.to();
        if (newly || moved_here) && h.gain >= 2 {
            return (if moved_here { "hung_moved" } else { "hung_left" }, Some(h.role));
        }
    }
    if let Some(h) = after_h.first() {
        if h.gain >= 2 && before_h.iter().any(|b| b.square == h.square) {
            return ("threat_ignored", Some(h.role));
        }
    }
    if let Some(r) = reply {
        if let Some(reply_mv) = r.pv.first().and_then(|u| parse_uci(after, u)) {
            let mut p = after.clone();
            p.play_unchecked(reply_mv);
            if let Some(Threat::Fork(f, _, _)) = find_threat(&p, reply_mv.to(), !mover) {
                return ("fork_allowed", Some(f));
            }
            let (swing, role) = line_material_swing(after, &r.pv, !mover, 8);
            if swing >= 2 {
                return ("tactic_allowed", role);
            }
        }
    }
    if after_h.iter().any(|h| h.role == Role::Pawn && h.gain >= 1) && class != "inaccuracy" {
        return ("pawn_dropped", Some(Role::Pawn));
    }
    ("positional", None)
}
