//! Continuous engine analysis for free exploration on the board.

use crate::chess::{pos_from_fen, pv_to_san};
use crate::engine::{parse_info, Engine, Line};
use serde_json::json;
use shakmaty::{Color, Position};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub enum LiveCmd {
    Analyze { fen: String, multipv: u32, id: u64, max_depth: u32 },
    Stop,
}

pub fn spawn(app: AppHandle, path: PathBuf, threads: u32, hash: u32) -> Sender<LiveCmd> {
    let (tx, rx) = mpsc::channel::<LiveCmd>();
    std::thread::spawn(move || run(app, path, threads, hash, rx));
    tx
}

fn run(app: AppHandle, path: PathBuf, threads: u32, hash: u32, rx: Receiver<LiveCmd>) {
    let mut eng = match Engine::start(&path, threads, hash) {
        Ok(e) => e,
        Err(e) => {
            let _ = app.emit("live-error", e);
            return;
        }
    };
    let mut current: Option<(String, u32, u64)> = None;
    let mut lines: Vec<Option<Line>> = Vec::new();
    let mut last_emit = Instant::now();
    let mut searching = false;
    loop {
        // Commands
        let cmd = if searching {
            match rx.try_recv() {
                Ok(c) => Some(c),
                Err(TryRecvError::Empty) => None,
                Err(TryRecvError::Disconnected) => return,
            }
        } else {
            match rx.recv() {
                Ok(c) => Some(c),
                Err(_) => return,
            }
        };
        if let Some(cmd) = cmd {
            if searching {
                eng.stop_and_wait();
                searching = false;
            }
            match cmd {
                LiveCmd::Stop => {
                    current = None;
                    continue;
                }
                LiveCmd::Analyze { fen, multipv, id, max_depth } => {
                    let mp = multipv.clamp(1, 5);
                    let _ = eng.send(&format!("setoption name MultiPV value {mp}"));
                    let _ = eng.send(&format!("position fen {fen}"));
                    let go = if max_depth > 0 { format!("go depth {max_depth}") } else { "go infinite".to_string() };
                    let _ = eng.send(&go);
                    lines = vec![None; mp as usize];
                    current = Some((fen, mp, id));
                    searching = true;
                }
            }
        }
        if !searching {
            continue;
        }
        // Engine output
        let mut changed = false;
        let mut finished = false;
        while let Some(l) = eng.try_line(Duration::from_millis(30)) {
            if l.starts_with("bestmove") {
                finished = true;
                break;
            }
            if let Some(info) = parse_info(&l) {
                let idx = (info.multipv.max(1) - 1) as usize;
                if idx < lines.len() {
                    lines[idx] = Some(info);
                    changed = true;
                }
            }
            if last_emit.elapsed() > Duration::from_millis(200) {
                break;
            }
        }
        if (changed && last_emit.elapsed() > Duration::from_millis(180)) || finished {
            if let Some((fen, _, id)) = &current {
                if let Ok(pos) = pos_from_fen(fen) {
                    let turn = pos.turn();
                    let out: Vec<_> = lines
                        .iter()
                        .flatten()
                        .map(|l| {
                            let s = if turn == Color::White { l.score } else { l.score.negate() };
                            json!({
                                "eval": s,
                                "depth": l.depth,
                                "uci": l.pv.iter().take(14).collect::<Vec<_>>(),
                                "san": pv_to_san(&pos, &l.pv, 14),
                            })
                        })
                        .collect();
                    let depth = lines.iter().flatten().map(|l| l.depth).max().unwrap_or(0);
                    let _ = app.emit("live-info", json!({"id": id, "fen": fen, "depth": depth, "lines": out, "done": finished}));
                }
            }
            last_emit = Instant::now();
        }
        if finished {
            searching = false;
        }
    }
}
