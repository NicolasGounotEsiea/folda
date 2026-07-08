//! OCR for images and scanned PDFs — Tesseract 5.x integration.
//!
//! ## Design
//!
//! We shell out to a **system-installed Tesseract** (`tesseract.exe`) rather
//! than bundling it or linking `leptess`-style native bindings:
//!
//!   - Bundling adds 30-90 MB to the installer (binary + language packs) — a
//!     follow-up "OCR pack" download can revisit this, but V1 keeps the
//!     installer slim.
//!   - Native bindings (leptonica + tesseract C API) are a build-system
//!     nightmare on Windows (vcpkg, MSVC quirks) and pin us to a specific
//!     Tesseract version. Shelling out works with whatever 4.x/5.x the user
//!     has, including the popular UB Mannheim build.
//!
//! Detection order (first hit wins):
//!   1. `ocrTesseractPath` setting (user-provided explicit path)
//!   2. `tesseract` on PATH
//!   3. `C:\Program Files\Tesseract-OCR\tesseract.exe` (UB Mannheim default)
//!   4. `C:\Program Files (x86)\Tesseract-OCR\tesseract.exe`
//!   5. `%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe` (per-user install)
//!
//! ## Where OCR runs (and where it deliberately does NOT)
//!
//! OCR runs ONLY inside Phase 2 of the indexing pipeline
//! (`index_directory_content`), which already has a 30 s per-file timeout,
//! `PARALLEL_EXTRACTIONS = 2` workers, and BELOW_NORMAL thread priority.
//! It is intentionally absent from:
//!
//!   - **Phase 1 scan** (`scan_directory`) — scan must stay under ~2 s even
//!     on huge folders; OCR is 2-10 s per image.
//!   - **Phase 3 watcher** (`handle_fs_event`) — a burst of image saves
//!     (screenshot tools, batch exports) would queue minutes of OCR on the
//!     watcher path. New images get picked up by the next Phase 2 run instead.
//!   - **`preview_file` / `get_file_snippets`** — these are interactive
//!     (the AI panel blocks on them); a 10 s OCR would feel like a hang.
//!
//! ## Scanned-PDF strategy
//!
//! We do NOT rasterize PDF pages (that needs pdfium/ghostscript — heavy
//! native deps). Instead we exploit the fact that scanner output PDFs embed
//! one large JPEG per page (DCTDecode image XObjects): `lopdf` (already a
//! transitive dep of pdf-extract, same version) parses the PDF, we pull the
//! embedded JPEGs out verbatim, write each to a temp file, and OCR those.
//! PDFs with FlateDecode raw bitmaps (rarer, mostly synthetic documents)
//! are not handled in V1 — they simply keep their empty extraction.
//!
//! The child process gets a **hard kill after `TESSERACT_TIMEOUT`** via a
//! try_wait polling loop — the indexer's own 30 s timeout only abandons the
//! join handle, it can't kill a child process; without this loop a hung
//! tesseract.exe would linger forever.

