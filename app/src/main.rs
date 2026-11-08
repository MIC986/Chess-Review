#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod analysis;
mod bridge;
mod chess;
mod chesscom;
mod coach;
mod engine;
mod kokoro;
mod live;
mod openings;
mod setup;

use base64::Engine as _;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

pub const SCHEME: &str = "chessreview";

struct AppState {
    data: PathBuf,
    pending_link: Mutex<Option<String>>,
    cancel: Mutex<Arc<AtomicBool>>,
    live: Mutex<Option<(Sender<live::LiveCmd>, String)>>,
}

fn engine_path(state: &AppState, custom: &Option<String>) -> PathBuf {
    if let Some(c) = custom.as_ref().filter(|c| !c.trim().is_empty()) {
        let p = PathBuf::from(c.trim());
        if p.exists() {
            return p;
        }
    }
    setup::default_engine_path(&state.data)
}

fn safe_key(key: &str) -> String {
    key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).take(120).collect()
}

// ------------------------------------------------------------ engine

#[tauri::command]
fn engine_status(state: State<AppState>, custom: Option<String>) -> Value {
    let p = engine_path(&state, &custom);
    json!({ "installed": p.exists(), "path": p.to_string_lossy(), "cores": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) })
}

#[tauri::command]
async fn install_engine(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let data = state.data.clone();
    let p = setup::install_stockfish(&data, |got, total| {
        let _ = app.emit("install-progress", json!({"what": "engine", "got": got, "total": total}));
    })
    .await?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
fn analyze_game(
    app: AppHandle,
    state: State<AppState>,
    pgn: String,
    key: String,
    meta: Value,
    opts: Value,
    custom_engine: Option<String>,
) -> Result<(), String> {
    let opts: analysis::EngineOpts = serde_json::from_value(opts).map_err(|e| format!("bad options: {e}"))?;
    let path = engine_path(&state, &custom_engine);
    if !path.exists() {
        return Err("engine-missing".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut c = state.cancel.lock().unwrap();
        c.store(true, std::sync::atomic::Ordering::Relaxed);
        *c = cancel.clone();
    }
    let data = state.data.clone();
    std::thread::spawn(move || {
        let app2 = app.clone();
        let key2 = key.clone();
        let progress: Arc<analysis::ProgressFn> = Arc::new(move |done, total| {
            let _ = app2.emit("analysis-progress", json!({"key": key2, "done": done, "total": total}));
        });
        match analysis::review_game(&path, &pgn, key.clone(), meta, &opts, cancel, progress) {
            Ok(review) => {
                let _ = save_review(&data, &review);
                let _ = app.emit("analysis-done", json!({"key": key, "review": review}));
            }
            Err(e) => {
                let _ = app.emit("analysis-error", json!({"key": key, "error": e}));
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn cancel_analysis(state: State<AppState>) {
    state.cancel.lock().unwrap().store(true, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
async fn evaluate_attempt(
    state: State<'_, AppState>,
    fen: String,
    uci: String,
    depth: u32,
    custom_engine: Option<String>,
) -> Result<Value, String> {
    let path = engine_path(&state, &custom_engine);
    tauri::async_runtime::spawn_blocking(move || analysis::evaluate_attempt(&path, &fen, &uci, depth.clamp(8, 22)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn live_analyze(
    app: AppHandle,
    state: State<AppState>,
    fen: String,
    multipv: u32,
    id: u64,
    threads: u32,
    hash: u32,
    max_depth: u32,
    custom_engine: Option<String>,
) -> Result<(), String> {
    let path = engine_path(&state, &custom_engine);
    if !path.exists() {
        return Err("engine-missing".into());
    }
    let sig = format!("{}|{threads}|{hash}", path.to_string_lossy());
    let mut guard = state.live.lock().unwrap();
    let need_new = guard.as_ref().map_or(true, |(_, s)| *s != sig);
    if need_new {
        *guard = Some((live::spawn(app, path, threads, hash), sig));
    }
    let (tx, _) = guard.as_ref().unwrap();
    if tx.send(live::LiveCmd::Analyze { fen: fen.clone(), multipv, id, max_depth }).is_err() {
        *guard = None;
        return Err("live engine stopped".into());
    }
    Ok(())
}

#[tauri::command]
fn live_stop(state: State<AppState>) {
    if let Some((tx, _)) = state.live.lock().unwrap().as_ref() {
        let _ = tx.send(live::LiveCmd::Stop);
    }
}

// ------------------------------------------------------------ chess helpers

#[tauri::command]
fn legal_moves(fen: String) -> Result<Value, String> {
    let pos = chess::pos_from_fen(&fen)?;
    let dests: serde_json::Map<String, Value> =
        chess::legal_dests(&pos).into_iter().map(|(k, v)| (k, json!(v))).collect();
    Ok(Value::Object(dests))
}

#[tauri::command]
fn play_move(fen: String, from: String, to: String, promotion: Option<String>) -> Result<Value, String> {
    use shakmaty::Position;
    let pos = chess::pos_from_fen(&fen)?;
    let promo = promotion.unwrap_or_default();
    let found = pos.legal_moves().into_iter().find(|m| {
        let (f, t) = chess::move_squares(*m);
        let rook_sq = if let shakmaty::Move::Castle { rook, .. } = m { Some(rook.to_string()) } else { None };
        f == from
            && (t == to || rook_sq.as_deref() == Some(to.as_str()))
            && match m.promotion() {
                Some(r) => promo.is_empty() && r == shakmaty::Role::Queen || r.char().to_string() == promo,
                None => true,
            }
    });
    let m = found.ok_or("Illegal move")?;
    let san = chess::san_of(&pos, m);
    let mut after = pos.clone();
    after.play_unchecked(m);
    let (f, t) = chess::move_squares(m);
    Ok(json!({
        "fen": chess::fen_of(&after),
        "san": san,
        "uci": chess::uci_of(m),
        "from": f,
        "to": t,
        "capture": m.is_capture(),
        "castle": m.is_castle(),
        "promotion": m.is_promotion(),
        "check": after.is_check(),
        "mate": after.is_checkmate(),
    }))
}

#[tauri::command]
fn needs_promotion(fen: String, from: String, to: String) -> bool {
    use shakmaty::Position;
    let Ok(pos) = chess::pos_from_fen(&fen) else { return false };
    pos.legal_moves().into_iter().any(|m| {
        let (f, t) = chess::move_squares(m);
        f == from && t == to && m.is_promotion()
    })
}

#[tauri::command]
fn game_moves(pgn: String) -> Result<Value, String> {
    use shakmaty::Position;
    let g = chess::parse_pgn(&pgn)?;
    let mut pos = g.start.clone();
    let mut out = Vec::new();
    for pm in &g.moves {
        let (f, t) = chess::move_squares(pm.mv);
        let white = pos.turn().is_white();
        let num = pos.fullmoves().get();
        pos.play_unchecked(pm.mv);
        out.push(json!({
            "san": pm.san, "uci": pm.uci, "from": f, "to": t, "fen": chess::fen_of(&pos),
            "clock": pm.clock, "capture": pm.mv.is_capture(), "check": pos.is_check(),
            "castle": pm.mv.is_castle(), "promotion": pm.mv.is_promotion(), "mate": pos.is_checkmate(),
            "color": if white { "w" } else { "b" }, "moveNumber": num,
        }));
    }
    Ok(json!({
        "startFen": g.start_fen,
        "headers": g.headers.iter().cloned().collect::<std::collections::BTreeMap<_,_>>(),
        "moves": out,
    }))
}

#[tauri::command]
fn parse_pgn_info(pgn: String) -> Result<Value, String> {
    let g = chess::parse_pgn(&pgn)?;
    Ok(json!({
        "headers": g.headers.iter().cloned().collect::<std::collections::BTreeMap<_,_>>(),
        "moves": g.moves.len(),
    }))
}

// ------------------------------------------------------------ chess.com

#[tauri::command]
async fn cc_profile(username: String) -> Result<Value, String> {
    chesscom::profile(&username).await
}

#[tauri::command]
async fn cc_archives(username: String) -> Result<Vec<String>, String> {
    chesscom::archives(&username).await
}

#[tauri::command]
async fn cc_month(username: String, month: String) -> Result<Vec<Value>, String> {
    chesscom::month(&username, &month).await
}

#[tauri::command]
async fn cc_resolve(kind: String, id: String, user: Option<String>) -> Result<Value, String> {
    chesscom::resolve_game(&kind, &id, user).await
}

// ------------------------------------------------------------ storage

fn read_json(p: &Path) -> Option<Value> {
    std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok())
}

fn write_json(p: &Path, v: &Value) -> Result<(), String> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, p).map_err(|e| e.to_string())
}

fn save_review(data: &Path, review: &analysis::Review) -> Result<(), String> {
    let v = serde_json::to_value(review).map_err(|e| e.to_string())?;
    write_json(&data.join("reviews").join(format!("{}.json", safe_key(&review.key))), &v)?;
    let hist_path = data.join("history.json");
    let mut hist: Vec<Value> = read_json(&hist_path).and_then(|v| v.as_array().cloned()).unwrap_or_default();
    hist.retain(|h| h.get("key").and_then(|k| k.as_str()) != Some(review.key.as_str()));
    let h = &review.headers;
    hist.insert(
        0,
        json!({
            "key": review.key,
            "white": h.get("White"),
            "black": h.get("Black"),
            "whiteElo": h.get("WhiteElo"),
            "blackElo": h.get("BlackElo"),
            "result": review.result,
            "date": h.get("Date").or(h.get("UTCDate")),
            "opening": review.opening,
            "moves": review.moves.len().div_ceil(2),
            "accuracy": {"white": review.white.accuracy, "black": review.black.accuracy},
            "analyzedAt": review.analyzed_at,
            "meta": review.meta,
        }),
    );
    hist.truncate(200);
    write_json(&hist_path, &Value::Array(hist))
}

#[tauri::command]
fn load_review(state: State<AppState>, key: String) -> Option<Value> {
    read_json(&state.data.join("reviews").join(format!("{}.json", safe_key(&key))))
}

#[tauri::command]
fn history_list(state: State<AppState>) -> Value {
    read_json(&state.data.join("history.json")).unwrap_or(json!([]))
}

#[tauri::command]
fn history_remove(state: State<AppState>, key: String) -> Result<(), String> {
    let hist_path = state.data.join("history.json");
    let mut hist: Vec<Value> = read_json(&hist_path).and_then(|v| v.as_array().cloned()).unwrap_or_default();
    hist.retain(|h| h.get("key").and_then(|k| k.as_str()) != Some(key.as_str()));
    let _ = std::fs::remove_file(state.data.join("reviews").join(format!("{}.json", safe_key(&key))));
    write_json(&hist_path, &Value::Array(hist))
}

#[tauri::command]
fn history_clear(state: State<AppState>) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(state.data.join("reviews"));
    write_json(&state.data.join("history.json"), &json!([]))
}

#[tauri::command]
fn settings_load(state: State<AppState>) -> Value {
    read_json(&state.data.join("settings.json")).unwrap_or(json!({}))
}

#[tauri::command]
fn settings_save(state: State<AppState>, settings: Value) -> Result<(), String> {
    write_json(&state.data.join("settings.json"), &settings)
}

// ------------------------------------------------------------ voice

#[tauri::command]
fn voice_list(state: State<AppState>) -> Value {
    let installed_engine = setup::piper_exe(&state.data).exists();
    let voices: Vec<Value> = setup::VOICES
        .iter()
        .map(|v| {
            json!({
                "id": v.id,
                "label": v.label,
                "installed": installed_engine && setup::voice_model(&state.data, v.id).exists(),
            })
        })
        .collect();
    json!(voices)
}

#[tauri::command]
async fn voice_install(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let data = state.data.clone();
    setup::install_voice(&data, &id, |what, got, total| {
        let _ = app.emit("install-progress", json!({"what": "voice", "label": what, "got": got, "total": total}));
    })
    .await
}

#[tauri::command]
async fn voice_speak(state: State<'_, AppState>, id: String, text: String, rate: f64) -> Result<String, String> {
    let data = state.data.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || setup::speak(&data, &id, &text, rate))
        .await
        .map_err(|e| e.to_string())??;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
fn kokoro_status(state: State<AppState>) -> Value {
    let voices: Vec<Value> = kokoro::VOICES.iter().map(|(id, _, label)| json!({"id": id, "label": label})).collect();
    json!({ "installed": kokoro::installed(&state.data), "voices": voices })
}

#[tauri::command]
async fn kokoro_install(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let data = state.data.clone();
    kokoro::install(&data, |what, got, total| {
        let _ = app.emit("install-progress", json!({"what": "kokoro", "label": what, "got": got, "total": total}));
    })
    .await?;
    kokoro::warm(data);
    Ok(())
}

#[tauri::command]
fn kokoro_warm(state: State<AppState>) {
    kokoro::warm(state.data.clone());
}

#[tauri::command]
async fn kokoro_speak(state: State<'_, AppState>, voice: String, text: String, speed: f64) -> Result<String, String> {
    let data = state.data.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || kokoro::speak(&data, &voice, &text, speed as f32))
        .await
        .map_err(|e| e.to_string())??;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

// ------------------------------------------------------------ system

#[tauri::command]
fn take_pending_link(state: State<AppState>) -> Option<String> {
    state.pending_link.lock().unwrap().take()
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only web links can be opened".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn protocol_register() -> Result<String, String> {
    register_protocol()
}

#[cfg(windows)]
fn register_protocol() -> Result<String, String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_s = exe.to_string_lossy().to_string();
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(format!("Software\\Classes\\{SCHEME}"))
        .map_err(|e| e.to_string())?;
    key.set_value("", &"URL:Chess Review").map_err(|e| e.to_string())?;
    key.set_value("URL Protocol", &"").map_err(|e| e.to_string())?;
    let (icon, _) = key.create_subkey("DefaultIcon").map_err(|e| e.to_string())?;
    icon.set_value("", &format!("\"{exe_s}\",0")).map_err(|e| e.to_string())?;
    let (cmd, _) = key.create_subkey("shell\\open\\command").map_err(|e| e.to_string())?;
    cmd.set_value("", &format!("\"{exe_s}\" \"%1\"")).map_err(|e| e.to_string())?;
    Ok(exe_s)
}

#[cfg(not(windows))]
fn register_protocol() -> Result<String, String> {
    Err("Protocol registration is only implemented on Windows".into())
}

fn find_link(args: &[String]) -> Option<String> {
    args.iter().find(|a| a.to_lowercase().starts_with(&format!("{SCHEME}:"))).cloned()
}

/// Developer mode: `chess-review --cli-review <engine> <pgn-file> [depth]`
fn cli_review(args: &[String]) {
    let engine = PathBuf::from(&args[2]);
    let pgn = std::fs::read_to_string(&args[3]).expect("pgn file");
    let depth = args.get(4).and_then(|d| d.parse().ok()).unwrap_or(16);
    let opts = analysis::EngineOpts { depth, threads: 1, hash: 64, instances: 8, multipv: 2 };
    let t = std::time::Instant::now();
    let r = analysis::review_game(
        &engine,
        &pgn,
        "cli".into(),
        json!({}),
        &opts,
        Arc::new(AtomicBool::new(false)),
        Arc::new(|_, _| {}),
    )
    .expect("review");
    println!("time {:.1}s  engine {}", t.elapsed().as_secs_f64(), r.engine);
    println!("opening {:?}", r.opening);
    println!("white acc {} rating {} {:?}", r.white.accuracy, r.white.rating, r.white.counts);
    println!("black acc {} rating {} {:?}", r.black.accuracy, r.black.rating, r.black.counts);
    println!("phases w {:?} b {:?}", r.white.phases, r.black.phases);
    println!("summary: {}", r.summary);
    for m in &r.moves {
        println!(
            "{:>3}{} {:<8} {:<10} epl {:.3} acc {:>5.1} | {} | {} {}",
            m.move_number,
            if m.color == "w" { "." } else { "…" },
            m.san,
            m.classification,
            m.epl,
            m.accuracy,
            m.title,
            m.text,
            m.best_text.clone().unwrap_or_default()
        );
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 4 && args[1] == "--cli-review" {
        cli_review(&args);
        return;
    }
    openings::warm();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(link) = find_link(&args) {
                let _ = app.emit("deep-link", link);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            let data = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("chess-review"));
            let _ = std::fs::create_dir_all(&data);
            let args: Vec<String> = std::env::args().collect();
            app.manage(AppState {
                data,
                pending_link: Mutex::new(find_link(&args)),
                cancel: Mutex::new(Arc::new(AtomicBool::new(false))),
                live: Mutex::new(None),
            });
            let _ = register_protocol();
            bridge::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_status,
            install_engine,
            analyze_game,
            cancel_analysis,
            evaluate_attempt,
            live_analyze,
            live_stop,
            legal_moves,
            play_move,
            needs_promotion,
            parse_pgn_info,
            game_moves,
            cc_profile,
            cc_archives,
            cc_month,
            cc_resolve,
            load_review,
            history_list,
            history_remove,
            history_clear,
            settings_load,
            settings_save,
            voice_list,
            voice_install,
            voice_speak,
            kokoro_status,
            kokoro_install,
            kokoro_warm,
            kokoro_speak,
            take_pending_link,
            open_url,
            protocol_register,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Chess Review");
}
