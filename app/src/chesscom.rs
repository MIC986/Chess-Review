//! chess.com public API client.

use crate::chess::{decode_tcn, pos_from_fen, san_of};
use serde_json::{json, Value};
use shakmaty::{Chess, Position};

const UA: &str = "ChessReviewDesktop/1.0 (personal game review tool)";

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(UA)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .expect("http client")
}

async fn get_json(url: &str) -> Result<Value, String> {
    let resp = client().get(url).send().await.map_err(|e| format!("Network error: {e}"))?;
    let status = resp.status();
    if status.as_u16() == 404 {
        return Err("not found".into());
    }
    if !status.is_success() {
        return Err(format!("chess.com returned {status}"));
    }
    resp.json::<Value>().await.map_err(|e| format!("Bad response: {e}"))
}

fn last_segment(url: &str) -> String {
    url.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string()
}

pub async fn profile(username: &str) -> Result<Value, String> {
    let u = username.trim().to_lowercase();
    if u.is_empty() {
        return Err("Enter a username".into());
    }
    let p = get_json(&format!("https://api.chess.com/pub/player/{u}"))
        .await
        .map_err(|e| if e == "not found" { format!("No chess.com player named \"{username}\"") } else { e })?;
    let stats = get_json(&format!("https://api.chess.com/pub/player/{u}/stats")).await.unwrap_or(json!({}));
    let rating = |k: &str| stats.get(k).and_then(|s| s.get("last")).and_then(|l| l.get("rating")).cloned();
    Ok(json!({
        "username": p.get("username").and_then(|v| v.as_str()).unwrap_or(&u),
        "name": p.get("name"),
        "avatar": p.get("avatar"),
        "title": p.get("title"),
        "country": p.get("country").and_then(|c| c.as_str()).map(last_segment),
        "joined": p.get("joined"),
        "followers": p.get("followers"),
        "url": p.get("url"),
        "ratings": {
            "rapid": rating("chess_rapid"),
            "blitz": rating("chess_blitz"),
            "bullet": rating("chess_bullet"),
            "daily": rating("chess_daily"),
        }
    }))
}

