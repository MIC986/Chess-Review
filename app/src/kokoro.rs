//! Natural coach voice: Kokoro-82M (Apache-2.0) via the sherpa-onnx C API.
//! The model is loaded once and kept in memory, so each sentence is fast.

use std::ffi::{c_char, c_void, CString};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const RUNTIME_URL: &str =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-win-x64-shared-MT-Release.tar.bz2";
pub const MODEL_URL: &str =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2";
const RUNTIME_DIR: &str = "sherpa-onnx-v2.0.1-win-x64-shared-MT-Release";
const MODEL_DIR: &str = "kokoro-multi-lang-v1_0";
const LEGACY_DIR: &str = "kokoro-int8-multi-lang-v1_0";

/// (id, speaker id, label)
pub const VOICES: &[(&str, i32, &str)] = &[
    ("heart", 3, "Heart — warm, US English (female)"),
    ("bella", 2, "Bella — bright, US English (female)"),
    ("nicole", 6, "Nicole — soft, US English (female)"),
    ("michael", 16, "Michael — calm, US English (male)"),
    ("fenrir", 14, "Fenrir — deep, US English (male)"),
    ("puck", 18, "Puck — lively, US English (male)"),
    ("emma", 21, "Emma — British English (female)"),
    ("george", 26, "George — British English (male)"),
    ("fable", 25, "Fable — British English (male)"),
];

pub fn root(data: &Path) -> PathBuf {
    data.join("kokoro")
}
fn lib_dir(data: &Path) -> PathBuf {
    root(data).join(RUNTIME_DIR).join("lib")
}
fn model_dir(data: &Path) -> PathBuf {
    root(data).join(MODEL_DIR)
}
pub fn installed(data: &Path) -> bool {
    lib_dir(data).join("sherpa-onnx-c-api.dll").exists() && model_dir(data).join("model.onnx").exists()
}

// ------------------------------------------------------------- C ABI (sherpa-onnx v2.0.1)
type S = *const c_char;

#[repr(C)]
struct Vits { model: S, lexicon: S, tokens: S, data_dir: S, noise_scale: f32, noise_scale_w: f32, length_scale: f32, dict_dir: S }
#[repr(C)]
struct Matcha { acoustic_model: S, vocoder: S, lexicon: S, tokens: S, data_dir: S, noise_scale: f32, length_scale: f32, dict_dir: S }
#[repr(C)]
struct Kokoro { model: S, voices: S, tokens: S, data_dir: S, length_scale: f32, dict_dir: S, lexicon: S, lang: S }
#[repr(C)]
struct Kitten { model: S, voices: S, tokens: S, data_dir: S, length_scale: f32, lexicon: S }
#[repr(C)]
struct Zipvoice { tokens: S, encoder: S, decoder: S, vocoder: S, data_dir: S, lexicon: S, feat_scale: f32, t_shift: f32, target_rms: f32, guidance_scale: f32 }
#[repr(C)]
struct Pocket { lm_flow: S, lm_main: S, encoder: S, decoder: S, text_conditioner: S, vocab_json: S, token_scores_json: S, voice_embedding_cache_capacity: i32 }
#[repr(C)]
struct Supertonic { duration_predictor: S, text_encoder: S, vector_estimator: S, vocoder: S, tts_json: S, unicode_indexer: S, voice_style: S }
#[repr(C)]
struct ModelConfig { vits: Vits, num_threads: i32, debug: i32, provider: S, matcha: Matcha, kokoro: Kokoro, kitten: Kitten, zipvoice: Zipvoice, pocket: Pocket, supertonic: Supertonic }
#[repr(C)]
struct TtsConfig { model: ModelConfig, rule_fsts: S, max_num_sentences: i32, rule_fars: S, silence_scale: f32 }
#[repr(C)]
struct GeneratedAudio { samples: *const f32, n: i32, sample_rate: i32 }

type CreateFn = unsafe extern "C" fn(*const TtsConfig) -> *const c_void;
type GenerateFn = unsafe extern "C" fn(*const c_void, *const c_char, i32, f32) -> *const GeneratedAudio;
type DestroyAudioFn = unsafe extern "C" fn(*const GeneratedAudio);

struct Engine {
    _lib: libloading::Library,
    tts: *const c_void,
    generate: GenerateFn,
    destroy_audio: DestroyAudioFn,
}
unsafe impl Send for Engine {}

static ENGINE: Mutex<Option<Engine>> = Mutex::new(None);