use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Extensions we hand to Tesseract directly. Leptonica (Tesseract's image
/// layer) reads all of these natively. HEIC is intentionally absent — it
/// needs libheif which Tesseract builds don't ship.
pub const OCR_IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp"];

/// Images above this size are skipped (no downsampling in V1 — that would
/// need the `image` crate; a 5 MB photo is already ~20 MP which Tesseract
/// handles, beyond that runtimes explode).
pub const MAX_OCR_IMAGE_BYTES: i64 = 5 * 1024 * 1024;

/// Hard kill for the tesseract child process. Slightly under the indexer's
/// 30 s per-file timeout so we get a clean empty result instead of an
/// orphaned process.
const TESSERACT_TIMEOUT: Duration = Duration::from_secs(25);

/// A PDF whose extracted text is shorter than this is assumed to be scanned
/// (image-only). Digital PDFs virtually always produce more; scanner output
/// yields either nothing or a short run of metadata garbage from the ASCII
/// fallback.
const SCANNED_PDF_TEXT_THRESHOLD: usize = 100;

/// Max embedded images pulled out of a single PDF for OCR. Scanned docs are
/// one image per page; 5 pages of OCR text comfortably exceeds MAX_EXTRACT.
const MAX_PDF_IMAGES: usize = 5;

/// Max size of a single embedded JPEG we'll OCR.
const MAX_PDF_IMAGE_BYTES: usize = 8 * 1024 * 1024;

pub fn is_ocr_image_ext(ext: &str) -> bool {
    OCR_IMAGE_EXTS.iter().any(|e| ext.eq_ignore_ascii_case(e))
}

pub fn pdf_text_looks_scanned(text: &str) -> bool {
    text.trim().len() < SCANNED_PDF_TEXT_THRESHOLD
}

/// Resolved OCR configuration, loaded once per indexing run and passed down
/// to the extraction workers. `None` (from `load_ocr_config`) means OCR is
/// disabled or Tesseract wasn't found — extraction falls through to the
/// regular non-OCR path.
#[derive(Clone)]
pub struct OcrConfig {
    pub tesseract: PathBuf,
    /// Tesseract language string, e.g. "eng+fra". Sanitized — never contains
    /// anything outside [a-z_+].
    pub languages: String,
    /// When Some, passed as `--tessdata-dir` so Tesseract loads language packs
    /// from nxs's own user-writable folder instead of the system tessdata.
    /// Used when the user one-click-downloaded packs that the system install
    /// lacks. IMPORTANT: the flag REPLACES the search path (it does not
    /// extend it), so this dir must contain EVERY language in `languages` —
    /// `download_ocr_langs` guarantees that by always fetching the full
    /// requested set.
    pub tessdata_dir: Option<PathBuf>,
}

/// nxs's own tessdata folder: `%LOCALAPPDATA%\com.nxs.app\tessdata\`.
/// Language packs downloaded via `download_ocr_langs` land here. User-writable
/// (no UAC prompt), survives app updates, wiped with the rest of app data.
pub fn app_tessdata_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_local_data_dir().ok().map(|d| d.join("tessdata"))
}

/// Language packs present in the nxs-managed tessdata dir (file stems of
/// `*.traineddata`). Cheap directory read — no process spawn.
pub fn nxs_dir_langs(dir: &std::path::Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_suffix(".traineddata").map(str::to_string)
        })
        .filter(|stem| stem.chars().all(|c| c.is_ascii_lowercase() || c == '_'))
        .collect()
}

/// Keep only characters valid in a Tesseract lang spec ([a-z_+]). Anything
/// else is stripped. Empty result falls back to "eng" so a garbage setting
/// degrades to English instead of a tesseract error on every file.
pub fn sanitize_langs(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_lowercase() || *c == '+' || *c == '_')
        .collect();
    let cleaned = cleaned.trim_matches('+').to_string();
    if cleaned.is_empty() { "eng".to_string() } else { cleaned }
}

/// Read the three OCR settings from the settings table and resolve Tesseract.
/// Returns `None` when the feature is off or no binary was found. Called once
/// per `index_directory_content` run (NOT per file) to keep DB lock churn and
/// process probing out of the hot loop.
///
/// `nxs_tessdata` is the app-managed pack folder (`app_tessdata_dir`) — the
/// caller computes it because this function only has DB access.
///
/// Language + tessdata resolution, in priority order:
///   1. System tessdata has every requested pack → use it, no flag.
///   2. The nxs dir has every requested pack → use it via `--tessdata-dir`.
///      (The flag REPLACES the search path, so partial coverage is useless —
///      `download_ocr_langs` always fills the complete requested set.)
///   3. Degrade via `resolve_langs` against the system packs.
///      Empirically (Tesseract 5.5): a multi-lang spec with ONE missing pack
///      degrades gracefully (exit 0, uses the rest), but a spec where EVERY
///      pack is missing exits 1 → every extraction silently returns empty and
///      the sentinel rows prevent retries. A French user selecting "Français"
///      on an eng-only install would get zero OCR forever without this.
pub fn load_ocr_config(
    db: &rusqlite::Connection,
    nxs_tessdata: Option<&std::path::Path>,
) -> Option<OcrConfig> {
    let get = |key: &str| -> String {
        db.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_default()
    };

    if get("ocrEnabled") != "true" {
        return None;
    }
    let custom_path = get("ocrTesseractPath");
    let (tesseract, _version) = detect_tesseract_binary(&custom_path)?;

    let requested = sanitize_langs(&get("ocrLanguages"));
    let req_list: Vec<&str> = requested.split('+').filter(|l| !l.is_empty()).collect();

    // 1. System install covers the request → current behavior, no flag.
    let system = list_langs(&tesseract, None);
    if !req_list.is_empty() && req_list.iter().all(|l| system.iter().any(|s| s == l)) {
        return Some(OcrConfig { tesseract, languages: requested, tessdata_dir: None });
    }

    // 2. nxs-managed dir covers the request → point Tesseract at it.
    if let Some(dir) = nxs_tessdata {
        let local = nxs_dir_langs(dir);
        if !req_list.is_empty() && req_list.iter().all(|l| local.iter().any(|s| s == l)) {
            return Some(OcrConfig {
                tesseract,
                languages: requested,
                tessdata_dir: Some(dir.to_path_buf()),
            });
        }
    }

    // 3. Degrade to whatever the system install can serve.
    let languages = resolve_langs(&requested, &system);
    Some(OcrConfig { tesseract, languages, tessdata_dir: None })
}

