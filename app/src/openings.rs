//! Opening book built from the lichess chess-openings dataset (CC0).

use crate::chess::epd_of;
use shakmaty::san::San;
use shakmaty::{Chess, Position};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

const DATA: [&str; 5] = [
    include_str!("../data/a.tsv"),
    include_str!("../data/b.tsv"),
    include_str!("../data/c.tsv"),
    include_str!("../data/d.tsv"),
    include_str!("../data/e.tsv"),
];

pub struct Book {
    pub named: HashMap<String, (String, String)>, // epd -> (eco, name)
    pub positions: HashSet<String>,
}

static BOOK: OnceLock<Book> = OnceLock::new();

pub fn book() -> &'static Book {
    BOOK.get_or_init(|| {
        let mut named = HashMap::new();
        let mut positions = HashSet::new();
        for file in DATA {
            for line in file.lines().skip(1) {
                let mut parts = line.split('\t');
                let (Some(eco), Some(name), Some(pgn)) = (parts.next(), parts.next(), parts.next()) else {
                    continue;
                };
                let mut pos = Chess::default();
                let mut ok = true;
                for tok in pgn.split_whitespace() {
                    if tok.ends_with('.') || tok.chars().next().map_or(false, |c| c.is_ascii_digit()) {
                        continue;
                    }
                    let Ok(san) = San::from_ascii(tok.trim_end_matches(['+', '#']).as_bytes()) else {
                        ok = false;
                        break;
                    };
                    let Ok(m) = san.to_move(&pos) else {
                        ok = false;
                        break;
                    };
                    pos.play_unchecked(m);
                    positions.insert(epd_of(&pos));
                }
                if ok {
                    named.insert(epd_of(&pos), (eco.to_string(), name.to_string()));
                }
            }
        }
        Book { named, positions }
    })
}

pub fn warm() {
    std::thread::spawn(|| {
        let _ = book();
    });
}
