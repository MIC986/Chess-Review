//! Tiny local HTTP bridge so the browser extension can open reviews instantly
//! (no "open this app?" prompt) while the app is running. Listens on 127.0.0.1 only.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const PORT: u16 = 47321;

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let Ok(listener) = TcpListener::bind(("127.0.0.1", PORT)) else { return };
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || handle(stream, app));
        }
    });
}

fn respond(mut s: TcpStream, status: &str, body: &str) {
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Private-Network: true\r\nAccess-Control-Allow-Methods: GET, OPTIONS\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = s.write_all(resp.as_bytes());
}

fn handle(mut s: TcpStream, app: AppHandle) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let mut buf = [0u8; 4096];
    let n = s.read(&mut buf).unwrap_or(0);
    let req = String::from_utf8_lossy(&buf[..n]);
    let line = req.lines().next().unwrap_or("");
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    if method == "OPTIONS" {
        return respond(s, "204 No Content", "");
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    match path {
        "/ping" => respond(s, "200 OK", r#"{"app":"chess-review","ok":true}"#),
        "/show" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            respond(s, "200 OK", r#"{"ok":true}"#)
        }
        "/open" => {
            // Only digits, letters, '-', '_', '=', '&' and '%' are passed on.
            let clean: String = query
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || "-_=&%.".contains(*c))
                .take(300)
                .collect();
            let _ = app.emit("deep-link", format!("chessreview://review?{clean}"));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            respond(s, "200 OK", r#"{"ok":true}"#)
        }
        _ => respond(s, "404 Not Found", r#"{"ok":false}"#),
    }
}
