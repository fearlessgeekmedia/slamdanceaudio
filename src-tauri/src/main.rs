#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Folder import for the desktop build.
//
// The webview's <input webkitdirectory> opens the platform's folder chooser,
// and GTK's chooser hands back whichever folder is *highlighted* rather than
// the one being browsed. So the app draws its own folder browser and asks us
// for directory listings, a recursive scan, and file bytes.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

const AUDIO_EXTENSIONS: [&str; 10] = [
    "mp3", "ogg", "oga", "flac", "wav", "m4a", "aac", "opus", "webm", "mp4",
];

const MAX_DEPTH: usize = 24;

#[derive(Serialize)]
struct DirView {
    path: String,
    parent: Option<String>,
    dirs: Vec<String>,
    audio: usize,
}

#[derive(Serialize)]
struct AudioEntry {
    path: String,
    name: String,
    size: u64,
    modified: u64,
}

fn is_audio(path: &Path) -> bool {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
    {
        Some(ext) => AUDIO_EXTENSIONS.contains(&ext.as_str()),
        None => false,
    }
}

fn resolve_dir(path: &str) -> Result<PathBuf, String> {
    let given = PathBuf::from(path);
    if !given.is_dir() {
        return Err(format!("That is not a folder: {path}"));
    }
    Ok(fs::canonicalize(&given).unwrap_or(given))
}

fn modified_millis(entry: &fs::DirEntry) -> u64 {
    entry
        .metadata()
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|delta| delta.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
fn browse_dir(path: String) -> Result<DirView, String> {
    let dir = resolve_dir(&path)?;
    let mut dirs = Vec::new();
    let mut audio = 0usize;

    let entries = fs::read_dir(&dir).map_err(|err| format!("Can't read {}: {err}", dir.display()))?;
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(kind) => kind,
            Err(_) => continue,
        };
        // Symlinked folders can form loops, and nothing here needs them.
        if file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if file_type.is_dir() {
            dirs.push(name);
        } else if file_type.is_file() && is_audio(&entry.path()) {
            audio += 1;
        }
    }

    dirs.sort_by_key(|name| name.to_lowercase());

    Ok(DirView {
        parent: dir.parent().map(|up| up.to_string_lossy().to_string()),
        path: dir.to_string_lossy().to_string(),
        dirs,
        audio,
    })
}

fn collect_audio(dir: &Path, depth: usize, found: &mut Vec<AudioEntry>) {
    if depth > MAX_DEPTH {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(kind) => kind,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_audio(&path, depth + 1, found);
        } else if file_type.is_file() && is_audio(&path) {
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            found.push(AudioEntry {
                path: path.to_string_lossy().to_string(),
                name,
                size,
                modified: modified_millis(&entry),
            });
        }
    }
}

#[tauri::command]
fn scan_audio(path: String) -> Result<Vec<AudioEntry>, String> {
    let dir = resolve_dir(&path)?;
    let mut found = Vec::new();
    collect_audio(&dir, 0, &mut found);
    found.sort_by_key(|entry| entry.path.to_lowercase());
    Ok(found)
}

#[tauri::command]
fn read_audio(path: String) -> Result<tauri::ipc::Response, String> {
    let file = PathBuf::from(&path);
    if !file.is_file() {
        return Err(format!("That is not a file: {path}"));
    }
    let bytes = fs::read(&file).map_err(|err| format!("Can't read {path}: {err}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn default_music_dir() -> String {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let music = Path::new(&home).join("Music");
    if music.is_dir() {
        music.to_string_lossy().to_string()
    } else {
        home
    }
}

// The AppImage carries WebKitGTK built on Ubuntu, whose libgstreamer looks for
// plugins under Debian's multiarch directory. A distro that keeps its plugins
// in /usr/lib/gstreamer-1.0 (Void, Fedora, Arch) therefore gave the bundled
// webview no elements at all: decodebin, appsink and autoaudiosink were all
// "not found", so every decode failed and the player silently did nothing.
// Pointing GStreamer at the plugins present on this machine, plus its scanner,
// keeps the bundle self-contained while still decoding on those distros.
fn host_gstreamer_dirs() -> Vec<String> {
    let mut dirs: Vec<String> = Vec::new();
    for base in ["/usr/lib", "/usr/lib64", "/usr/local/lib"] {
        let plain = Path::new(base).join("gstreamer-1.0");
        if plain.is_dir() {
            dirs.push(plain.to_string_lossy().into_owned());
        }
        let Ok(entries) = fs::read_dir(base) else {
            continue;
        };
        for entry in entries.flatten() {
            let candidate = entry.path().join("gstreamer-1.0");
            if candidate.is_dir() {
                dirs.push(candidate.to_string_lossy().into_owned());
            }
        }
    }
    dirs.sort();
    dirs.dedup();
    dirs
}

fn use_host_gstreamer() {
    let dirs = host_gstreamer_dirs();
    if dirs.is_empty() {
        return;
    }
    let joined = dirs.join(":");
    for key in ["GST_PLUGIN_SYSTEM_PATH_1_0", "GST_PLUGIN_PATH_1_0"] {
        let existing = std::env::var(key).unwrap_or_default();
        let value = if existing.is_empty() {
            joined.clone()
        } else {
            format!("{joined}:{existing}")
        };
        std::env::set_var(key, value);
    }
    if std::env::var_os("GST_PLUGIN_SCANNER").is_none() {
        for base in ["/usr/libexec/gstreamer-1.0", "/usr/lib/gstreamer-1.0"] {
            let scanner = Path::new(base).join("gst-plugin-scanner");
            if scanner.is_file() {
                std::env::set_var("GST_PLUGIN_SCANNER", scanner);
                break;
            }
        }
    }
}

// WebKitGTK 2.38 switched native HLS playback off by default (web sites are
// expected to use Media Source Extensions instead), so pasting an .m3u8 radio
// address — which is what iHeart and most station directories publish — failed
// instantly with "The operation is not supported." The engine reads this
// variable when the web process starts, so it has to be set before Tauri builds
// the window. Streams without HLS are unaffected.
fn enable_hls_playback() {
    if std::env::var_os("WEBKIT_GST_ENABLE_HLS_SUPPORT").is_none() {
        std::env::set_var("WEBKIT_GST_ENABLE_HLS_SUPPORT", "1");
    }
}

fn main() {
    enable_hls_playback();
    use_host_gstreamer();
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            browse_dir,
            scan_audio,
            read_audio,
            default_music_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running Slamdance Audio");
}