/// List installed language packs via `tesseract --list-langs`.
/// Output shape (5.x): a header line, then one lang code per line. Some 4.x
/// builds print to stderr instead of stdout — read both.
/// `tessdata_dir` switches the listing to a custom pack folder (used to
/// validate downloads into the nxs-managed dir).
pub fn list_langs(exe: &PathBuf, tessdata_dir: Option<&std::path::Path>) -> Vec<String> {
    let mut cmd = Command::new(exe);
    cmd.arg("--list-langs");
    if let Some(dir) = tessdata_dir {
        cmd.arg("--tessdata-dir").arg(dir);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let Ok(out) = cmd.output() else { return Vec::new() };
    let text = if out.stdout.is_empty() { out.stderr } else { out.stdout };
    String::from_utf8_lossy(&text)
        .lines()
        .map(str::trim)
        // Lang codes are short lowercase tokens ("eng", "fra", "chi_sim").
        // The header line contains spaces/quotes/colons and is filtered out.
        .filter(|l| {
            !l.is_empty()
                && l.len() <= 12
                && l.chars().all(|c| c.is_ascii_lowercase() || c == '_')
        })
        .map(str::to_string)
        .collect()
}

/// Intersect the user's requested language spec with the installed packs.
/// Fallback chain when nothing requested is available: "eng" if installed,
/// else the first installed non-osd pack, else "eng" blind (tesseract will
/// error per-file, but an empty -l spec would too — nothing better to do).
/// `osd` (orientation detection) is never picked as a fallback: it contains
/// no character model, `-l osd` alone yields garbage.
pub fn resolve_langs(requested: &str, installed: &[String]) -> String {
    let req = sanitize_langs(requested);
    let kept: Vec<&str> = req
        .split('+')
        .filter(|l| !l.is_empty() && installed.iter().any(|i| i == l))
        .collect();
    if !kept.is_empty() {
        return kept.join("+");
    }
    if installed.iter().any(|l| l == "eng") {
        return "eng".to_string();
    }
    installed
        .iter()
        .find(|l| l.as_str() != "osd")
        .cloned()
        .unwrap_or_else(|| "eng".to_string())
}

/// Probe for a working Tesseract. When `custom_path` is non-empty it is the
/// ONLY candidate (the user explicitly chose it — silently falling back to a
/// different binary would be confusing). Returns (path, version-first-line).
pub fn detect_tesseract_binary(custom_path: &str) -> Option<(PathBuf, String)> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if !custom_path.trim().is_empty() {
        candidates.push(PathBuf::from(custom_path.trim()));
    } else {
        candidates.push(PathBuf::from("tesseract")); // PATH lookup
        candidates.push(PathBuf::from(r"C:\Program Files\Tesseract-OCR\tesseract.exe"));
        candidates.push(PathBuf::from(r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"));
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local).join(r"Programs\Tesseract-OCR\tesseract.exe"));
        }
    }

    for cand in candidates {
        if let Some(version) = probe_version(&cand) {
            return Some((cand, version));
        }
    }
    None
}

/// Run `<exe> --version` and return the first line ("tesseract v5.3.3...")
/// on success. Any spawn/exit failure = not a usable binary.
fn probe_version(exe: &PathBuf) -> Option<String> {
    let mut cmd = Command::new(exe);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    // Tesseract prints version info on stdout (5.x) or stderr (some 4.x builds).
    let text = if out.stdout.is_empty() { out.stderr } else { out.stdout };
    let first = String::from_utf8_lossy(&text).lines().next()?.trim().to_string();
    if first.is_empty() { None } else { Some(first) }
}

