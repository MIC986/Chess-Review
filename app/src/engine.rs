//! Minimal, robust UCI driver for Stockfish (or any UCI engine).

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Score from the point of view of the side to move (as UCI reports it).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Score {
    pub cp: Option<i32>,
    pub mate: Option<i32>,
}

impl Score {
    pub fn cp(v: i32) -> Self {
        Score { cp: Some(v), mate: None }
    }
    pub fn mate(v: i32) -> Self {
        Score { cp: None, mate: Some(v) }
    }
    pub fn negate(self) -> Self {
        Score { cp: self.cp.map(|c| -c), mate: self.mate.map(|m| -m) }
    }
    /// Centipawn-equivalent used for win probability.
    pub fn as_cp(self) -> f64 {
        if let Some(m) = self.mate {
            if m > 0 {
                10000.0 - m as f64
            } else if m < 0 {
                -10000.0 - m as f64
            } else {
                -10000.0
            }
        } else {
            self.cp.unwrap_or(0) as f64
        }
    }
    /// Winning chances in percent (0..100), lichess model.
    pub fn win_pct(self) -> f64 {
        let cp = self.as_cp().clamp(-4000.0, 4000.0);
        50.0 + 50.0 * (2.0 / (1.0 + (-0.00368208 * cp).exp()) - 1.0)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub multipv: u32,
    pub depth: u32,
    pub score: Score,
    pub pv: Vec<String>,
}

pub struct Engine {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<String>,
    pub name: String,
}

impl Engine {
    pub fn start(path: &Path, threads: u32, hash_mb: u32) -> Result<Engine, String> {
        let mut cmd = Command::new(path);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        if let Some(dir) = path.parent() {
            cmd.current_dir(dir);
        }
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = cmd.spawn().map_err(|e| format!("Could not start engine: {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if tx.send(l).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        let mut e = Engine { child, stdin, rx, name: String::from("Engine") };
        e.send("uci")?;
        let mut name = String::new();
        e.wait_for(|l| {
            if let Some(n) = l.strip_prefix("id name ") {
                name = n.trim().to_string();
            }
            l == "uciok"
        }, Duration::from_secs(15))?;
        if !name.is_empty() {
            e.name = name;
        }
        e.send(&format!("setoption name Threads value {}", threads.max(1)))?;
        e.send(&format!("setoption name Hash value {}", hash_mb.max(16)))?;
        e.ready()?;
        Ok(e)
    }

    pub fn send(&mut self, cmd: &str) -> Result<(), String> {
        writeln!(self.stdin, "{cmd}").map_err(|e| format!("engine write failed: {e}"))?;
        self.stdin.flush().map_err(|e| format!("engine flush failed: {e}"))
    }

    pub fn ready(&mut self) -> Result<(), String> {
        self.send("isready")?;
        self.wait_for(|l| l == "readyok", Duration::from_secs(30))
    }

    fn wait_for<F: FnMut(&str) -> bool>(&mut self, mut f: F, timeout: Duration) -> Result<(), String> {
        let start = std::time::Instant::now();
        loop {
            let left = timeout.checked_sub(start.elapsed()).ok_or("engine timed out")?;
            match self.rx.recv_timeout(left) {
                Ok(l) => {
                    if f(l.trim()) {
                        return Ok(());
                    }
                }
                Err(RecvTimeoutError::Timeout) => return Err("engine timed out".into()),
                Err(RecvTimeoutError::Disconnected) => return Err("engine stopped".into()),
            }
        }
    }

    pub fn new_game(&mut self) -> Result<(), String> {
        self.send("ucinewgame")?;
        self.ready()
    }

    /// Search a position to a fixed depth and return the principal variations.
    pub fn analyse(
        &mut self,
        fen: &str,
        depth: u32,
        multipv: u32,
        searchmoves: Option<&[String]>,
    ) -> Result<Vec<Line>, String> {
        self.send(&format!("setoption name MultiPV value {}", multipv.max(1)))?;
        self.send(&format!("position fen {fen}"))?;
        let mut go = format!("go depth {depth}");
        if let Some(sm) = searchmoves {
            if !sm.is_empty() {
                go.push_str(" searchmoves ");
                go.push_str(&sm.join(" "));
            }
        }
        self.send(&go)?;
        let mut lines: Vec<Option<Line>> = vec![None; multipv.max(1) as usize];
        loop {
            match self.rx.recv_timeout(Duration::from_secs(120)) {
                Ok(l) => {
                    let l = l.trim();
                    if l.starts_with("bestmove") {
                        break;
                    }
                    if let Some(line) = parse_info(l) {
                        let idx = (line.multipv.max(1) - 1) as usize;
                        if idx < lines.len() {
                            lines[idx] = Some(line);
                        }
                    }
                }
                Err(_) => return Err("engine did not answer".into()),
            }
        }
        Ok(lines.into_iter().flatten().filter(|l| !l.pv.is_empty()).collect())
    }

    /// Drain pending output (used by the live analyser).
    pub fn try_line(&self, timeout: Duration) -> Option<String> {
        self.rx.recv_timeout(timeout).ok()
    }

    pub fn stop_and_wait(&mut self) {
        let _ = self.send("stop");
        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            match self.rx.recv_timeout(Duration::from_millis(500)) {
                Ok(l) if l.starts_with("bestmove") => return,
                Ok(_) => {}
                Err(RecvTimeoutError::Timeout) => {}
                Err(_) => return,
            }
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = writeln!(self.stdin, "quit");
        let _ = self.stdin.flush();
        std::thread::sleep(Duration::from_millis(20));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn parse_info(l: &str) -> Option<Line> {
    if !l.starts_with("info ") || !l.contains(" pv ") || l.contains("currmove") {
        return None;
    }
    let toks: Vec<&str> = l.split_whitespace().collect();
    let mut depth = 0;
    let mut multipv = 1;
    let mut score = None;
    let mut pv = Vec::new();
    let mut i = 1;
    while i < toks.len() {
        match toks[i] {
            "depth" => {
                depth = toks.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(0);
                i += 2;
            }
            "multipv" => {
                multipv = toks.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(1);
                i += 2;
            }
            "score" => {
                let kind = toks.get(i + 1).copied().unwrap_or("");
                let v: i32 = toks.get(i + 2).and_then(|s| s.parse().ok()).unwrap_or(0);
                score = Some(if kind == "mate" { Score::mate(v) } else { Score::cp(v) });
                i += 3;
            }
            "pv" => {
                pv = toks[i + 1..].iter().map(|s| s.to_string()).collect();
                break;
            }
            _ => i += 1,
        }
    }
    Some(Line { multipv, depth, score: score?, pv })
}