fn load(data: &Path) -> Result<Engine, String> {
    if !installed(data) {
        return Err("Natural voice is not installed".into());
    }
    let dll = lib_dir(data).join("sherpa-onnx-c-api.dll");
    #[cfg(windows)]
    let lib: libloading::Library = unsafe {
        // Resolve onnxruntime.dll from the same folder.
        libloading::os::windows::Library::load_with_flags(&dll, 0x0000_0008)
            .map_err(|e| format!("Could not load voice runtime: {e}"))?
            .into()
    };
    #[cfg(not(windows))]
    let lib = unsafe { libloading::Library::new(&dll).map_err(|e| e.to_string())? };

    let md = model_dir(data);
    let p = |name: &str| CString::new(md.join(name).to_string_lossy().as_bytes()).unwrap();
    let model = p("model.onnx");
    let voices = p("voices.bin");
    let tokens = p("tokens.txt");
    let data_dir = p("espeak-ng-data");
    let dict_dir = p("dict");
    let lexicon = CString::new(format!(
        "{},{}",
        md.join("lexicon-us-en.txt").to_string_lossy(),
        md.join("lexicon-zh.txt").to_string_lossy()
    ))
    .unwrap();
    let empty = CString::new("").unwrap();
    let cpu = CString::new("cpu").unwrap();
    let e = empty.as_ptr();
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let threads = std::env::var("CR_TTS_THREADS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or((cores * 3 / 4).clamp(2, 12)) as i32;

    let cfg = TtsConfig {
        model: ModelConfig {
            vits: Vits { model: e, lexicon: e, tokens: e, data_dir: e, noise_scale: 0.0, noise_scale_w: 0.0, length_scale: 0.0, dict_dir: e },
            num_threads: threads,
            debug: 0,
            provider: cpu.as_ptr(),
            matcha: Matcha { acoustic_model: e, vocoder: e, lexicon: e, tokens: e, data_dir: e, noise_scale: 0.0, length_scale: 0.0, dict_dir: e },
            kokoro: Kokoro {
                model: model.as_ptr(),
                voices: voices.as_ptr(),
                tokens: tokens.as_ptr(),
                data_dir: data_dir.as_ptr(),
                length_scale: 1.0,
                dict_dir: dict_dir.as_ptr(),
                lexicon: lexicon.as_ptr(),
                lang: e,
            },
            kitten: Kitten { model: e, voices: e, tokens: e, data_dir: e, length_scale: 0.0, lexicon: e },
            zipvoice: Zipvoice { tokens: e, encoder: e, decoder: e, vocoder: e, data_dir: e, lexicon: e, feat_scale: 0.0, t_shift: 0.0, target_rms: 0.0, guidance_scale: 0.0 },
            pocket: Pocket { lm_flow: e, lm_main: e, encoder: e, decoder: e, text_conditioner: e, vocab_json: e, token_scores_json: e, voice_embedding_cache_capacity: 0 },
            supertonic: Supertonic { duration_predictor: e, text_encoder: e, vector_estimator: e, vocoder: e, tts_json: e, unicode_indexer: e, voice_style: e },
        },
        rule_fsts: e,
        max_num_sentences: 1,
        rule_fars: e,
        silence_scale: 0.2,
    };
    unsafe {
        let create: libloading::Symbol<CreateFn> = lib.get(b"SherpaOnnxCreateOfflineTts\0").map_err(|e| e.to_string())?;
        let generate: libloading::Symbol<GenerateFn> = lib.get(b"SherpaOnnxOfflineTtsGenerate\0").map_err(|e| e.to_string())?;
        let destroy: libloading::Symbol<DestroyAudioFn> =
            lib.get(b"SherpaOnnxDestroyOfflineTtsGeneratedAudio\0").map_err(|e| e.to_string())?;
        let tts = create(&cfg);
        if tts.is_null() {
            return Err("Voice model failed to load".into());
        }
        let (generate, destroy_audio) = (*generate, *destroy);
        Ok(Engine { _lib: lib, tts, generate, destroy_audio })
    }
}

/// Warm the model in the background so the first sentence is quick.
pub fn warm(data: PathBuf) {
    std::thread::spawn(move || {
        let mut g = ENGINE.lock().unwrap();
        if g.is_none() && installed(&data) {
            *g = load(&data).ok();
        }
    });
}

fn wav(samples: &[f32], rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

pub fn speak(data: &Path, voice: &str, text: &str, speed: f32) -> Result<Vec<u8>, String> {
    let sid = VOICES.iter().find(|v| v.0 == voice).map(|v| v.1).unwrap_or(3);
    let mut g = ENGINE.lock().unwrap();
    if g.is_none() {
        *g = Some(load(data)?);
    }
    let eng = g.as_ref().unwrap();
    let c = CString::new(text.replace('\0', " ")).map_err(|e| e.to_string())?;
    unsafe {
        let audio = (eng.generate)(eng.tts, c.as_ptr(), sid, speed.clamp(0.5, 2.0));
        if audio.is_null() {
            return Err("Voice synthesis failed".into());
        }
        let a = &*audio;
        let samples = std::slice::from_raw_parts(a.samples, a.n.max(0) as usize);
        let bytes = wav(samples, a.sample_rate as u32);
        (eng.destroy_audio)(audio);
        Ok(bytes)
    }
}

fn extract_tar_bz2(archive: &Path, dest: &Path) -> Result<(), String> {
    use std::process::Command;
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let tar = if cfg!(windows) {
        PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into())).join("System32").join("tar.exe")
    } else {
        PathBuf::from("tar")
    };
    let mut cmd = Command::new(tar);
    cmd.arg("-xjf").arg(archive).arg("-C").arg(dest);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let st = cmd.status().map_err(|e| format!("Could not extract: {e}"))?;
    if !st.success() {
        return Err("Extracting the voice failed".into());
    }
    Ok(())
}

pub async fn install(data: &Path, mut progress: impl FnMut(&str, u64, Option<u64>)) -> Result<(), String> {
    let r = root(data);
    if !lib_dir(data).join("sherpa-onnx-c-api.dll").exists() {
        let a = r.join("runtime.tar.bz2");
        crate::setup::download(RUNTIME_URL, &a, |g, t| progress("Downloading voice runtime", g, t)).await?;
        progress("Unpacking", 0, None);
        extract_tar_bz2(&a, &r)?;
        let _ = std::fs::remove_file(&a);
    }
    if !model_dir(data).join("model.onnx").exists() {
        let a = r.join("model.tar.bz2");
        crate::setup::download(MODEL_URL, &a, |g, t| progress("Downloading coach voices", g, t)).await?;
        progress("Unpacking", 0, None);
        extract_tar_bz2(&a, &r)?;
        let _ = std::fs::remove_file(&a);
    }
    if !installed(data) {
        return Err("Voice files are incomplete after install".into());
    }
    // Remove the older, slower int8 model if present.
    let _ = std::fs::remove_dir_all(r.join(LEGACY_DIR));
    Ok(())
}
