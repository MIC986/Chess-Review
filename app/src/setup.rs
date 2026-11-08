//! Downloading and installing the engine and neural voices.

use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};

const UA: &str = "ChessReviewDesktop/1.0";

pub async fn download(url: &str, dest: &Path, mut progress: impl FnMut(u64, Option<u64>)) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent(UA)
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client.get(url).send().await.map_err(|e| format!("Download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed ({})", resp.status()));
    }
    let total = resp.content_length();
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = dest.with_extension("part");
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut got: u64 = 0;
    let mut last_report = 0u64;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Download interrupted: {e}"))? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        if got - last_report > 256 * 1024 {
            last_report = got;
            progress(got, total);
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    progress(got, total);
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn engine_dir(data: &Path) -> PathBuf {
    data.join("engine")
}

pub fn default_engine_path(data: &Path) -> PathBuf {
    engine_dir(data).join(if cfg!(windows) { "stockfish.exe" } else { "stockfish" })
}

async fn stockfish_url() -> String {
    let fallback = "https://github.com/official-stockfish/Stockfish/releases/download/sf_19/stockfish-windows-x86-64-universal.zip".to_string();
    let client = match reqwest::Client::builder().user_agent(UA).build() {
        Ok(c) => c,
        Err(_) => return fallback,
    };
    let Ok(resp) = client
        .get("https://api.github.com/repos/official-stockfish/Stockfish/releases/latest")
        .send()
        .await
    else {
        return fallback;
    };
    let Ok(v) = resp.json::<Value>().await else { return fallback };
    let assets: Vec<(String, String)> = v
        .get("assets")
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| {
                    Some((
                        x.get("name")?.as_str()?.to_string(),
                        x.get("browser_download_url")?.as_str()?.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    #[allow(unused_mut)]
    let mut prefs: Vec<&str> = vec!["windows-x86-64-universal", "windows-x86-64.zip"];
    #[cfg(target_arch = "x86_64")]
    {
        if std::arch::is_x86_feature_detected!("avx2") {
            prefs.insert(0, "windows-x86-64-avx2");
        }
    }
    for p in prefs {
        if let Some((_, url)) = assets.iter().find(|(n, _)| n.contains(p) && n.ends_with(".zip")) {
            return url.clone();
        }
    }
    fallback
}

pub async fn install_stockfish(data: &Path, progress: impl FnMut(u64, Option<u64>)) -> Result<PathBuf, String> {
    let url = stockfish_url().await;
    let zip_path = engine_dir(data).join("stockfish.zip");
    download(&url, &zip_path, progress).await?;
    let dest = default_engine_path(data);
    {
        let f = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
        let mut z = zip::ZipArchive::new(f).map_err(|e| format!("Bad archive: {e}"))?;
        let mut found = false;
        for i in 0..z.len() {
            let mut entry = z.by_index(i).map_err(|e| e.to_string())?;
            let name = entry.name().to_lowercase();
            if name.ends_with(".exe") && name.contains("stockfish") {
                let mut out = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
                std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
                found = true;
                break;
            }
        }
        if !found {
            return Err("Engine executable not found in download".into());
        }
    }
    let _ = std::fs::remove_file(&zip_path);
    Ok(dest)
}

// ---------------------------------------------------------------- voices

pub struct VoiceDef {
    pub id: &'static str,
    pub label: &'static str,
    pub path: &'static str,
}

pub const VOICES: &[VoiceDef] = &[
    VoiceDef { id: "en_US-lessac-medium", label: "Lessac — US English, female", path: "en/en_US/lessac/medium" },
    VoiceDef { id: "en_US-ryan-medium", label: "Ryan — US English, male", path: "en/en_US/ryan/medium" },
    VoiceDef { id: "en_US-amy-medium", label: "Amy — US English, female", path: "en/en_US/amy/medium" },
    VoiceDef { id: "en_US-joe-medium", label: "Joe — US English, male", path: "en/en_US/joe/medium" },
    VoiceDef { id: "en_GB-alan-medium", label: "Alan — British English, male", path: "en/en_GB/alan/medium" },
    VoiceDef { id: "en_GB-jenny_dioco-medium", label: "Jenny — British English, female", path: "en/en_GB/jenny_dioco/medium" },
];

pub fn piper_dir(data: &Path) -> PathBuf {
    data.join("piper")
}

pub fn piper_exe(data: &Path) -> PathBuf {
    piper_dir(data).join("piper").join("piper.exe")
}

pub fn voice_model(data: &Path, id: &str) -> PathBuf {
    piper_dir(data).join("voices").join(format!("{id}.onnx"))
}

pub async fn install_voice(data: &Path, id: &str, mut progress: impl FnMut(&str, u64, Option<u64>)) -> Result<(), String> {
    let def = VOICES.iter().find(|v| v.id == id).ok_or("Unknown voice")?;
    if !piper_exe(data).exists() {
        let zip_path = piper_dir(data).join("piper.zip");
        download(
            "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip",
            &zip_path,
            |g, t| progress("Downloading voice engine", g, t),
        )
        .await?;
        let f = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
        let mut z = zip::ZipArchive::new(f).map_err(|e| format!("Bad archive: {e}"))?;
        z.extract(piper_dir(data)).map_err(|e| format!("Extract failed: {e}"))?;
        drop(z);
        let _ = std::fs::remove_file(&zip_path);
    }
    let base = format!("https://huggingface.co/rhasspy/piper-voices/resolve/main/{}/{}", def.path, def.id);
    let model = voice_model(data, id);
    download(&format!("{base}.onnx.json"), &model.with_extension("onnx.json"), |_, _| {}).await?;
    download(&format!("{base}.onnx"), &model, |g, t| progress("Downloading voice", g, t)).await?;
    Ok(())
}

pub fn speak(data: &Path, id: &str, text: &str, rate: f64) -> Result<Vec<u8>, String> {
    use std::process::{Command, Stdio};
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    let exe = piper_exe(data);
    let model = voice_model(data, id);
    if !exe.exists() || !model.exists() {
        return Err("Voice is not installed".into());
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let out = std::env::temp_dir().join(format!("chessreview-tts-{}-{nanos}.wav", std::process::id()));
    let length_scale = (1.0 / rate.clamp(0.5, 2.0)).to_string();
    let mut cmd = Command::new(&exe);
    cmd.arg("--model")
        .arg(&model)
        .arg("--output_file")
        .arg(&out)
        .arg("--length_scale")
        .arg(&length_scale)
        .arg("--sentence_silence")
        .arg("0.15")
        .current_dir(exe.parent().unwrap())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn().map_err(|e| format!("Voice failed: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let clean = text.replace('\n', " ");
        stdin.write_all(clean.as_bytes()).map_err(|e| e.to_string())?;
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Voice synthesis failed".into());
    }
    let bytes = std::fs::read(&out).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&out);
    Ok(bytes)
}