/// On Windows, child processes of a GUI app spawn a visible console window
/// unless CREATE_NO_WINDOW is set. Without this flag, bulk indexing flashes
/// dozens of black boxes across the user's screen.
fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// OCR a single image file. Returns extracted text (whitespace-collapsed,
/// capped at `max_chars`) or empty string on any failure. Never panics,
/// never leaves a child process running past TESSERACT_TIMEOUT.
pub fn ocr_image(cfg: &OcrConfig, image_path: &str, max_chars: usize) -> String {
    let mut cmd = Command::new(&cfg.tesseract);
    cmd.arg(image_path)
        .arg("stdout") // write text to stdout instead of an output file
        .arg("-l")
        .arg(&cfg.languages);
    if let Some(dir) = &cfg.tessdata_dir {
        cmd.arg("--tessdata-dir").arg(dir);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null()); // tesseract is chatty on stderr (DPI warnings)
    hide_console(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return String::new(),
    };

    // Drain stdout on a separate thread WHILE the child runs. Reading only
    // after exit would deadlock when output exceeds the OS pipe buffer
    // (~64 KB on Windows): the child blocks on write, we block on try_wait,
    // and the 25 s kill turns a valid extraction into an empty result. A
    // multi-page TIFF (Tesseract OCRs every page of a multi-page image) can
    // easily produce that much text.
    let reader = child.stdout.take().map(|mut stdout| {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut text = String::new();
            let _ = stdout.read_to_string(&mut text);
            text
        })
    });

    // Poll with try_wait + hard kill. std::process has no wait_timeout; the
    // indexer's tokio timeout can only abandon the join handle — it cannot
    // reach the child process. This loop guarantees no orphaned tesseract.exe.
    let deadline = Instant::now() + TESSERACT_TIMEOUT;
    let status_ok = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait(); // reap; also closes the pipe so the reader thread ends
                    break false;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => break false,
        }
    };

    // Join the reader regardless of exit status so the thread never leaks.
    let text = reader
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    if !status_ok {
        return String::new();
    }
    collapse_ws(&text, max_chars)
}

/// Whitespace-collapse + char cap, same normalization as the other extractors
/// in files.rs so FTS5 sees consistent input.
fn collapse_ws(text: &str, max_chars: usize) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect()
}

/// Extract embedded JPEGs (DCTDecode image XObjects) from a PDF and OCR them.
/// Targets scanner output: one large JPEG per page. Returns concatenated OCR
/// text, capped at `max_chars`. Wrapped in catch_unwind because lopdf can
/// panic on malformed PDFs, same failure mode as pdf-extract (section 4 of
/// CLAUDE.md: "Don't trust pdf-extract not to panic" applies to lopdf too).
pub fn ocr_pdf_embedded_images(cfg: &OcrConfig, pdf_path: &str, max_chars: usize) -> String {
    let path_owned = pdf_path.to_string();
    let images = std::panic::catch_unwind(move || extract_pdf_jpegs(&path_owned))
        .unwrap_or_default();
    if images.is_empty() {
        return String::new();
    }

    let mut combined = String::new();
    for (i, jpeg_bytes) in images.iter().enumerate() {
        // Unique temp path per process + index — two parallel extractions
        // (PARALLEL_EXTRACTIONS = 2) must never collide on the same file.
        let tmp = std::env::temp_dir().join(format!(
            "nxs-ocr-{}-{}-{}.jpg",
            std::process::id(),
            // Pointer of the Vec disambiguates two concurrent PDFs.
            images.as_ptr() as usize,
            i
        ));
        if std::fs::write(&tmp, jpeg_bytes).is_err() {
            continue;
        }
        let page_text = ocr_image(cfg, &tmp.to_string_lossy(), max_chars);
        let _ = std::fs::remove_file(&tmp);

        if !page_text.is_empty() {
            if !combined.is_empty() {
                combined.push(' ');
            }
            combined.push_str(&page_text);
            if combined.len() >= max_chars {
                break;
            }
        }
    }
    combined.chars().take(max_chars).collect()
}