pub async fn archives(username: &str) -> Result<Vec<String>, String> {
    let u = username.trim().to_lowercase();
    let v = get_json(&format!("https://api.chess.com/pub/player/{u}/games/archives")).await?;
    let mut out: Vec<String> = v
        .get("archives")
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .filter_map(|s| {
                    let parts: Vec<&str> = s.trim_end_matches('/').rsplit('/').take(2).collect();
                    if parts.len() == 2 {
                        Some(format!("{}/{}", parts[1], parts[0]))
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    out.reverse();
    Ok(out)
}

fn slug_to_name(url: &str) -> Option<String> {
    let slug = last_segment(url);
    if slug.is_empty() {
        return None;
    }
    // Cut the move sequence part ("...3.Nf3")
    let base = slug.split("...").next().unwrap_or(&slug);
    let base = base.split(|c: char| c.is_ascii_digit()).next().unwrap_or(base);
    let name = base.trim_end_matches('-').replace('-', " ");
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

fn count_moves(pgn: &str) -> u32 {
    // Count full moves by the highest move number in the movetext.
    let body = pgn.split("\n\n").nth(1).unwrap_or(pgn);
    let mut best = 0;
    for tok in body.split_whitespace() {
        if let Some(n) = tok.strip_suffix('.') {
            if let Ok(v) = n.parse::<u32>() {
                best = best.max(v);
            }
        }
    }
    best
}

pub fn summarize_game(g: &Value) -> Value {
    let url = g.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let id = last_segment(url);
    let kind = if url.contains("/daily/") { "daily" } else { "live" };
    let pgn = g.get("pgn").and_then(|v| v.as_str()).unwrap_or("");
    let side = |k: &str| {
        let s = g.get(k).cloned().unwrap_or(json!({}));
        json!({
            "username": s.get("username"),
            "rating": s.get("rating"),
            "result": s.get("result"),
        })
    };
    json!({
        "id": id,
        "kind": kind,
        "url": url,
        "pgn": pgn,
        "timeClass": g.get("time_class"),
        "timeControl": g.get("time_control"),
        "endTime": g.get("end_time"),
        "rated": g.get("rated"),
        "rules": g.get("rules"),
        "white": side("white"),
        "black": side("black"),
        "accuracies": g.get("accuracies"),
        "opening": g.get("eco").and_then(|v| v.as_str()).and_then(slug_to_name),
        "moves": count_moves(pgn),
    })
}

pub async fn month(username: &str, ym: &str) -> Result<Vec<Value>, String> {
    let u = username.trim().to_lowercase();
    let v = get_json(&format!("https://api.chess.com/pub/player/{u}/games/{ym}")).await?;
    let mut games: Vec<Value> = v
        .get("games")
        .and_then(|a| a.as_array())
        .map(|a| a.iter().map(summarize_game).collect())
        .unwrap_or_default();
    games.reverse(); // newest first
    Ok(games)
}

async fn find_in_month(user: &str, ym: &str, id: &str) -> Option<Value> {
    let games = month(user, ym).await.ok()?;
    games.into_iter().find(|g| g.get("id").and_then(|v| v.as_str()) == Some(id))
}

fn shift_month(ym: &str, delta: i32) -> String {
    let mut parts = ym.split('/');
    let y: i32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(2024);
    let m: i32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(1);
    let total = y * 12 + (m - 1) + delta;
    format!("{}/{:02}", total.div_euclid(12), total.rem_euclid(12) + 1)
}

/// Resolve a chess.com game (live/daily + id) to a full game summary with PGN.
pub async fn resolve_game(kind: &str, id: &str, hint_user: Option<String>) -> Result<Value, String> {
    let kind = if kind == "daily" { "daily" } else { "live" };
    let id: String = id.chars().filter(|c| c.is_ascii_digit()).collect();
    if id.is_empty() {
        return Err("Invalid game id".into());
    }
    let mut kind = kind;
    let mut cb = get_json(&format!("https://www.chess.com/callback/{kind}/game/{id}")).await.ok();
    if cb.is_none() {
        // Links like /game/123 don't say live or daily; try the other kind too.
        let alt = if kind == "live" { "daily" } else { "live" };
        if let Ok(v) = get_json(&format!("https://www.chess.com/callback/{alt}/game/{id}")).await {
            cb = Some(v);
            kind = alt;
        }
    }
    let game = cb.as_ref().and_then(|c| c.get("game"));
    let headers = game.and_then(|g| g.get("pgnHeaders"));
    let mut users: Vec<String> = Vec::new();
    let mut ym: Option<String> = None;
    if let Some(h) = headers {
        for k in ["White", "Black"] {
            if let Some(u) = h.get(k).and_then(|v| v.as_str()) {
                users.push(u.to_string());
            }
        }
        if let Some(d) = h.get("Date").and_then(|v| v.as_str()) {
            let p: Vec<&str> = d.split('.').collect();
            if p.len() >= 2 {
                ym = Some(format!("{}/{}", p[0], p[1]));
            }
        }
    }
    if let Some(h) = hint_user.filter(|s| !s.is_empty()) {
        if !users.iter().any(|u| u.eq_ignore_ascii_case(&h)) {
            users.push(h);
        }
    }
    // Look through the archives (current month, plus neighbours for games that ended later).
    for u in &users {
        let months: Vec<String> = match &ym {
            Some(m) => vec![m.clone(), shift_month(m, 1)],
            None => archives(u).await.unwrap_or_default().into_iter().take(3).collect(),
        };
        for m in months {
            if let Some(g) = find_in_month(u, &m, &id).await {
                return Ok(g);
            }
        }
    }
    // Fallback: rebuild the PGN from the callback move list.
    if let (Some(g), Some(h)) = (game, headers) {
        if let Some(tcn) = g.get("moveList").and_then(|v| v.as_str()) {
            let start: Chess = h
                .get("FEN")
                .and_then(|v| v.as_str())
                .and_then(|f| pos_from_fen(f).ok())
                .unwrap_or_default();
            let mvs = decode_tcn(tcn, &start)?;
            let mut pgn = String::new();
            for (k, v) in h.as_object().into_iter().flatten() {
                let val = match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                pgn.push_str(&format!("[{k} \"{val}\"]\n"));
            }
            pgn.push('\n');
            let mut p = start.clone();
            for (i, m) in mvs.iter().enumerate() {
                if p.turn().is_white() {
                    pgn.push_str(&format!("{}. ", p.fullmoves()));
                } else if i == 0 {
                    pgn.push_str(&format!("{}... ", p.fullmoves()));
                }
                pgn.push_str(&san_of(&p, *m));
                pgn.push(' ');
                p.play_unchecked(*m);
            }
            pgn.push_str(h.get("Result").and_then(|v| v.as_str()).unwrap_or("*"));
            let elo = |k: &str| h.get(k).cloned().unwrap_or(Value::Null);
            return Ok(json!({
                "id": id,
                "kind": kind,
                "url": format!("https://www.chess.com/game/{kind}/{id}"),
                "pgn": pgn,
                "timeControl": h.get("TimeControl"),
                "white": {"username": h.get("White"), "rating": elo("WhiteElo")},
                "black": {"username": h.get("Black"), "rating": elo("BlackElo")},
                "moves": mvs.len().div_ceil(2),
            }));
        }
    }
    Err("Could not find this game on chess.com. Make sure the game is finished.".into())
}