/// Walk every object in the PDF and collect DCTDecode (JPEG) image streams,
/// largest-first bias by natural object order (scanner PDFs store page images
/// sequentially). Cap count and per-image size. Object-order iteration is
/// deliberately simpler than walking page→resources→XObject references — it
/// is robust to broken cross-reference structures that scanners often emit.
fn extract_pdf_jpegs(pdf_path: &str) -> Vec<Vec<u8>> {
    let doc = match lopdf::Document::load(pdf_path) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };

    let mut jpegs: Vec<Vec<u8>> = Vec::new();
    for (_id, obj) in doc.objects.iter() {
        if jpegs.len() >= MAX_PDF_IMAGES {
            break;
        }
        let stream = match obj {
            lopdf::Object::Stream(s) => s,
            _ => continue,
        };
        // Subtype must be /Image
        let is_image = matches!(
            stream.dict.get(b"Subtype"),
            Ok(lopdf::Object::Name(n)) if n.as_slice() == b"Image"
        );
        if !is_image {
            continue;
        }
        // Filter must be (or contain) /DCTDecode — the stream content is then
        // a complete JPEG file we can hand to Tesseract as-is. Multi-filter
        // chains (e.g. [FlateDecode DCTDecode]) would need decompression
        // first; skip them (rare in scanner output).
        let is_jpeg = match stream.dict.get(b"Filter") {
            Ok(lopdf::Object::Name(n)) => n.as_slice() == b"DCTDecode",
            Ok(lopdf::Object::Array(arr)) => {
                arr.len() == 1
                    && matches!(&arr[0], lopdf::Object::Name(n) if n.as_slice() == b"DCTDecode")
            }
            _ => false,
        };
        if !is_jpeg {
            continue;
        }
        if stream.content.is_empty() || stream.content.len() > MAX_PDF_IMAGE_BYTES {
            continue;
        }
        jpegs.push(stream.content.clone());
    }
    jpegs
}

// ── Tauri command: Tesseract status for the Settings UI ──────────────────────

#[derive(Serialize)]
pub struct TesseractStatus {
    pub found: bool,
    pub path: String,
    pub version: String,
    /// Installed language packs ("eng", "fra", …). The Settings UI compares
    /// the user's selection against this and warns when a selected pack is
    /// missing — otherwise indexing would silently degrade (or fail) with no
    /// visible signal.
    pub langs: Vec<String>,
}

/// Probe for Tesseract and report the result. Called by the Settings modal
/// when the OCR section renders and after the user edits the custom path.
/// Honors the `ocrTesseractPath` setting the same way the indexer does, so
/// what the UI reports is exactly what indexing will use.
///
/// `langs` is the UNION of system packs and nxs-downloaded packs — i.e. what
/// OCR can actually serve after `load_ocr_config` resolution. The missing-pack
/// warning in Settings compares the user's selection against this union.
#[tauri::command]
pub fn detect_tesseract(
    state: tauri::State<crate::AppState>,
    app: tauri::AppHandle,
) -> TesseractStatus {
    let custom_path = state
        .db
        .lock()
        .ok()
        .and_then(|db| {
            db.query_row(
                "SELECT value FROM settings WHERE key = 'ocrTesseractPath'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()
        })
        .unwrap_or_default();

    match detect_tesseract_binary(&custom_path) {
        Some((path, version)) => {
            let mut langs = list_langs(&path, None);
            if let Some(dir) = app_tessdata_dir(&app) {
                for l in nxs_dir_langs(&dir) {
                    if !langs.contains(&l) {
                        langs.push(l);
                    }
                }
            }
            TesseractStatus {
                found: true,
                path: path.to_string_lossy().to_string(),
                version,
                langs,
            }
        }
        None => TesseractStatus {
            found: false,
            path: String::new(),
            version: String::new(),
            langs: Vec::new(),
        },
    }
}

// ── Tauri command: one-click language pack download ──────────────────────────

/// Where packs come from. `tessdata_fast` is the flavor recommended for
/// real-time use (small: fra ≈ 1.1 MB, eng ≈ 4 MB) and works on any
/// Tesseract 4.0+. Served straight from GitHub over TLS.
const TESSDATA_REPO_URL: &str = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main";

/// Reject anything above this — the largest legitimate fast packs are ~11 MB
/// (chi_sim etc.); a mis-served page or corrupted response should not be
/// written to disk as a .traineddata.
const MAX_PACK_BYTES: usize = 40 * 1024 * 1024;

/// Download the given language packs into the nxs-managed tessdata dir.
/// The frontend passes the FULL requested set (e.g. ["eng", "fra"]) — packs
/// already present are skipped, so this is idempotent and cheap to re-run.
/// Downloading the full set (not just the missing one) is what makes the
/// `--tessdata-dir` strategy sound: the flag replaces Tesseract's search
/// path, so the dir must be self-sufficient.
///
/// After download, the whole dir is validated with a real
/// `tesseract --list-langs --tessdata-dir <dir>` — if a downloaded pack
/// doesn't show up there, its file is deleted and the command errors. This
/// catches truncated downloads and wrong-content responses with the same
/// check the indexer will implicitly rely on.
#[tauri::command]
pub async fn download_ocr_langs(
    langs: Vec<String>,
    state: tauri::State<'_, crate::AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<String>, String> {
    // Strict allowlist — these strings end up in a URL and a filename.
    // Tesseract lang codes are 3-letter ISO 639-2 plus optional _script
    // suffixes ("chi_sim", "aze_cyrl"): lowercase + underscore, 3..=12 chars.
    let mut wanted: Vec<String> = Vec::new();
    for l in langs {
        let l = l.trim().to_string();
        let valid = (3..=12).contains(&l.len())
            && l.chars().all(|c| c.is_ascii_lowercase() || c == '_');
        if !valid {
            return Err(format!("Invalid language code: {:?}", l));
        }
        if !wanted.contains(&l) {
            wanted.push(l);
        }
    }
    if wanted.is_empty() {
        return Err("No languages requested".to_string());
    }

    let dir = app_tessdata_dir(&app).ok_or("Cannot resolve app data directory")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create tessdata dir: {}", e))?;

    let already: Vec<String> = nxs_dir_langs(&dir);
    let to_fetch: Vec<String> = wanted
        .iter()
        .filter(|l| !already.contains(l))
        .cloned()
        .collect();

    if !to_fetch.is_empty() {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .user_agent("nxs-file-manager")
            .build()
            .map_err(|e| e.to_string())?;

        for lang in &to_fetch {
            let url = format!("{}/{}.traineddata", TESSDATA_REPO_URL, lang);
            let resp = client
                .get(&url)
                .send()
                .await
                .map_err(|e| format!("Download failed for '{}': {}", lang, e))?;
            if !resp.status().is_success() {
                return Err(format!(
                    "Download failed for '{}': HTTP {} (pack may not exist in tessdata_fast)",
                    lang,
                    resp.status()
                ));
            }
            let bytes = resp
                .bytes()
                .await
                .map_err(|e| format!("Download failed for '{}': {}", lang, e))?;
            // Sanity floor: the smallest real packs are ~500 KB. A tiny body
            // is an error page or a truncation, not a model.
            if bytes.len() < 100 * 1024 || bytes.len() > MAX_PACK_BYTES {
                return Err(format!(
                    "Downloaded '{}' has implausible size ({} bytes) — refused",
                    lang,
                    bytes.len()
                ));
            }
            // Write to a .part file then rename — a crash mid-write must not
            // leave a truncated .traineddata that Tesseract chokes on and
            // nxs_dir_langs happily lists.
            let part = dir.join(format!("{}.traineddata.part", lang));
            let final_path = dir.join(format!("{}.traineddata", lang));
            std::fs::write(&part, &bytes).map_err(|e| format!("Write failed: {}", e))?;
            std::fs::rename(&part, &final_path).map_err(|e| format!("Rename failed: {}", e))?;
        }
    }

    // Validate with a real Tesseract listing when a binary is available —
    // the exact check the indexer's config load performs.
    let custom_path = state
        .db
        .lock()
        .ok()
        .and_then(|db| {
            db.query_row(
                "SELECT value FROM settings WHERE key = 'ocrTesseractPath'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()
        })
        .unwrap_or_default();
    if let Some((exe, _)) = detect_tesseract_binary(&custom_path) {
        let dir_clone = dir.clone();
        let visible = tokio::task::spawn_blocking(move || list_langs(&exe, Some(&dir_clone)))
            .await
            .unwrap_or_default();
        for lang in &wanted {
            if !visible.contains(lang) {
                let _ = std::fs::remove_file(dir.join(format!("{}.traineddata", lang)));
                return Err(format!(
                    "Pack '{}' downloaded but Tesseract cannot load it — removed. Try again or install it into the system tessdata folder.",
                    lang
                ));
            }
        }
    }

    Ok(nxs_dir_langs(&dir))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_ext_classification() {
        assert!(is_ocr_image_ext("png"));
        assert!(is_ocr_image_ext("PNG")); // case-insensitive
        assert!(is_ocr_image_ext("jpeg"));
        assert!(is_ocr_image_ext("tiff"));
        assert!(!is_ocr_image_ext("heic")); // needs libheif — excluded in V1
        assert!(!is_ocr_image_ext("pdf"));
        assert!(!is_ocr_image_ext("txt"));
        assert!(!is_ocr_image_ext(""));
    }

    #[test]
    fn scanned_pdf_heuristic() {
        assert!(pdf_text_looks_scanned(""));
        assert!(pdf_text_looks_scanned("   \n\t  "));
        assert!(pdf_text_looks_scanned("JFIF ICC_PROFILE Adobe")); // ascii-runs garbage
        // 100+ chars of real text = digital PDF
        let digital = "a".repeat(150);
        assert!(!pdf_text_looks_scanned(&digital));
    }

    #[test]
    fn lang_sanitization() {
        assert_eq!(sanitize_langs("eng+fra"), "eng+fra");
        assert_eq!(sanitize_langs("eng"), "eng");
        // Injection attempts / garbage degrade to safe values
        assert_eq!(sanitize_langs("eng; rm -rf /"), "engrmrf");
        assert_eq!(sanitize_langs("ENG"), "eng"); // uppercase stripped → fallback
        assert_eq!(sanitize_langs(""), "eng");
        assert_eq!(sanitize_langs("+++"), "eng");
        assert_eq!(sanitize_langs("+eng+"), "eng"); // trim stray separators
        assert_eq!(sanitize_langs("chi_sim+eng"), "chi_sim+eng"); // underscore ok
    }

    #[test]
    fn collapse_ws_normalizes() {
        assert_eq!(collapse_ws("  hello \n\t world  ", 100), "hello world");
        assert_eq!(collapse_ws("abcdef", 3), "abc"); // cap applies
        assert_eq!(collapse_ws("", 100), "");
    }

    #[test]
    fn resolve_langs_intersects_with_installed() {
        let installed = vec!["eng".to_string(), "osd".to_string()];
        // The default "eng+fra" on an eng-only install must drop fra —
        // keeping it is survivable (5.x degrades) but noisy; dropping is clean.
        assert_eq!(resolve_langs("eng+fra", &installed), "eng");
        // Full-miss (French-only request, eng-only install) MUST NOT produce
        // "fra" — that exits 1 on every file. Falls back to eng.
        assert_eq!(resolve_langs("fra", &installed), "eng");
        // Both installed → both kept, order preserved.
        let both = vec!["eng".to_string(), "fra".to_string(), "osd".to_string()];
        assert_eq!(resolve_langs("eng+fra", &both), "eng+fra");
        assert_eq!(resolve_langs("fra", &both), "fra");
        // osd is never picked as a fallback (no character model).
        let osd_only = vec!["osd".to_string()];
        assert_eq!(resolve_langs("fra", &osd_only), "eng");
        // No probe data at all (list_langs failed) → keep eng blind.
        assert_eq!(resolve_langs("fra", &[]), "eng");
        // Non-eng install (e.g. German-only) → picks the installed pack.
        let deu_only = vec!["deu".to_string(), "osd".to_string()];
        assert_eq!(resolve_langs("fra", &deu_only), "deu");
    }

    #[test]
    fn nxs_dir_langs_reads_traineddata_stems() {
        let dir = std::env::temp_dir().join(format!("nxs-tessdata-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("fra.traineddata"), b"x").unwrap();
        std::fs::write(dir.join("chi_sim.traineddata"), b"x").unwrap();
        // Distractors that must NOT be listed:
        std::fs::write(dir.join("eng.traineddata.part"), b"x").unwrap(); // in-flight download
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();            // unrelated file
        std::fs::write(dir.join("FRA.traineddata"), b"x").unwrap();      // uppercase stem — but
        // note: on case-insensitive NTFS this may collide with fra.traineddata;
        // either way the uppercase stem must not appear in the result.

        let mut langs = nxs_dir_langs(&dir);
        langs.sort();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(langs.contains(&"fra".to_string()));
        assert!(langs.contains(&"chi_sim".to_string()));
        assert!(!langs.iter().any(|l| l == "eng")); // .part not counted
        assert!(!langs.iter().any(|l| l.contains("FRA")));
        // Missing dir → empty, no panic
        assert!(nxs_dir_langs(std::path::Path::new(r"C:\nope\missing")).is_empty());
    }

    #[test]
    fn detect_missing_custom_path_fails() {
        // A custom path that doesn't exist must NOT fall back to PATH probing —
        // the user explicitly chose a binary; silently using another would
        // make the Settings status lie about what indexing actually runs.
        let result = detect_tesseract_binary(r"C:\definitely\not\here\tesseract.exe");
        assert!(result.is_none());
    }

    #[test]
    fn extract_pdf_jpegs_handles_missing_file() {
        assert!(extract_pdf_jpegs(r"C:\nope\missing.pdf").is_empty());
    }

    /// End-to-end against a REAL Tesseract when one is installed on the dev
    /// machine; skips silently otherwise (CI runners don't have it). Exercises
    /// the exact production path: binary detection → lang listing → lang
    /// resolution → child process spawn with kill-timeout → text extraction.
    ///
    /// The test image is rendered by PowerShell + System.Drawing with a real
    /// font (Arial). An earlier revision hand-rolled a blocky 5x7 pixel font
    /// into a BMP — Tesseract returned "" for it every time (its LSTM models
    /// are trained on natural typography; square-corner block glyphs at
    /// uniform stroke width don't segment). Real-font rendering is the only
    /// reliable fixture. Skips when PowerShell rendering fails.
    #[test]
    fn e2e_real_tesseract_reads_generated_image() {
        let Some((exe, _version)) = detect_tesseract_binary("") else {
            eprintln!("SKIP: no Tesseract on this machine");
            return;
        };
        let installed = list_langs(&exe, None);
        assert!(
            !installed.is_empty(),
            "a working tesseract must report at least one language"
        );
        let cfg = OcrConfig {
            tesseract: exe,
            languages: resolve_langs("eng+fra", &installed),
            tessdata_dir: None,
        };

        let tmp = std::env::temp_dir().join(format!("nxs-ocr-e2e-{}.png", std::process::id()));
        let tmp_str = tmp.to_string_lossy().replace('\'', "");
        let script = format!(
            "Add-Type -AssemblyName System.Drawing; \
             $bmp = New-Object System.Drawing.Bitmap(600, 200); \
             $g = [System.Drawing.Graphics]::FromImage($bmp); \
             $g.Clear([System.Drawing.Color]::White); \
             $font = New-Object System.Drawing.Font('Arial', 24); \
             $g.DrawString('Invoice number 42 due January 2027', $font, [System.Drawing.Brushes]::Black, 20, 80); \
             $g.Dispose(); \
             $bmp.Save('{}', [System.Drawing.Imaging.ImageFormat]::Png); \
             $bmp.Dispose()",
            tmp_str
        );
        let render = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let rendered = matches!(render, Ok(s) if s.success()) && tmp.exists();
        if !rendered {
            eprintln!("SKIP: PowerShell image rendering unavailable");
            return;
        }

        let text = ocr_image(&cfg, &tmp.to_string_lossy(), 3000);
        let _ = std::fs::remove_file(&tmp);

        assert!(
            text.contains("Invoice") && text.contains("42"),
            "expected OCR to read the rendered sentence, got: {:?}",
            text
        );
    }

    #[test]
    fn extract_pdf_jpegs_handles_non_pdf() {
        // A text file is not a PDF — lopdf must fail cleanly, not panic.
        let tmp = std::env::temp_dir().join("nxs-ocr-test-notapdf.pdf");
        std::fs::write(&tmp, b"this is not a pdf at all").unwrap();
        let result = extract_pdf_jpegs(&tmp.to_string_lossy());
        let _ = std::fs::remove_file(&tmp);
        assert!(result.is_empty());
    }
}
