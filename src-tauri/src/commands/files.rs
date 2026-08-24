use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

// Keeps the watcher alive for the entire app lifetime.
// Stored outside AppState because RecommendedWatcher is not Sync.
static WATCHER: Mutex<Option<notify::RecommendedWatcher>> = Mutex::new(None);

use crate::{models::FileEntry, AppState};

fn load_file_tags(
    db: &rusqlite::Connection,
    file_id: i64,
    context_id: i64,
) -> rusqlite::Result<Vec<crate::models::Tag>> {
    let mut stmt = db.prepare(
        "SELECT DISTINCT t.id, t.name, t.color, t.is_auto, ft.context_id
         FROM tags t JOIN file_tags ft ON ft.tag_id = t.id
         WHERE ft.file_id = ?1 AND (ft.context_id = 0 OR ft.context_id = ?2)
         ORDER BY ft.context_id ASC, t.name",
    )?;
    let tags = stmt
        .query_map(rusqlite::params![file_id, context_id], |row| {
            Ok(crate::models::Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                is_auto: row.get::<_, i64>(3)? != 0,
                context_id: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(tags)
}

fn load_folder_tags(
    db: &rusqlite::Connection,
    folder_path: &str,
    context_id: i64,
) -> rusqlite::Result<Vec<crate::models::Tag>> {
    let mut stmt = db.prepare(
        "SELECT DISTINCT t.id, t.name, t.color, t.is_auto, ft.context_id
         FROM tags t JOIN folder_tags ft ON ft.tag_id = t.id
         WHERE ft.folder_path = ?1 AND (ft.context_id = 0 OR ft.context_id = ?2)
         ORDER BY ft.context_id ASC, t.name",
    )?;
    let tags = stmt
        .query_map(rusqlite::params![folder_path, context_id], |row| {
            Ok(crate::models::Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                is_auto: row.get::<_, i64>(3)? != 0,
                context_id: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(tags)
}

// ── Text extraction ───────────────────────────────────────────────────────────

const TEXT_EXTS: &[&str] = &[
    "txt", "md", "rst", "log", "csv", "tsv",
    "json", "toml", "yaml", "yml", "xml", "html", "htm", "svg", "ini", "cfg", "conf",
    "rs", "js", "ts", "tsx", "jsx", "py", "go", "java", "c", "cpp", "h", "hpp",
    "cs", "rb", "php", "swift", "kt", "sh", "bash", "zsh", "ps1", "lua", "sql",
    "css", "scss", "less", "vue", "svelte", "tex",
];

const MAX_EXTRACT: usize = 3000; // chars returned to the AI

/// Extract up to MAX_EXTRACT chars of readable text from a file.
/// Returns an empty string for unsupported types or files that are too large.
pub fn extract_text_content(path: &str, extension: &str, size: i64) -> String {
    const MAX_BYTES: i64 = 50 * 1024 * 1024; // 50 MB ceiling
    if size <= 0 || size > MAX_BYTES { return String::new(); }

    let ext = extension.to_lowercase();
    match ext.as_str() {
        e if TEXT_EXTS.contains(&e) => {
            std::fs::read_to_string(path)
                .ok()
                .map(|s| s.chars().take(MAX_EXTRACT).collect())
                .unwrap_or_default()
        }
        "pdf" => extract_pdf(path),
        "docx" => extract_zip_xml(path, &["word/document.xml"]),
        "pptx" => extract_pptx(path),
        "xlsx" | "ods" => extract_zip_xml(path, &["xl/sharedStrings.xml", "content.xml"]),
        "odt" | "odp" => extract_zip_xml(path, &["content.xml"]),
        // Unknown / no extension: sniff the bytes. Covers text files whose
        // extension isn't in TEXT_EXTS (`.sqlx`, `.env`, `.dockerfile`,
        // `.gradle`, `.prisma`, `Makefile`, `LICENSE`, project-specific
        // extensions, …). Binary files are rejected by the sniff and get the
        // empty sentinel like before, so this never mis-indexes a JPEG as text.
        _ => extract_text_sniffed(path),
    }
}

/// Fallback extractor for files with an unrecognized extension: read a bounded
/// prefix and, if it looks like UTF-8 text, return it. Otherwise empty.
///
/// "Looks like text" = decodes as UTF-8 AND contains no NUL byte in the sampled
/// prefix. A NUL byte is the single most reliable binary signal — text formats
/// essentially never contain one, and almost every binary format does within
/// the first few KB. We deliberately DON'T do statistical/heuristic scoring
/// (control-char ratios, etc.): too many false negatives on legitimate text
/// (e.g. files heavy in box-drawing or CJK), and the NUL check alone eliminates
/// the formats that actually matter (images, executables, archives, DBs).
fn extract_text_sniffed(path: &str) -> String {
    use std::io::Read;
    // Read at most enough bytes to fill MAX_EXTRACT chars. UTF-8 is ≤ 4 bytes
    // per char; 4× the char cap guarantees we can always reach MAX_EXTRACT
    // chars of text without reading the whole (possibly huge) file.
    const SNIFF_BYTES: usize = MAX_EXTRACT * 4;
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return String::new(),
    };
    let mut buf = vec![0u8; SNIFF_BYTES];
    let n = match file.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return String::new(),
    };
    buf.truncate(n);

    // Binary reject: any NUL byte in the sample.
    if buf.contains(&0) {
        return String::new();
    }
    // Must be valid UTF-8. `from_utf8` can fail because we truncated mid
    // multi-byte char at the buffer boundary — tolerate that one case by
    // trimming to the last valid boundary via the error's `valid_up_to`.
    let text = match std::str::from_utf8(&buf) {
        Ok(s) => s.to_string(),
        Err(e) => {
            let valid = e.valid_up_to();
            // A failure in the first byte means it's genuinely not UTF-8.
            if valid == 0 {
                return String::new();
            }
            // Safe: valid_up_to() is guaranteed on a char boundary.
            String::from_utf8_lossy(&buf[..valid]).into_owned()
        }
    };
    text.chars().take(MAX_EXTRACT).collect()
}

/// OCR-aware extraction wrapper — used ONLY by Phase 2 (`index_directory_content`).
///
/// Everything else (scan, watcher, preview_file, get_file_snippets) keeps calling
/// `extract_text_content` directly and never OCRs:
///   - scan has a ~2 s budget for whole trees; OCR is 2-10 s per image
///   - the watcher fires on every save; a screenshot burst would queue minutes of OCR
///   - preview/snippets are interactive — the AI panel blocks on them
///
/// Phase 2 is the right home: 30 s per-file timeout, 2 parallel workers at
/// BELOW_NORMAL priority, progress UI. `ocr = None` (feature off / Tesseract
/// missing) makes this function byte-for-byte equivalent to `extract_text_content`.
pub fn extract_text_with_ocr(
    path: &str,
    extension: &str,
    size: i64,
    ocr: Option<&crate::commands::ocr::OcrConfig>,
) -> String {
    use crate::commands::ocr;
    let Some(cfg) = ocr else {
        return extract_text_content(path, extension, size);
    };
    let ext = extension.to_lowercase();

    if ocr::is_ocr_image_ext(&ext) {
        // Images above the cap are skipped (no downsampling in V1) — they get
        // the usual empty sentinel row so the indexer doesn't retry forever.
        if size <= 0 || size > ocr::MAX_OCR_IMAGE_BYTES {
            return String::new();
        }
        return ocr::ocr_image(cfg, path, MAX_EXTRACT);
    }

    if ext == "pdf" {
        let text = extract_pdf(path);
        // Scanned-PDF fallback: when the normal extraction yields (nearly)
        // nothing, try OCR on the PDF's embedded JPEGs. Keep whichever result
        // carries more signal — a digital PDF that legitimately has 50 chars
        // of text loses nothing (its OCR pass finds no embedded scans and
        // returns empty, so `text` wins).
        if ocr::pdf_text_looks_scanned(&text) {
            let ocr_text = ocr::ocr_pdf_embedded_images(cfg, path, MAX_EXTRACT);
            if ocr_text.trim().len() > text.trim().len() {
                return ocr_text;
            }
        }
        return text;
    }

    extract_text_content(path, extension, size)
}

/// PDF: use pdf-extract for digital PDFs; fall back to ASCII heuristic for scanned/encrypted ones.
/// pdf-extract can panic on malformed PDFs (e.g. ObjectNotFound) — we catch the panic with
/// catch_unwind so a bad PDF never crashes the entire app.
fn extract_pdf(path: &str) -> String {
    let path_owned = path.to_string();
    // Move path into closure so it is UnwindSafe (String: UnwindSafe)
    let result = std::panic::catch_unwind(move || pdf_extract::extract_text(&path_owned));
    match result {
        Ok(Ok(text)) if !text.trim().is_empty() => {
            let clean: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
            clean.chars().take(MAX_EXTRACT).collect()
        }
        _ => {
            // pdf_extract failed or panicked — fall back to ASCII heuristic
            std::fs::read(path)
                .ok()
                .map(|b| ascii_runs(&b))
                .unwrap_or_default()
        }
    }
}

/// DOCX / ODT / ODS / ODP: open as ZIP, read the named XML entries, strip tags.
fn extract_zip_xml(path: &str, entry_names: &[&str]) -> String {
    use std::io::Read;
    let file = match std::fs::File::open(path) { Ok(f) => f, Err(_) => return String::new() };
    let mut archive = match zip::ZipArchive::new(file) { Ok(a) => a, Err(_) => return String::new() };
    let mut combined = String::new();
    for &name in entry_names {
        if let Ok(mut entry) = archive.by_name(name) {
            let mut xml = String::new();
            if entry.read_to_string(&mut xml).is_ok() {
                combined.push_str(&strip_xml(&xml));
                combined.push(' ');
                if combined.len() >= MAX_EXTRACT * 4 { break; }
            }
        }
    }
    combined.split_whitespace().collect::<Vec<_>>().join(" ")
        .chars().take(MAX_EXTRACT).collect()
}

/// PPTX: iterate slide XML files inside the ZIP.
fn extract_pptx(path: &str) -> String {
    use std::io::Read;
    let file = match std::fs::File::open(path) { Ok(f) => f, Err(_) => return String::new() };
    let mut archive = match zip::ZipArchive::new(file) { Ok(a) => a, Err(_) => return String::new() };
    let mut combined = String::new();
    let names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|e| e.name().to_string()))
        .filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"))
        .collect();
    for name in names {
        if let Ok(mut entry) = archive.by_name(&name) {
            let mut xml = String::new();
            if entry.read_to_string(&mut xml).is_ok() {
                combined.push_str(&strip_xml(&xml));
                combined.push(' ');
                if combined.len() >= MAX_EXTRACT * 4 { break; }
            }
        }
    }
    combined.split_whitespace().collect::<Vec<_>>().join(" ")
        .chars().take(MAX_EXTRACT).collect()
}

/// Remove XML/HTML tags, returning the interleaved text content.
fn strip_xml(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len() / 2);
    let mut in_tag = false;
    for ch in xml.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(if ch.is_whitespace() { ' ' } else { ch }),
            _ => {}
        }
    }
    out
}

/// Fallback: collect runs of ≥4 printable ASCII chars from raw bytes.
fn ascii_runs(bytes: &[u8]) -> String {
    let mut result = String::new();
    let mut run = String::new();
    for &b in bytes {
        if (0x20..=0x7e).contains(&b) {
            run.push(b as char);
        } else {
            if run.len() >= 4 {
                let t = run.trim();
                if !t.is_empty() {
                    if !result.is_empty() { result.push(' '); }
                    result.push_str(t);
                    if result.len() >= MAX_EXTRACT { break; }
                }
            }
            run.clear();
        }
    }
    result.chars().take(MAX_EXTRACT).collect()
}

/// Upsert extracted text into `file_content` (FTS triggers keep `file_content_fts` in sync).
fn store_text_content(db: &rusqlite::Connection, file_id: i64, text: &str) {
    let _ = db.execute(
        "INSERT INTO file_content (file_id, text_content) VALUES (?1, ?2)
         ON CONFLICT(file_id) DO UPDATE SET
           text_content = excluded.text_content,
           indexed_at   = unixepoch()",
        rusqlite::params![file_id, text],
    );
}

pub fn auto_tag_for_ext(ext: &str) -> Option<(&'static str, &'static str)> {
    match ext.to_lowercase().as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "ico" | "bmp" | "tiff" | "avif" | "heic" => {
            Some(("Images", "#ec4899"))
        }
        "mp4" | "mkv" | "avi" | "mov" | "webm" | "flv" | "wmv" => Some(("Videos", "#8b5cf6")),
        "mp3" | "wav" | "flac" | "ogg" | "m4a" | "aac" | "opus" => Some(("Audio", "#06b6d4")),
        "pdf" | "doc" | "docx" | "odt" | "rtf" | "pages" => Some(("Documents", "#3b82f6")),
        "xls" | "xlsx" | "csv" | "ods" | "numbers" => Some(("Spreadsheets", "#10b981")),
        "ppt" | "pptx" | "odp" | "key" => Some(("Presentations", "#f59e0b")),
        "txt" | "md" | "rst" | "log" | "org" => Some(("Text", "#94a3b8")),
        "rs" | "js" | "ts" | "tsx" | "jsx" | "py" | "go" | "java" | "c" | "cpp" | "h"
        | "cs" | "rb" | "php" | "swift" | "kt" | "html" | "css" | "scss" | "json"
        | "toml" | "yaml" | "yml" | "sh" | "bash" | "ps1" | "lua" | "zig" => {
            Some(("Code", "#22c55e"))
        }
        "zip" | "tar" | "gz" | "7z" | "rar" | "bz2" | "xz" | "zst" => {
            Some(("Archives", "#f97316"))
        }
        "exe" | "msi" | "dll" => Some(("Programs", "#ef4444")),
        "ttf" | "otf" | "woff" | "woff2" => Some(("Fonts", "#a78bfa")),
        _ => None,
    }
}

pub fn ensure_auto_tag(db: &rusqlite::Connection, name: &str, color: &str) -> rusqlite::Result<i64> {
    db.execute(
        "INSERT OR IGNORE INTO tags (name, color, is_auto) VALUES (?1, ?2, 1)",
        rusqlite::params![name, color],
    )?;
    db.query_row("SELECT id FROM tags WHERE name = ?1", [name], |r| r.get(0))
}

#[allow(clippy::too_many_arguments)]
fn upsert_file(
    db: &rusqlite::Connection,
    path_str: &str,
    name: &str,
    extension: &str,
    size: i64,
    created_at: i64,
    modified_at: i64,
    accessed_at: i64,
) -> rusqlite::Result<i64> {
    // Upsert preserving id and existing tags (no DELETE + INSERT)
    db.execute(
        "INSERT INTO files (path, name, extension, size, created_at, modified_at, accessed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(path) DO UPDATE SET
           name=excluded.name,
           extension=excluded.extension,
           size=excluded.size,
           modified_at=excluded.modified_at,
           accessed_at=excluded.accessed_at",
        rusqlite::params![path_str, name, extension, size, created_at, modified_at, accessed_at],
    )?;
    db.query_row("SELECT id FROM files WHERE path = ?1", [path_str], |r| r.get(0))
}

struct RawFile {
    path: String,
    name: String,
    extension: String,
    size: i64,
    created_at: i64,
    modified_at: i64,
    accessed_at: i64,
}

struct RawDir {
    path: String,
    name: String,
    modified_at: i64,
}

/// Emit cadence for `scan-progress` events from `walk_phase`.
/// 500 strikes a balance: tight enough to feel live on a fast disk, loose
/// enough that the IPC overhead stays under 1 ms per emit on a slow disk.
const SCAN_PROGRESS_INTERVAL: usize = 500;

/// Hard cap on files indexed per scan. Anything beyond this is ignored
/// (directories are still recorded). Matches the historical limit — raise
/// only after measuring `walk_phase` cost on a 100k-file Documents folder.
const MAX_FILES_PER_SCAN: usize = 100_000;

fn should_skip(path: &std::path::Path) -> bool {
    // Encrypted vaults are never scanned. This runs inside walkdir's
    // `filter_entry`, so returning true on a vault DIRECTORY prunes the whole
    // subtree — the walker never even sees the blobs inside. That is what keeps
    // vault plaintext (and even vault file names) out of `files`, `file_content`
    // and FTS5. See CLAUDE.md §43.
    //
    // Only the directory case is checked here, not `path_is_in_vault`: pruning
    // at the root means descendants are never visited, so paying for an
    // ancestor walk per entry would be wasted work.
    if path.is_dir() && crate::vault::format::is_vault(path) {
        return true;
    }
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        matches!(
            s.as_ref(),
            "$Recycle.Bin" | "System Volume Information" | "Windows"
                | "ProgramData" | "AppData" | ".git" | "node_modules"
                | "target" | ".cargo"
        )
    })
}

/// Loads all files under `path` with their tags in a single JOIN query.
fn load_files_with_tags(db: &rusqlite::Connection, path: &str, context_id: i64) -> Result<Vec<FileEntry>, String> {
    let mut stmt = db.prepare(
        "SELECT f.id, f.path, f.name, f.extension, f.size,
                f.created_at, f.modified_at, f.accessed_at,
                t.id, t.name, t.color, t.is_auto, ft.context_id
         FROM files f
         LEFT JOIN file_tags ft ON ft.file_id = f.id AND (ft.context_id = 0 OR ft.context_id = ?2)
         LEFT JOIN tags t ON t.id = ft.tag_id
         WHERE f.path LIKE ?1 || '%'
         ORDER BY f.modified_at DESC, f.id",
    ).map_err(|e| e.to_string())?;

    let mut file_map: indexmap::IndexMap<i64, FileEntry> = indexmap::IndexMap::new();

    let rows = stmt.query_map(rusqlite::params![path, context_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, Option<i64>>(8)?,
            row.get::<_, Option<String>>(9)?,
            row.get::<_, Option<String>>(10)?,
            row.get::<_, Option<i64>>(11)?,
            row.get::<_, Option<i64>>(12)?,
        ))
    }).map_err(|e| e.to_string())?;

    for row in rows.filter_map(|r| r.ok()) {
        let (id, path, name, ext, size, created, modified, accessed,
             tag_id, tag_name, tag_color, tag_is_auto, tag_context_id) = row;

        let entry = file_map.entry(id).or_insert_with(|| FileEntry {
            id, path, name, extension: ext, size,
            created_at: created, modified_at: modified, accessed_at: accessed,
            tags: vec![],
        });

        if let (Some(tid), Some(tname), Some(tcolor), Some(tis_auto)) =
            (tag_id, tag_name, tag_color, tag_is_auto)
        {
            entry.tags.push(crate::models::Tag {
                id: tid, name: tname, color: tcolor, is_auto: tis_auto != 0,
                context_id: tag_context_id.unwrap_or(0),
            });
        }
    }

    Ok(file_map.into_values().collect())
}

#[tauri::command]
pub fn scan_directory(
    path: String,
    state: tauri::State<AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<FileEntry>, String> {
    // Phase 1 — walk the tree, collect raw metadata. No DB lock held; no
    // text extraction (deferred to index_directory_content / Phase 2 of the
    // indexing pipeline). For a Documents-sized folder, this used to spend
    // most of its time inside extract_text_content; now it's pure stat work.
    let (raw_files, raw_dirs) = walk_phase(&path, &app);

    // Phase 2 — bulk-insert under one transaction. Mutex is held only for the
    // duration of insert_batch, then released before the final SELECT so other
    // DB-bound commands (list_directory, get_tags, …) can sneak in.
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        match insert_batch(&db, &raw_files, &raw_dirs, &path) {
            Ok(()) => db.execute_batch("COMMIT").map_err(|e| e.to_string())?,
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK");
                return Err(e.to_string());
            }
        }
        // `db` goes out of scope here — mutex released.
    }

    // Phase 3 — re-acquire the lock just for the final SELECT. Other commands
    // can land between Phase 2 and Phase 3; that's fine because the rows are
    // already committed and visible to any reader.
    let db = state.db.lock().map_err(|e| e.to_string())?;
    load_files_with_tags(&db, &path, 0)
}

/// Walks `path` (max depth 8, skipping system folders) and collects raw
/// metadata for every file and subdirectory. Emits `scan-progress` events
/// every `SCAN_PROGRESS_INTERVAL` files so the UI can show a live counter
/// instead of an opaque spinner.
///
/// Sequential by design today. The loop body is a pure function of the
/// `WalkDir` entry (no DB, no shared state), which is what makes the
/// rayon parallelization (improvement C) trivial later: collect entries
/// into a `Vec`, then `par_iter().filter_map(build_raw_file)` for the file
/// arm. The progress emit cadence + the `MAX_FILES_PER_SCAN` cap will need
/// an `AtomicUsize` once parallelized.
fn walk_phase(path: &str, app: &tauri::AppHandle) -> (Vec<RawFile>, Vec<RawDir>) {
    use tauri::Emitter;

    let mut raw_files: Vec<RawFile> = Vec::new();
    let mut raw_dirs: Vec<RawDir> = Vec::new();
    let mut count = 0usize;
    let mut next_progress_at = SCAN_PROGRESS_INTERVAL;

    let ts = |t: std::io::Result<std::time::SystemTime>| -> i64 {
        t.map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64)
            .unwrap_or(0)
    };

    for entry in WalkDir::new(path)
        .follow_links(false)
        .max_depth(8)
        .into_iter()
        .filter_entry(|e| !should_skip(e.path()))
        .filter_map(|e| e.ok())
    {
        let file_path = entry.path();

        if entry.file_type().is_dir() {
            // Skip the root itself; we only want subdirectories in `directories`.
            if file_path.to_string_lossy() != path {
                let name = file_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();
                let modified_at = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64)
                    .unwrap_or(0);
                raw_dirs.push(RawDir {
                    path: file_path.to_string_lossy().into_owned(),
                    name,
                    modified_at,
                });
            }
            continue;
        }

        if count >= MAX_FILES_PER_SCAN {
            continue;
        }

        let Ok(metadata) = entry.metadata() else { continue };

        raw_files.push(RawFile {
            path: file_path.to_string_lossy().into_owned(),
            name: file_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string(),
            extension: file_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_string(),
            size: metadata.len() as i64,
            created_at: ts(metadata.created()),
            modified_at: ts(metadata.modified()),
            accessed_at: ts(metadata.accessed()),
        });
        count += 1;

        if count >= next_progress_at {
            let _ = app.emit(
                "scan-progress",
                serde_json::json!({
                    "path": path,
                    "scanned": count,
                    "done": false,
                }),
            );
            next_progress_at += SCAN_PROGRESS_INTERVAL;
        }
    }

    // Final emit so the frontend gets the exact count even when total doesn't
    // land on a SCAN_PROGRESS_INTERVAL boundary. `done: true` lets the UI
    // distinguish "finished" from "still going".
    let _ = app.emit(
        "scan-progress",
        serde_json::json!({
            "path": path,
            "scanned": count,
            "done": true,
        }),
    );

    (raw_files, raw_dirs)
}

/// Inserts one batch of files + dirs into the DB. Designed for both:
///   - the current path (single call with all files) and
///   - improvement D (chunked commits) where the caller will split into
///     ~1000-file chunks and wrap each call in its own BEGIN/COMMIT to
///     reduce mutex hold time. All inserts here are idempotent, so splitting
///     across multiple transactions is safe.
///
/// Uses prepared statements for the hot loop: parsing the INSERT SQL once
/// instead of on every row saves ~30-40% on bulk-insert time vs. the previous
/// `db.execute(SQL, params)` pattern. RETURNING id removes the separate
/// `SELECT id FROM files WHERE path = ?` lookup per file.
fn insert_batch(
    db: &rusqlite::Connection,
    files: &[RawFile],
    dirs: &[RawDir],
    root_path: &str,
) -> rusqlite::Result<()> {
    use std::collections::HashMap;

    // Workspace bookkeeping. Idempotent — safe even when the caller chunks
    // and calls insert_batch multiple times.
    db.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('last_path', ?1)",
        [root_path],
    )?;
    db.execute(
        "INSERT OR IGNORE INTO watched_paths (path) VALUES (?1)",
        [root_path],
    )?;

    let mut insert_dir = db.prepare(
        "INSERT OR REPLACE INTO directories (path, name, modified_at) VALUES (?1, ?2, ?3)",
    )?;
    let mut insert_file = db.prepare(
        "INSERT INTO files (path, name, extension, size, created_at, modified_at, accessed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(path) DO UPDATE SET
           name=excluded.name,
           extension=excluded.extension,
           size=excluded.size,
           modified_at=excluded.modified_at,
           accessed_at=excluded.accessed_at
         RETURNING id",
    )?;
    let mut insert_file_tag = db.prepare(
        "INSERT OR IGNORE INTO file_tags (file_id, tag_id, context_id) VALUES (?1, ?2, 0)",
    )?;
    let mut insert_activity = db.prepare(
        "INSERT OR IGNORE INTO activity (file_id, file_path, file_name, action, timestamp)
         VALUES (?1, ?2, ?3, 'modified', ?4)",
    )?;

    for d in dirs {
        let _ = insert_dir.execute(rusqlite::params![d.path, d.name, d.modified_at]);
    }

    // Cache the resolved tag_id per distinct auto-tag name so we hit
    // ensure_auto_tag at most once per tag for the whole batch.
    let mut tag_id_cache: HashMap<&'static str, i64> = HashMap::new();

    for f in files {
        let Ok(file_id) = insert_file.query_row(
            rusqlite::params![
                f.path,
                f.name,
                f.extension,
                f.size,
                f.created_at,
                f.modified_at,
                f.accessed_at,
            ],
            |row| row.get::<_, i64>(0),
        ) else {
            continue;
        };

        if let Some((tag_name, tag_color)) = auto_tag_for_ext(&f.extension) {
            let tag_id = match tag_id_cache.get(tag_name) {
                Some(&id) => Some(id),
                None => match ensure_auto_tag(db, tag_name, tag_color) {
                    Ok(id) => {
                        tag_id_cache.insert(tag_name, id);
                        Some(id)
                    }
                    Err(_) => None,
                },
            };
            if let Some(tag_id) = tag_id {
                let _ = insert_file_tag.execute(rusqlite::params![file_id, tag_id]);
            }
        }

        let _ = insert_activity.execute(rusqlite::params![
            file_id,
            f.path,
            f.name,
            f.modified_at,
        ]);
    }

    Ok(())
}

fn handle_fs_event(
    res: notify::Result<notify::Event>,
    db: &Arc<Mutex<rusqlite::Connection>>,
    app: &tauri::AppHandle,
) {
    use notify::EventKind;
    use tauri::Emitter;

    let Ok(event) = res else { return };

    let action = match &event.kind {
        EventKind::Create(_) => "created",
        EventKind::Modify(_) => "modified",
        EventKind::Remove(_) => "deleted",
        _ => return,
    };

    for path in &event.paths {
        if path.is_dir() { continue; }

        // NEVER index anything inside a vault. This is the most dangerous
        // exclusion point in the app: while a vault is unlocked, decrypted
        // files legitimately appear and change on disk, and the watcher would
        // otherwise extract their text straight into `file_content` + FTS5 —
        // leaving vault plaintext sitting in an UNENCRYPTED database that
        // survives locking the vault. That would silently and permanently
        // defeat the whole feature.
        //
        // `path_is_in_vault` (not `is_vault`) because these are FILE paths:
        // we must catch anything at any depth under a vault root.
        // The cost is an ancestor walk per event, which is nothing next to the
        // text extraction it guards.
        if crate::vault::format::path_is_in_vault(path) {
            continue;
        }

        let path_str = path.to_string_lossy().to_string();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        let timestamp = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        // Extract text content BEFORE acquiring the DB lock (file I/O outside the mutex)
        let (file_meta, text_content) = if action != "deleted" {
            match std::fs::metadata(path) {
                Ok(meta) => {
                    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                    let text = extract_text_content(&path_str, ext, meta.len() as i64);
                    (Some(meta), text)
                }
                Err(_) => (None, String::new()),
            }
        } else {
            (None, String::new())
        };

        if let Ok(db) = db.lock() {
            let file_id: Option<i64> = if action != "deleted" {
                if let Some(meta) = file_meta {
                    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                    let _ = upsert_file(
                        &db, &path_str, &name, ext,
                        meta.len() as i64, timestamp, timestamp, timestamp,
                    );
                    if let Ok(fid) = db.query_row(
                        "SELECT id FROM files WHERE path = ?1", [&path_str], |r| r.get::<_, i64>(0)
                    ) {
                        if !text_content.is_empty() {
                            store_text_content(&db, fid, &text_content);
                        }
                        // Apply auto-tag on creation
                        if action == "created" {
                            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                            if let Some((tag_name, tag_color)) = auto_tag_for_ext(ext) {
                                if let Ok(tag_id) = ensure_auto_tag(&db, tag_name, tag_color) {
                                    let _ = db.execute(
                                        "INSERT OR IGNORE INTO file_tags (file_id, tag_id, context_id) VALUES (?1, ?2, 0)",
                                        rusqlite::params![fid, tag_id],
                                    );
                                }
                            }
                        }
                    }
                }
                db.query_row("SELECT id FROM files WHERE path = ?1", [&path_str], |r| r.get(0)).ok()
            } else {
                db.query_row("SELECT id FROM files WHERE path = ?1", [&path_str], |r| r.get(0)).ok()
            };

            let _ = db.execute(
                "INSERT INTO activity (file_id, file_path, file_name, action, timestamp)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![file_id, path_str, name, action, timestamp],
            );
        }

        let _ = app.emit("file-changed", serde_json::json!({
            "path": path_str,
            "name": name,
            "action": action,
            "timestamp": timestamp,
        }));

        // Dispatch to automation rules in a background thread so the notify
        // callback isn't blocked on rule evaluation / fs ops. The dispatcher
        // handles its own DB locking and cycle/rate-limit checks.
        if action != "deleted" {
            let db_for_auto = Arc::clone(db);
            let app_for_auto = app.clone();
            let path_buf = path.clone();
            let action_owned = action.to_string();
            std::thread::spawn(move || {
                crate::commands::automation::dispatch_event(
                    &path_buf,
                    &action_owned,
                    &db_for_auto,
                    &app_for_auto,
                );
            });
        }
    }
}

#[tauri::command]
pub fn watch_directory(
    path: String,
    state: tauri::State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use notify::{RecursiveMode, Watcher};

    let mut guard = WATCHER.lock().map_err(|e| e.to_string())?;

    // First call → create the singleton watcher with a callback bound to AppState.
    // Subsequent calls reuse it and just add the new path. Previously this fn
    // REPLACED the watcher on every call, which silently dropped earlier watches
    // — so a multi-folder workspace only had its last folder observed.
    if guard.is_none() {
        let db = Arc::clone(&state.db);
        let app_handle = app.clone();
        let watcher = notify::RecommendedWatcher::new(
            move |res| handle_fs_event(res, &db, &app_handle),
            notify::Config::default(),
        )
        .map_err(|e| e.to_string())?;
        *guard = Some(watcher);
    }

    let watcher = guard.as_mut().expect("watcher must be initialized");
    // `watch` is idempotent on notify v6 — re-watching an existing path is a no-op.
    watcher
        .watch(std::path::Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_files(
    path: String,
    context_id: Option<i64>,
    state: tauri::State<AppState>,
) -> Result<Vec<FileEntry>, String> {
    let context_id = context_id.unwrap_or(0);
    let db = state.db.lock().map_err(|e| e.to_string())?;
    load_files_with_tags(&db, &path, context_id)
}

#[tauri::command]
pub fn list_directory(
    path: String,
    context_id: Option<i64>,
    state: tauri::State<AppState>,
) -> Result<Vec<crate::models::ListEntry>, String> {
    let context_id = context_id.unwrap_or(0);
    use crate::models::ListEntry;

    let read = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let db = state.db.lock().map_err(|e| e.to_string())?;

    // Load tag rules and their tag details once, before iterating entries
    let rules: Vec<(i64, String, String)> = db
        .prepare("SELECT tag_id, rule_type, rule_value FROM tag_rules WHERE context_id = 0 OR context_id = ?1")
        .and_then(|mut s| {
            s.query_map(rusqlite::params![context_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();

    let rule_tags: std::collections::HashMap<i64, crate::models::Tag> = {
        let mut map = std::collections::HashMap::new();
        for (tag_id, _, _) in &rules {
            if map.contains_key(tag_id) { continue; }
            if let Ok(tag) = db.query_row(
                "SELECT id, name, color, is_auto FROM tags WHERE id = ?1",
                [tag_id],
                |row| Ok(crate::models::Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    is_auto: row.get::<_, i64>(3)? != 0,
                    context_id: 0,
                }),
            ) {
                map.insert(*tag_id, tag);
            }
        }
        map
    };

    let mut result: Vec<ListEntry> = read
        .filter_map(|e| e.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();

            let file_type = entry.file_type().ok()?;
            let meta = entry.metadata().ok()?;
            let entry_path = entry.path().to_string_lossy().to_string();
            let ts_secs = |t: std::io::Result<std::time::SystemTime>| {
                t.ok().map(|s| s.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64).unwrap_or(0)
            };
            let created_at  = ts_secs(meta.created());
            let modified_at = ts_secs(meta.modified());

            if file_type.is_dir() {
                let folder_tags = load_folder_tags(&db, &entry_path, context_id).unwrap_or_default();
                // One `.nxsvault` probe per directory — cheap, and it saves the
                // frontend N IPC round-trips to ask "is this one a vault?".
                let is_vault = crate::vault::format::is_vault(&entry.path());
                Some(ListEntry {
                    is_dir: true, name, path: entry_path,
                    size: -1, created_at, modified_at, extension: String::new(),
                    id: None, tags: folder_tags, is_vault,
                })
            } else {
                let extension = std::path::Path::new(&entry_path)
                    .extension().and_then(|e| e.to_str()).unwrap_or("").to_string();
                let size = meta.len() as i64;
                let (id, mut tags) = db
                    .query_row("SELECT id FROM files WHERE path = ?1", [&entry_path], |r| r.get::<_, i64>(0))
                    .ok()
                    .map(|id| (Some(id), load_file_tags(&db, id, context_id).unwrap_or_default()))
                    .unwrap_or((None, vec![]));

                // Apply tag rules inline
                if !rules.is_empty() {
                    let name_lower = name.to_lowercase();
                    let ext_lower = extension.to_lowercase();
                    let path_lower = entry_path.to_lowercase();
                    for (tag_id, rule_type, rule_value) in &rules {
                        let val_lower = rule_value.to_lowercase();
                        let matches = match rule_type.as_str() {
                            "ext"           => ext_lower == val_lower,
                            "name_contains" => name_lower.contains(val_lower.as_str()),
                            "name_starts"   => name_lower.starts_with(val_lower.as_str()),
                            "path_contains" => path_lower.contains(val_lower.as_str()),
                            "size_gt"       => rule_value.parse::<i64>().map(|v| size > v).unwrap_or(false),
                            "size_lt"       => rule_value.parse::<i64>().map(|v| size < v).unwrap_or(false),
                            _ => false,
                        };
                        if matches {
                            if let Some(fid) = id {
                                let _ = db.execute(
                                    "INSERT OR IGNORE INTO file_tags (file_id, tag_id, context_id) VALUES (?1, ?2, ?3)",
                                    rusqlite::params![fid, tag_id, context_id],
                                );
                            }
                            if !tags.iter().any(|t| t.id == *tag_id) {
                                if let Some(tag) = rule_tags.get(tag_id) {
                                    tags.push(tag.clone());
                                }
                            }
                        }
                    }
                }

                Some(ListEntry { is_dir: false, name, path: entry_path, size, created_at, modified_at, extension, id, tags, is_vault: false })
            }
        })
        .collect();

    result.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(result)
}

#[tauri::command]
pub fn get_file_tags(
    file_id: i64,
    context_id: Option<i64>,
    state: tauri::State<AppState>,
) -> Result<Vec<crate::models::Tag>, String> {
    let context_id = context_id.unwrap_or(0);
    let db = state.db.lock().map_err(|e| e.to_string())?;
    load_file_tags(&db, file_id, context_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_file_preview(path: String) -> Result<Option<String>, String> {
    use std::io::Read;

    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    const TEXT_EXTS: &[&str] = &[
        "txt", "md", "rst", "log", "csv", "xml", "html", "htm",
        "rs", "js", "ts", "tsx", "jsx", "py", "go", "java", "c", "cpp", "h",
        "cs", "rb", "php", "swift", "kt", "css", "scss", "json", "toml",
        "yaml", "yml", "sh", "bash", "ps1", "lua", "zig", "sql", "env",
    ];

    if !TEXT_EXTS.contains(&ext.as_str()) {
        return Ok(None);
    }

    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 6144];
    let n = file.read(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(n);

    match String::from_utf8(buf) {
        Ok(s) => Ok(Some(s)),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub fn record_activity(path: String, name: String, action: String, state: tauri::State<AppState>) {
    if let Ok(db) = state.db.lock() {
        log_activity(&db, &path, &name, &action);
    }
}

fn log_activity(db: &rusqlite::Connection, file_path: &str, file_name: &str, action: &str) {
    let norm = file_path.replace('\\', "/");
    let _ = db.execute(
        "INSERT INTO activity (file_id, file_path, file_name, action)
         SELECT id, ?1, ?2, ?3 FROM files WHERE path = ?4
         UNION ALL
         SELECT NULL, ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM files WHERE path = ?4)
         LIMIT 1",
        rusqlite::params![norm, file_name, action, file_path],
    );
}

/// Notepad++-style "Compare files" — returns aligned side-by-side rows so the
/// frontend can render two columns: left = old version, right = new version.
/// For modified lines (deleted-then-inserted pairs), each side carries the
/// CHARACTER-level intra-line diff via `<del>` / `<ins>` markers, so changes as
/// small as a single character (e.g. `1111211` vs `1111111`) get a precise
/// highlight rather than the entire line being painted.
///
/// Why character-level (was word-level): `from_words` treats a string with no
/// whitespace as a single "word", so any change anywhere in `1111211` makes
/// the WHOLE thing show as changed. Character-level fixes this at the cost of
/// noisier output on natural language — acceptable trade because a file diff
/// reader expects precision over readability.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DiffRow {
    /// "equal" | "delete" | "insert" | "modify"
    pub kind: String,
    pub left_no: Option<usize>,
    pub right_no: Option<usize>,
    /// Left-side content (old file). Empty when kind=="insert". For "modify",
    /// contains Private-Use-Area markers around removed character spans (open
    /// U+E000, close U+E001) — the frontend strips/styles them. We don't use
    /// HTML-shaped tags because the file content itself might contain them.
    pub left: String,
    /// Right-side content (new file). Empty when kind=="delete". For "modify",
    /// contains Private-Use-Area markers around added character spans (open
    /// U+E002, close U+E003).
    pub right: String,
}

#[derive(Debug, serde::Serialize)]
pub struct DiffHunk {
    pub old_start: usize,
    pub new_start: usize,
    pub rows: Vec<DiffRow>,
}

#[derive(Debug, serde::Serialize)]
pub struct DiffResult {
    pub identical: bool,
    pub hunks: Vec<DiffHunk>,
    /// Total line count of file A (normalized to LF). Used by the frontend
    /// "Expand context" feature to know when the trailing gap is exhausted
    /// (i.e. we've revealed every line after the last hunk).
    pub total_lines: usize,
}

#[tauri::command]
pub fn diff_files(path_a: String, path_b: String) -> Result<DiffResult, String> {
    const MAX_BYTES: u64 = 20 * 1024 * 1024;

    let meta_a = std::fs::metadata(&path_a).map_err(|e| format!("Cannot stat {}: {}", path_a, e))?;
    let meta_b = std::fs::metadata(&path_b).map_err(|e| format!("Cannot stat {}: {}", path_b, e))?;
    if meta_a.len() > MAX_BYTES || meta_b.len() > MAX_BYTES {
        return Err(format!("File too large for comparison (>{}MB)", MAX_BYTES / 1024 / 1024));
    }

    let text_a = std::fs::read_to_string(&path_a)
        .map_err(|e| format!("Cannot read {} as text (binary file?): {}", path_a, e))?;
    let text_b = std::fs::read_to_string(&path_b)
        .map_err(|e| format!("Cannot read {} as text (binary file?): {}", path_b, e))?;

    // Normalize line endings to LF before diffing. `similar::TextDiff::from_lines`
    // compares lines as raw strings, so a file with CRLF and a file with LF
    // produce ZERO equal lines — every line differs by `\r`. The diff then
    // collapses into one giant Delete-all + Insert-all hunk with no visible
    // structure, and the frontend sees the whole document as a single change
    // group. Same as Git's `core.autocrlf` and VSCode's diff editor: treat
    // EOL differences as not-a-diff for content comparison purposes. We
    // strip CR after LF (`\r\n` → `\n`) AND lone CR (`\r` → `\n`) so legacy
    // Mac CR-only files also normalize cleanly.
    let text_a = text_a.replace("\r\n", "\n").replace('\r', "\n");
    let text_b = text_b.replace("\r\n", "\n").replace('\r', "\n");

    let lines_a: Vec<&str> = text_a.lines().collect();
    let lines_b: Vec<&str> = text_b.lines().collect();
    // total_lines reports A's count — the frontend uses pathA for context
    // expansion, so this is the bound that matters.
    let total_lines = lines_a.len();

    if text_a == text_b {
        return Ok(DiffResult { identical: true, hunks: Vec::new(), total_lines });
    }

    // For files with the same line count, line-by-line alignment is usually
    // what the user wants (config edited in place, single-char fixes, etc.).
    // But "same length" alone is fragile: a refactor that adds 5 lines AND
    // removes 5 lines also produces equal totals, and a naive line-by-line
    // diff there would paint dozens of contiguous lines as "modified" even
    // though the structural edit script is just 5 inserts + 5 deletes.
    //
    // Cheapest robust answer: when lengths match, run BOTH algorithms and
    // pick whichever produced fewer change rows. Line-by-line wins on the
    // "edit in place" case (its output is just N modify rows, matching the
    // user's mental model). similar wins on "balanced restructuring" (it
    // finds the actual structural changes instead of mass-modify noise).
    // Both passes are O(file size) in practice and the larger file we
    // accept is capped at 20 MB.
    if lines_a.len() == lines_b.len() {
        let line_by_line = diff_equal_length(&lines_a, &lines_b);
        let pick = pick_fewest_rows([
            line_by_line,
            diff_via_similar(&text_a, &text_b, similar::Algorithm::Myers),
            diff_via_similar(&text_a, &text_b, similar::Algorithm::Patience),
        ]);
        return Ok(DiffResult { identical: false, hunks: pick, total_lines });
    }

    // Unequal line counts: race Myers (minimal-edit, default) against Patience
    // (anchor-based, better for highly repetitive content). With files made of
    // hundreds of identical lines, Myers has many valid alignments and can
    // place a single insertion as N scattered delete+insert pairs that look
    // like phantom modifications in unrelated hunks. Patience anchors on
    // unique lines first, producing the human-expected single inserted line.
    // Falls back to Myers internally when no unique anchors exist, so we
    // never get worse than the original behavior.
    //
    // ALSO: race the BACKWARD direction (b → a, then invert the result) for
    // both algorithms. Myers' minimal-cost path on repetitive content is
    // direction-asymmetric: A→B may produce 4 clean rows while B→A produces
    // 6 scattered rows on the very same files. Inverting the backward result
    // (swap left↔right + delete↔insert + marker types) maps it back to A→B
    // semantics so we can compare row counts on equal footing.
    let hunks = pick_fewest_rows([
        diff_via_similar(&text_a, &text_b, similar::Algorithm::Myers),
        invert_hunks(diff_via_similar(&text_b, &text_a, similar::Algorithm::Myers)),
        diff_via_similar(&text_a, &text_b, similar::Algorithm::Patience),
        invert_hunks(diff_via_similar(&text_b, &text_a, similar::Algorithm::Patience)),
    ]);
    Ok(DiffResult { identical: false, hunks, total_lines })
}

/// Inverts a hunk list computed in the reverse direction (b→a) so it can be
/// merged into / compared against forward-direction (a→b) results. Each row's
/// left/right content + line numbers swap; `delete` ↔ `insert`; `equal` and
/// `modify` keep their kind but swap content+numbers; intra-line marker
/// types in `modify` rows also swap (MARK_DEL_* ↔ MARK_INS_*) so the
/// left side stays red and the right side stays green visually.
fn invert_hunks(hunks: Vec<DiffHunk>) -> Vec<DiffHunk> {
    hunks.into_iter().map(|h| DiffHunk {
        old_start: h.new_start,
        new_start: h.old_start,
        rows: h.rows.into_iter().map(|r| {
            let kind = match r.kind.as_str() {
                "delete" => "insert".to_string(),
                "insert" => "delete".to_string(),
                _        => r.kind,            // equal, modify stay the same kind
            };
            DiffRow {
                kind,
                left_no:  r.right_no,
                right_no: r.left_no,
                left:  swap_marker_types(r.right),
                right: swap_marker_types(r.left),
            }
        }).collect(),
    }).collect()
}

/// In a marked-up string, swap MARK_DEL_* ↔ MARK_INS_*. Used when inverting
/// a backward-direction diff: the markers that wrapped "deleted" chars on
/// the OLD side need to become "inserted" markers on what's now the NEW side,
/// and vice versa, so the frontend's color convention (left=red, right=green)
/// stays correct.
fn swap_marker_types(s: String) -> String {
    // Two-step replace through a tombstone char that can't appear in real text
    // OR in any of the PUA markers, so the second pass doesn't undo the first.
    const TOMB_OPEN:  &str = "\u{E010}";
    const TOMB_CLOSE: &str = "\u{E011}";
    s
        .replace(MARK_DEL_OPEN,  TOMB_OPEN)
        .replace(MARK_DEL_CLOSE, TOMB_CLOSE)
        .replace(MARK_INS_OPEN,  MARK_DEL_OPEN)
        .replace(MARK_INS_CLOSE, MARK_DEL_CLOSE)
        .replace(TOMB_OPEN,      MARK_INS_OPEN)
        .replace(TOMB_CLOSE,     MARK_INS_CLOSE)
}

/// Picks the hunk list with the fewest non-equal rows. Our post-processing
/// merges consecutive Delete+Insert into a single `modify` row, so a cleaner
/// alignment (Patience anchoring) collapses what Myers might output as
/// scattered delete/insert pairs into compact modify rows — the row count
/// metric correctly favours it.
fn pick_fewest_rows<const N: usize>(candidates: [Vec<DiffHunk>; N]) -> Vec<DiffHunk> {
    candidates.into_iter()
        .min_by_key(|h| count_change_rows(h))
        .unwrap_or_default()
}

/// Total number of non-equal rows across a hunk list — the metric we use to
/// pick the "cleaner" algorithm in the equal-length case. Fewer change rows
/// = closer to the user's mental model of what changed.
fn count_change_rows(hunks: &[DiffHunk]) -> usize {
    hunks.iter()
        .flat_map(|h| h.rows.iter())
        .filter(|r| r.kind != "equal")
        .count()
}

/// Build hunks via `similar`'s line-level diff using the requested algorithm.
/// `diff_files` calls this with both Myers and Patience and picks the cleaner
/// alignment. Myers minimizes total edit distance but can scatter changes
/// across hunks on repetitive content; Patience anchors on unique lines first
/// and produces more visually-coherent alignments. On inputs where Patience
/// can't find unique anchors it falls back to Myers internally.
fn diff_via_similar(text_a: &str, text_b: &str, algorithm: similar::Algorithm) -> Vec<DiffHunk> {
    use similar::{ChangeTag, TextDiff};
    let line_diff = TextDiff::configure().algorithm(algorithm).diff_lines(text_a, text_b);

    let mut hunks: Vec<DiffHunk> = Vec::new();
    for hunk in line_diff.unified_diff().context_radius(3).iter_hunks() {
        let changes: Vec<_> = hunk.iter_changes().collect();

        // Hunk start lines from the FIRST change's source indexes — UnifiedHunk-
        // Header's range fields aren't public in similar 2.x, so we derive
        // ourselves. +1 because similar is 0-indexed and humans expect line 1.
        let old_start = changes.iter()
            .find_map(|c| c.old_index()).map(|i| i + 1).unwrap_or(1);
        let new_start = changes.iter()
            .find_map(|c| c.new_index()).map(|i| i + 1).unwrap_or(1);

        let mut rows: Vec<DiffRow> = Vec::new();
        let mut left_no = old_start;
        let mut right_no = new_start;
        let mut i = 0;
        while i < changes.len() {
            match changes[i].tag() {
                ChangeTag::Equal => {
                    let content = strip_trailing_newline(changes[i].value());
                    rows.push(DiffRow {
                        kind: "equal".into(),
                        left_no: Some(left_no),
                        right_no: Some(right_no),
                        left: content.clone(),
                        right: content,
                    });
                    left_no += 1;
                    right_no += 1;
                    i += 1;
                }
                ChangeTag::Delete => {
                    // Group consecutive deletes followed by consecutive inserts.
                    let del_start = i;
                    while i < changes.len() && changes[i].tag() == ChangeTag::Delete { i += 1; }
                    let ins_start = i;
                    while i < changes.len() && changes[i].tag() == ChangeTag::Insert { i += 1; }
                    let ins_end = i;

                    let dels: Vec<String> = changes[del_start..ins_start]
                        .iter().map(|c| strip_trailing_newline(c.value())).collect();
                    let inss: Vec<String> = changes[ins_start..ins_end]
                        .iter().map(|c| strip_trailing_newline(c.value())).collect();

                    // Pair up: zip dels with inss for "modify" rows.
                    let pair_count = dels.len().min(inss.len());
                    for k in 0..pair_count {
                        let (left_marked, right_marked) = inline_char_markers(&dels[k], &inss[k]);
                        rows.push(DiffRow {
                            kind: "modify".into(),
                            left_no: Some(left_no),
                            right_no: Some(right_no),
                            left: left_marked,
                            right: right_marked,
                        });
                        left_no += 1;
                        right_no += 1;
                    }
                    // Remaining unpaired deletes
                    for d in dels.iter().skip(pair_count) {
                        rows.push(DiffRow {
                            kind: "delete".into(),
                            left_no: Some(left_no),
                            right_no: None,
                            left: d.clone(),
                            right: String::new(),
                        });
                        left_no += 1;
                    }
                    // Remaining unpaired inserts
                    for ins in inss.iter().skip(pair_count) {
                        rows.push(DiffRow {
                            kind: "insert".into(),
                            left_no: None,
                            right_no: Some(right_no),
                            left: String::new(),
                            right: ins.clone(),
                        });
                        right_no += 1;
                    }
                }
                ChangeTag::Insert => {
                    let content = strip_trailing_newline(changes[i].value());
                    rows.push(DiffRow {
                        kind: "insert".into(),
                        left_no: None,
                        right_no: Some(right_no),
                        left: String::new(),
                        right: content,
                    });
                    right_no += 1;
                    i += 1;
                }
            }
        }

        hunks.push(DiffHunk {
            old_start,
            new_start,
            rows,
        });
    }
    hunks
}

/// Direct line-by-line diff for files of equal line count.
///
/// Walks both arrays in parallel. Every line index `i` produces exactly one
/// row, displayed with matching left/right line numbers `i+1`. Equal pairs
/// become `equal` rows; differing pairs become `modify` rows with inline
/// char-level markers. The result is then sliced into hunks: contiguous
/// runs of `equal` rows that exceed `2*CONTEXT_RADIUS+1` are collapsed —
/// each surviving change gets `CONTEXT_RADIUS` equal lines before and
/// after, and adjacent changes share their context.
///
/// Hunks are emitted with `old_start == new_start` because by construction
/// the lines are paired 1:1.
fn diff_equal_length(lines_a: &[&str], lines_b: &[&str]) -> Vec<DiffHunk> {
    const CONTEXT_RADIUS: usize = 3;
    assert_eq!(lines_a.len(), lines_b.len(), "caller must enforce equal length");

    // Find every index where the lines differ. If none, the files would
    // have been caught by the `text_a == text_b` shortcut above, so we
    // assume there's at least one.
    let changed: Vec<usize> = (0..lines_a.len())
        .filter(|&i| lines_a[i] != lines_b[i])
        .collect();
    if changed.is_empty() {
        return Vec::new();
    }

    // Group changes into hunks. Two changes share a hunk when they're close
    // enough that their context windows overlap (or touch). The threshold
    // `2*CONTEXT_RADIUS + 1` means: between two changes at indices p and q
    // (p < q), if there are `q - p - 1` equal lines between them and that
    // gap fits within `2*CONTEXT_RADIUS`, the trailing context of p and
    // the leading context of q touch — merge into one hunk.
    let merge_gap = 2 * CONTEXT_RADIUS;
    let mut groups: Vec<Vec<usize>> = Vec::new();
    let mut current: Vec<usize> = vec![changed[0]];
    for &pos in changed.iter().skip(1) {
        let prev = *current.last().unwrap();
        if pos - prev <= merge_gap + 1 {
            current.push(pos);
        } else {
            groups.push(std::mem::take(&mut current));
            current.push(pos);
        }
    }
    groups.push(current);

    let mut hunks: Vec<DiffHunk> = Vec::with_capacity(groups.len());
    for group in &groups {
        let first = *group.first().unwrap();
        let last = *group.last().unwrap();
        let start = first.saturating_sub(CONTEXT_RADIUS);
        let end = (last + CONTEXT_RADIUS + 1).min(lines_a.len());

        let mut rows: Vec<DiffRow> = Vec::with_capacity(end - start);
        for i in start..end {
            if lines_a[i] == lines_b[i] {
                rows.push(DiffRow {
                    kind: "equal".into(),
                    left_no: Some(i + 1),
                    right_no: Some(i + 1),
                    left: lines_a[i].to_string(),
                    right: lines_b[i].to_string(),
                });
            } else {
                let (left_marked, right_marked) = inline_char_markers(lines_a[i], lines_b[i]);
                rows.push(DiffRow {
                    kind: "modify".into(),
                    left_no: Some(i + 1),
                    right_no: Some(i + 1),
                    left: left_marked,
                    right: right_marked,
                });
            }
        }
        hunks.push(DiffHunk {
            old_start: start + 1,
            new_start: start + 1,
            rows,
        });
    }
    hunks
}

/// Split a string into individual grapheme-like &str slices preserving multi-byte
/// chars. Each element is a single char's byte range — safe to push into output
/// strings without breaking UTF-8 boundaries.
fn split_chars(s: &str) -> Vec<&str> {
    let mut out = Vec::with_capacity(s.len());
    let mut last = 0;
    for (i, _) in s.char_indices().skip(1) {
        out.push(&s[last..i]);
        last = i;
    }
    if last < s.len() {
        out.push(&s[last..]);
    }
    out
}

fn strip_trailing_newline(s: &str) -> String {
    s.strip_suffix('\n').map(|s| s.to_string()).unwrap_or_else(|| s.to_string())
}

/// Character-level inline diff with alignment heuristic. Wraps removed
/// characters in A with `<del>` and added characters in B with `<ins>`.
///
/// Char-level so that strings without whitespace (`1111211` vs `1111111`)
/// highlight only the changed character.
///
/// ALIGNMENT HEURISTIC: Myers' minimum-edit-script can produce
/// `Del + Equal + Ins` where the highlights end up at different visual columns
/// even though they represent the same logical replace (e.g. position-13
/// `2`→`1` on a string of all `1`s shows del at col 13 but ins at col 16).
/// We post-process the runs to swap `Del + Equal + Ins` into `Del + Ins +
/// Equal`, which is semantically equivalent (same A and B reconstructed) but
/// renders both markers at the SAME column — matching user intuition.
#[cfg(test)]
mod diff_tests {
    use super::{
        count_change_rows, diff_via_similar, inline_char_markers, invert_hunks,
        pick_fewest_rows, MARK_DEL_CLOSE, MARK_DEL_OPEN, MARK_INS_CLOSE, MARK_INS_OPEN,
    };

    /// Reproduce the repetitive-content bug the user reported: ~500 lines of
    /// identical "1111111111111111", with a few scattered modifications (a `2`
    /// appearing in two lines, plus one truncated trailing line), and a single
    /// inserted line of all 1's. Verify that Patience produces a cleaner (fewer
    /// change rows) alignment than Myers — that's exactly what `pick_fewest_rows`
    /// in `diff_files` relies on to upgrade the result.
    /// The backward direction of Myers/Patience on repetitive content
    /// produces a scattered alignment in one direction but a clean one in the
    /// other. The 4-way race in `diff_files` (forward + inverted backward, for
    /// both algorithms) symmetrizes the result. This guards against regression
    /// of the asymmetry bug.
    #[test]
    fn diff_is_symmetric_on_repetitive_content() {
        let a_lines: Vec<&str> = (0..500).map(|_| "1111111111111111").collect();
        let mut b_lines: Vec<&str> = a_lines.clone();
        b_lines[2]   = "x";              // modify
        b_lines[233] = "1111112111111111";
        b_lines[264] = "11111111111112";
        b_lines.insert(46, "1111111111111111");   // insert
        let last = b_lines.len() - 1;
        b_lines[last] = "1";                       // truncate last

        let text_a = a_lines.join("\n");
        let text_b = b_lines.join("\n");

        let race_4way = |x: &str, y: &str| -> usize {
            count_change_rows(&pick_fewest_rows([
                diff_via_similar(x, y, similar::Algorithm::Myers),
                invert_hunks(diff_via_similar(y, x, similar::Algorithm::Myers)),
                diff_via_similar(x, y, similar::Algorithm::Patience),
                invert_hunks(diff_via_similar(y, x, similar::Algorithm::Patience)),
            ]))
        };

        let forward  = race_4way(&text_a, &text_b);
        let backward = race_4way(&text_b, &text_a);
        assert_eq!(
            forward, backward,
            "race result must be symmetric: a→b={forward} b→a={backward}",
        );
    }

    #[test]
    fn repetitive_content_patience_beats_or_ties_myers() {
        // test1 (a) — pure 500 lines of identical content
        let mut a_lines: Vec<&str> = (0..500).map(|_| "1111111111111111").collect();
        // test2 (b) — same as test1 but with the differences from the user's
        // screenshot baked in:
        //   - line 236 (0-indexed) has a `2` in the middle  → modify
        //   - line 267 has a `2` at the end                 → modify
        //   - line 499 (last) is truncated to "1"           → modify
        //   - one extra line inserted around line 47        → insert
        let mut b_lines: Vec<&str> = a_lines.clone();
        b_lines[236] = "1111112111111111";
        b_lines[267] = "11111111111112";
        b_lines[499] = "1";
        b_lines.insert(47, "1111111111111111");
        // Disable the "unused" warning on a_lines being mutable.
        let _ = &mut a_lines;

        let text_a = a_lines.join("\n");
        let text_b = b_lines.join("\n");

        let myers    = diff_via_similar(&text_a, &text_b, similar::Algorithm::Myers);
        let patience = diff_via_similar(&text_a, &text_b, similar::Algorithm::Patience);
        let myers_rows    = count_change_rows(&myers);
        let patience_rows = count_change_rows(&patience);

        // The minimal human-expected change set is 4: 1 insert (extra line) +
        // 2 modifies (the `2`s) + 1 modify (truncated last line). Anything more
        // is the algorithm scattering. Patience should hit or beat Myers here.
        assert!(
            patience_rows <= myers_rows,
            "Patience should produce <= Myers row count on repetitive content: \
             myers={myers_rows} patience={patience_rows}",
        );
    }

    // Helper: wrap a literal into the del/ins markers without bloating
    // every assertion with `\u{E000}`-style escapes.
    fn d(s: &str) -> String { format!("{}{}{}", MARK_DEL_OPEN, s, MARK_DEL_CLOSE) }
    fn i(s: &str) -> String { format!("{}{}{}", MARK_INS_OPEN, s, MARK_INS_CLOSE) }

    #[test]
    fn single_char_swap_aligns_at_same_position() {
        let (left, right) = inline_char_markers("1111111111112111", "1111111111111111");
        assert_eq!(left, format!("111111111111{}111", d("2")));
        assert_eq!(right, format!("111111111111{}111", i("1")));
    }

    #[test]
    fn pure_insert_keeps_position() {
        let (left, right) = inline_char_markers("hello", "hello world");
        assert_eq!(left, "hello");
        assert_eq!(right, format!("hello{}", i(" world")));
    }

    #[test]
    fn pure_delete_keeps_position() {
        let (left, right) = inline_char_markers("hello world", "hello");
        assert_eq!(left, format!("hello{}", d(" world")));
        assert_eq!(right, "hello");
    }

    #[test]
    fn equal_strings_emit_no_markers() {
        let (left, right) = inline_char_markers("abc", "abc");
        assert_eq!(left, "abc");
        assert_eq!(right, "abc");
    }

    #[test]
    fn same_length_multiple_changes_align_position_by_position() {
        let (left, right) = inline_char_markers("1111111111121112", "1111111111111111");
        assert_eq!(left, format!("11111111111{}111{}", d("2"), d("2")));
        assert_eq!(right, format!("11111111111{}111{}", i("1"), i("1")));
    }

    #[test]
    fn same_length_contiguous_changes_coalesce_into_one_marker() {
        let (left, right) = inline_char_markers("abcdef", "axydef");
        assert_eq!(left, format!("a{}def", d("bc")));
        assert_eq!(right, format!("a{}def", i("xy")));
    }

    #[test]
    fn same_length_no_changes_passes_through() {
        let (left, right) = inline_char_markers("abcdef", "abcdef");
        assert_eq!(left, "abcdef");
        assert_eq!(right, "abcdef");
    }

    #[test]
    fn same_length_handles_unicode_chars() {
        let (left, right) = inline_char_markers("abéf", "abèf");
        assert_eq!(left, format!("ab{}f", d("é")));
        assert_eq!(right, format!("ab{}f", i("è")));
    }

    #[test]
    fn html_like_content_does_not_collide_with_markers() {
        // The exact failure case we switched to PUA chars to prevent: comparing
        // two strings containing `<del>` as literal content should produce
        // markers that the frontend can still distinguish from the source.
        let (left, right) = inline_char_markers("a<del>x</del>b", "a<del>y</del>b");
        // The single-char change is the x→y substitution. Markers wrap just
        // that change; the literal `<del>` content stays bare and is NOT
        // mistaken for an open tag.
        assert_eq!(left, format!("a<del>{}</del>b", d("x")));
        assert_eq!(right, format!("a<del>{}</del>b", i("y")));
    }

    #[test]
    fn reconstruction_matches_inputs() {
        let cases = [
            ("hello world", "goodbye world"),
            ("1111111111112111", "1111111111111111"),
            ("abc123def", "abc456def"),
            ("the quick brown fox", "the slow brown cat"),
            ("a<del>x</del>b", "a<del>y</del>b"),
        ];
        for (a, b) in cases {
            let (left, right) = inline_char_markers(a, b);
            let a_stripped: String = left
                .replace(MARK_DEL_OPEN, "")
                .replace(MARK_DEL_CLOSE, "");
            let b_stripped: String = right
                .replace(MARK_INS_OPEN, "")
                .replace(MARK_INS_CLOSE, "");
            assert_eq!(a_stripped, a, "left side must reconstruct A");
            assert_eq!(b_stripped, b, "right side must reconstruct B");
        }
    }
}

// Intra-line marker delimiters. We use Private Use Area codepoints rather
// than HTML-looking tags like `<del>` / `<ins>` so the markers can never
// collide with literal content of a compared file — comparing two HTML or
// XML files with `<del>` in their source would otherwise confuse the
// frontend's regex. The frontend ships the same four constants; keep them
// in sync (see DiffCompareModal.tsx `MARK_*`).
const MARK_DEL_OPEN: &str = "\u{E000}";
const MARK_DEL_CLOSE: &str = "\u{E001}";
const MARK_INS_OPEN: &str = "\u{E002}";
const MARK_INS_CLOSE: &str = "\u{E003}";

fn inline_char_markers(a: &str, b: &str) -> (String, String) {
    use similar::{ChangeTag, TextDiff};

    // FAST PATH: when A and B have the same character count, every difference
    // is a pure SUBSTITUTION at a specific position. Position-by-position diff
    // gives guaranteed-aligned highlights — no Myers, no ambiguity. Covers the
    // common case of "config file with one or more values swapped",
    // "ID list with a few chars changed", etc.
    let a_chars: Vec<&str> = split_chars(a);
    let b_chars: Vec<&str> = split_chars(b);
    if a_chars.len() == b_chars.len() {
        let mut out_a = String::new();
        let mut out_b = String::new();
        let mut in_diff_run = false;
        for (ca, cb) in a_chars.iter().zip(b_chars.iter()) {
            let differ = ca != cb;
            if differ && !in_diff_run {
                out_a.push_str(MARK_DEL_OPEN);
                out_b.push_str(MARK_INS_OPEN);
                in_diff_run = true;
            } else if !differ && in_diff_run {
                out_a.push_str(MARK_DEL_CLOSE);
                out_b.push_str(MARK_INS_CLOSE);
                in_diff_run = false;
            }
            out_a.push_str(ca);
            out_b.push_str(cb);
        }
        if in_diff_run {
            out_a.push_str(MARK_DEL_CLOSE);
            out_b.push_str(MARK_INS_CLOSE);
        }
        return (out_a, out_b);
    }

    // SLOW PATH: different lengths → fall back to Myers with the swap heuristic.
    let char_diff = TextDiff::from_chars(a, b);

    // Step 1: coalesce raw per-char changes into runs by tag.
    let mut runs: Vec<(ChangeTag, String)> = Vec::new();
    for ch in char_diff.iter_all_changes() {
        if let Some(last) = runs.last_mut() {
            if last.0 == ch.tag() {
                last.1.push_str(ch.value());
                continue;
            }
        }
        runs.push((ch.tag(), ch.value().to_string()));
    }

    // Step 2: align swap. Pattern Del-Equal-Ins → Del-Ins-Equal. Safe because:
    //   - A reconstructs identically (Equal contributes to both sides, swap
    //     doesn't move A-side chars).
    //   - B reconstructs identically when the ins content sits adjacent to the
    //     del position rather than after the equal — the final B string is the
    //     same; only the LOGICAL position of the insert markers moves.
    // We iterate in a single pass; each swap consumes the triplet, so the next
    // candidate starts after it.
    let mut i = 0;
    while i + 2 < runs.len() {
        if runs[i].0 == ChangeTag::Delete
            && runs[i + 1].0 == ChangeTag::Equal
            && runs[i + 2].0 == ChangeTag::Insert
        {
            runs.swap(i + 1, i + 2);
            // Skip the new ins (i+1) and equal (i+2); next candidate at i+3.
            i += 3;
        } else {
            i += 1;
        }
    }

    // Step 3: emit aligned runs as marked strings.
    let mut out_a = String::new();
    let mut out_b = String::new();
    for (tag, content) in runs {
        match tag {
            ChangeTag::Equal => {
                out_a.push_str(&content);
                out_b.push_str(&content);
            }
            ChangeTag::Delete => {
                out_a.push_str(MARK_DEL_OPEN);
                out_a.push_str(&content);
                out_a.push_str(MARK_DEL_CLOSE);
            }
            ChangeTag::Insert => {
                out_b.push_str(MARK_INS_OPEN);
                out_b.push_str(&content);
                out_b.push_str(MARK_INS_CLOSE);
            }
        }
    }
    (out_a, out_b)
}

/// Read a line range from a text file, normalizing line endings to LF first
/// so the indexing matches what `diff_files` exposed to the frontend. Used
/// by the diff modal's "expand context" button to fetch additional equal
/// rows around hunks without recomputing the whole diff.
///
/// `start_line` is 1-based. Empty Vec is returned for out-of-range starts
/// or when `count == 0`. Capped at 200 lines per call to keep payloads
/// bounded — the frontend can call repeatedly if more is needed.
#[tauri::command]
pub fn get_text_lines(path: String, start_line: usize, count: usize) -> Result<Vec<String>, String> {
    const MAX_BYTES: u64 = 20 * 1024 * 1024;
    const MAX_LINES_PER_CALL: usize = 200;
    let meta = std::fs::metadata(&path).map_err(|e| format!("Cannot stat {}: {}", path, e))?;
    if meta.len() > MAX_BYTES {
        return Err(format!("File too large for line read (>{}MB)", MAX_BYTES / 1024 / 1024));
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read {} as text: {}", path, e))?;
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.lines().collect();
    let start_idx = start_line.saturating_sub(1);
    if start_idx >= lines.len() || count == 0 {
        return Ok(Vec::new());
    }
    let take = count.min(MAX_LINES_PER_CALL);
    let end_idx = (start_idx + take).min(lines.len());
    Ok(lines[start_idx..end_idx].iter().map(|s| s.to_string()).collect())
}

#[tauri::command]
pub fn read_file_full(path: String, state: tauri::State<AppState>) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 10 * 1024 * 1024 {
        return Err("File too large to edit (>10 MB)".to_string());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if let Ok(db) = state.db.lock() {
        let name = std::path::Path::new(&path).file_name().and_then(|n| n.to_str()).unwrap_or("");
        log_activity(&db, &path, name, "opened");
    }
    Ok(content)
}

#[tauri::command]
pub fn write_file(path: String, content: String, state: tauri::State<AppState>) -> Result<(), String> {
    std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
    if let Ok(db) = state.db.lock() {
        let name = std::path::Path::new(&path).file_name().and_then(|n| n.to_str()).unwrap_or("");
        log_activity(&db, &path, name, "modified");
    }
    Ok(())
}

/// Upsert a single file into the index and return its DB id.
/// Returns Err("is_directory") when the path points to a directory — callers
/// should use add_tag_to_folder instead.
#[tauri::command]
pub fn index_file_by_path(path: String, state: tauri::State<AppState>) -> Result<i64, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("is_directory".to_string());
    }
    use std::time::UNIX_EPOCH;
    let ts = |t: std::io::Result<std::time::SystemTime>| {
        t.ok().map(|s| s.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64).unwrap_or(0)
    };
    let name = std::path::Path::new(&path)
        .file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let ext = std::path::Path::new(&path)
        .extension().and_then(|e| e.to_str()).unwrap_or("").to_string();
    let size = meta.len() as i64;
    let created_at  = ts(meta.created());
    let modified_at = ts(meta.modified());
    let accessed_at = ts(meta.accessed());

    // Extract text before acquiring DB lock
    let text_content = extract_text_content(&path, &ext, size);

    let db = state.db.lock().map_err(|e| e.to_string())?;
    let id = upsert_file(&db, &path, &name, &ext, size, created_at, modified_at, accessed_at)
        .map_err(|e| e.to_string())?;
    if !text_content.is_empty() {
        store_text_content(&db, id, &text_content);
    }
    Ok(id)
}

#[tauri::command]
pub fn get_home_dir() -> String {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| "C:\\Users".to_string())
}

/// Extract and return a text preview (up to 500 chars) of a single file.
/// Works for PDFs, DOCX, XLSX, PPTX, text files, and code.
/// Result is cached in file_content for future search_files hits.
/// Stats for the indexing progress of a directory (recursive).
/// Returns (total_files, attempted_files) — files we have already tried to index.
/// "Attempted" counts both successful extractions AND files where extraction returned
/// nothing (scanned PDFs, binary files). This matches the user's mental model:
/// "have we looked at this file yet?" — not "did we find text in it".
#[tauri::command]
pub async fn get_indexing_stats(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<(i64, i64), String> {
    // Run on the blocking pool so the std::sync::Mutex doesn't pin a tokio runtime thread
    // — important because this command is called repeatedly while indexing is in progress.
    let db_arc = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let db = db_arc.lock().map_err(|e| e.to_string())?;
        let total: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM files WHERE path LIKE ?1 || '%'",
                rusqlite::params![&path],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let attempted: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM files f
                 JOIN file_content fc ON fc.file_id = f.id
                 WHERE f.path LIKE ?1 || '%'",
                rusqlite::params![&path],
                |row| row.get(0),
            )
            .unwrap_or(0);
        Ok((total, attempted))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Max PDF size for AUTOMATIC bulk indexing.
/// Kept aggressive (3 MB) because pdf-extract is slow (~5-30s per file) and unreliable.
/// PDFs above this cap are marked as "attempted" without extraction so they don't
/// block the progress badge. The user can pull them in via the manual reindex button
/// (which uses a higher cap), and the AI can always call preview_file on any file size.
const MAX_PDF_BYTES: i64 = 3 * 1024 * 1024; // 3 MB

/// Number of files to extract in parallel via spawn_blocking. pdf-extract is fully CPU-bound,
/// so each worker pegs a core. We cap at 2 to leave headroom for the WebView2 UI thread and
/// other tauri commands — otherwise the app feels unresponsive during reindexing.
const PARALLEL_EXTRACTIONS: usize = 2;

/// One row of the indexer's work queue: (file_id, absolute_path, extension, size, was_attempted).
/// `was_attempted` distinguishes brand-new files (false) from rows whose previous extraction
/// returned empty (true, force mode only) — needed for accurate progress accounting.
type UnindexedRow = (i64, String, String, i64, bool);

/// Async background content indexing for all files in a directory tree.
/// Called automatically after adding a folder to a workspace.
/// Extracts text from PDFs, DOCX, XLSX, etc. that were skipped during the initial scan.
/// Stores a sentinel empty row for files where extraction failed or returned nothing,
/// so they are not retried on every relaunch.
/// Persist one batch of extracted text, and — only when semantic search is on —
/// its embeddings.
///
/// Split out so both flush sites share it. The text write is exactly what it was
/// before semantic search existed: one transaction per batch, inside
/// spawn_blocking so the std::sync::Mutex never pins a runtime worker. When
/// `embed` is None the function does nothing else at all.
///
/// Embedding failures are deliberately NOT recorded as attempted. Unlike text
/// extraction — where a failure usually means an unparseable file and a sentinel
/// row rightly stops the retry — an embedding failure usually means Ollama is
/// not running. Writing a sentinel there would permanently skip the file after
/// one transient outage, so we leave it unembedded and pick it up next run.
async fn flush_indexed_batch(
    state: &tauri::State<'_, AppState>,
    batch: Vec<(i64, String)>,
    embed: Option<&crate::commands::embeddings::EmbedConfig>,
) {
    // 1. Text content — unchanged behaviour.
    {
        let db_arc = state.db.clone();
        let to_write = batch.clone();
        tokio::task::spawn_blocking(move || {
            if let Ok(db) = db_arc.lock() {
                let _ = db.execute_batch("BEGIN");
                for (id, text) in &to_write {
                    store_text_content(&db, *id, text);
                }
                let _ = db.execute_batch("COMMIT");
            }
        })
        .await
        .ok();
    }

    // 2. Embeddings — opt-in, best-effort, never fatal.
    let Some(cfg) = embed else { return };

    // Only files that actually produced text are worth embedding; an empty
    // sentinel has nothing to represent and would never match a query.
    let (ids, texts): (Vec<i64>, Vec<String>) = batch
        .into_iter()
        .filter(|(_, t)| !t.trim().is_empty())
        .unzip();
    if ids.is_empty() {
        return;
    }

    let vectors = match crate::commands::embeddings::embed_batch(cfg, &texts).await {
        Ok(v) => v,
        Err(e) => {
            // One line per failed batch, not per file — a stopped Ollama would
            // otherwise flood the console during a large indexing run.
            eprintln!("[embeddings] batch skipped: {}", e);
            return;
        }
    };

    let db_arc = state.db.clone();
    let model = cfg.model.clone();
    tokio::task::spawn_blocking(move || {
        if let Ok(db) = db_arc.lock() {
            let _ = db.execute_batch("BEGIN");
            for (id, vec) in ids.iter().zip(&vectors) {
                let _ = crate::commands::embeddings::store(&db, *id, vec, &model);
            }
            let _ = db.execute_batch("COMMIT");
        }
    })
    .await
    .ok();
}

/// Emits "content-indexed" events so the frontend can show progress.
#[tauri::command]
pub async fn index_directory_content(
    path: String,
    force: Option<bool>,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    use tauri::Emitter;
    let force = force.unwrap_or(false);

    // One indexing run at a time, process-wide.
    //
    // Nothing used to stop N runs overlapping — adding several folders to a
    // workspace, or reindexing a few, started one each. The deliberate limits
    // inside a run (PARALLEL_EXTRACTIONS = 2 workers at below-normal priority,
    // chosen to leave CPU for the UI) then silently became 2xN, and with
    // semantic search on, N concurrent streams of GPU inference on top.
    //
    // This costs almost nothing in throughput: Ollama serializes requests to a
    // loaded model anyway, and every DB write already contends on the single
    // connection mutex. What it removes is accidental parallelism that
    // contradicted the tuning.
    //
    // It QUEUES rather than skipping. Dropping a second run would leave that
    // folder silently unindexed, which is a far worse bug than waiting.
    static INDEX_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _run_guard = INDEX_LOCK.lock().await;

    // Selection rule:
    // - automatic mode (force=false): only files never attempted (no row in file_content)
    // - manual mode  (force=true):    also retry rows with empty content (failed/skipped earlier)
    // Force mode also lifts the PDF size cap below so the user can manually pull in large docs.
    let where_clause = if force {
        "WHERE f.path LIKE ?1 || '%'
           AND f.size > 0
           AND (fc.file_id IS NULL OR fc.text_content = '')"
    } else {
        "WHERE f.path LIKE ?1 || '%'
           AND fc.file_id IS NULL
           AND f.size > 0"
    };
    let query = format!(
        "SELECT f.id, f.path, f.extension, f.size
         FROM files f
         LEFT JOIN file_content fc ON fc.file_id = f.id
         {}",
        where_clause
    );

    // Gather both the queue (unindexed) AND the global counters in the same lock acquisition,
    // so the event payloads we emit during processing use the SAME (total, indexed) semantics
    // as the frontend's `get_indexing_stats` query (total = files in folder, indexed = attempted).
    //
    // We also tag each queue entry with `was_attempted` so the loop knows whether
    // processing it ADDS a new attempted row (was IS NULL → indexed++) or merely
    // updates an existing empty row (already counted in already_attempted → no change).
    // Without this, force mode double-counts retries and overshoots total_files.
    let (unindexed, total_files, already_attempted): (Vec<UnindexedRow>, i64, i64) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;

        let total_files: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM files WHERE path LIKE ?1 || '%'",
                rusqlite::params![&path],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let already_attempted: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM files f
                 JOIN file_content fc ON fc.file_id = f.id
                 WHERE f.path LIKE ?1 || '%'",
                rusqlite::params![&path],
                |row| row.get(0),
            )
            .unwrap_or(0);

        // Append fc.file_id IS NOT NULL to the SELECT so we know per row whether it
        // was already attempted (retry case in force mode) or genuinely new.
        let select_with_flag = query.replace(
            "SELECT f.id, f.path, f.extension, f.size",
            "SELECT f.id, f.path, f.extension, f.size, fc.file_id IS NOT NULL",
        );
        let queue: Vec<UnindexedRow> = db
            .prepare(&select_with_flag)
            .and_then(|mut stmt| {
                stmt.query_map([&path], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)? != 0,
                    ))
                })
                .map(|iter| iter.filter_map(|r| r.ok()).collect::<Vec<_>>())
            })
            .unwrap_or_default();

        (queue, total_files, already_attempted)
    };

    // Belt-and-braces vault exclusion. `scan_directory` already prunes vault
    // subtrees so their files should never have reached the `files` table —
    // but rows can predate the folder becoming a vault (the user encrypts a
    // folder that was already indexed). Re-extracting those would write vault
    // plaintext into `file_content` + FTS5. Filter the work queue, and let the
    // stale rows be cleaned up when the vault-creation flow purges them.
    let unindexed: Vec<UnindexedRow> = unindexed
        .into_iter()
        .filter(|(_, p, _, _, _)| {
            !crate::vault::format::path_is_in_vault(std::path::Path::new(p))
        })
        .collect();

    if unindexed.is_empty() {
        return Ok(0);
    }

    // Resolve OCR once per run (settings read + tesseract probe), NOT per file.
    // Arc because each spawn_blocking closure needs its own handle. None =
    // feature off or no Tesseract — extraction behaves exactly as before.
    let ocr_cfg: std::sync::Arc<Option<crate::commands::ocr::OcrConfig>> = {
        let nxs_tessdata = crate::commands::ocr::app_tessdata_dir(&app);
        let cfg = state
            .db
            .lock()
            .ok()
            .and_then(|db| crate::commands::ocr::load_ocr_config(&db, nxs_tessdata.as_deref()));
        std::sync::Arc::new(cfg)
    };

    // Resolve semantic-search config once per run, same as OCR above. None =
    // feature off or unconfigured, in which case NOTHING below changes: the
    // indexing path stays byte-for-byte what it was before this feature.
    let embed_cfg = state
        .db
        .lock()
        .ok()
        .and_then(|db| crate::commands::embeddings::load_config(&db));

    // Event payloads use the GLOBAL (folder-wide) numbers so they line up with
    // get_indexing_stats. `indexed` here starts at the existing attempted count
    // and grows as we process files. `total` stays constant = files in folder.
    let total = total_files as usize;
    let mut indexed = already_attempted as usize;

    // Hard cap on PDF size to keep individual extractions bounded.
    // 10 MB in auto mode, 25 MB in force mode — beyond that we never try to extract,
    // even in force mode, because a 40 MB PDF can take minutes and pdf-extract is
    // not interruptible. The user can still query content via the AI's preview_file.
    let pdf_cap = if force { 25 * 1024 * 1024 } else { MAX_PDF_BYTES };

    // Hard timeout per file. If pdf-extract hangs on a malformed file, we drop our
    // join handle after this duration and move on. The orphaned thread keeps running
    // in tokio's blocking pool (capped at 512 threads), but app responsiveness is preserved.
    const PER_FILE_TIMEOUT: tokio::time::Duration = tokio::time::Duration::from_secs(30);

    // DB write buffer — accumulates (file_id, text) pairs across multiple chunks
    // and gets flushed as a single transaction. Significantly reduces per-row
    // overhead (mutex acquisition + fsync via implicit transactions).
    let mut write_buffer: Vec<(i64, String)> = Vec::with_capacity(32);

    // Process in chunks. Each file gets its own join handle so we can apply a timeout
    // per file. Even if one extraction hangs, we never stall the whole pipeline.
    for chunk in unindexed.chunks(PARALLEL_EXTRACTIONS) {
        // (id, path, was_attempted, JoinHandle<text>) — was_attempted is needed
        // when draining results to decide whether to increment the `indexed` counter.
        let mut handles: Vec<(i64, String, bool, tokio::task::JoinHandle<String>)> =
            Vec::with_capacity(chunk.len());
        for (id, file_path, ext, size, was_attempted) in chunk {
            let id = *id;
            let file_path_owned = file_path.clone();
            let ext = ext.clone();
            let size = *size;
            let was_attempted = *was_attempted;
            let path_for_task = file_path_owned.clone();
            let ocr_for_task = ocr_cfg.clone();
            let handle = tokio::task::spawn_blocking(move || {
                // Lower priority on Windows so we don't starve the UI thread.
                #[cfg(windows)]
                unsafe {
                    use windows::Win32::System::Threading::{
                        GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
                    };
                    let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
                }
                if ext.eq_ignore_ascii_case("pdf") && size > pdf_cap {
                    return String::new();
                }
                extract_text_with_ocr(&path_for_task, &ext, size, ocr_for_task.as_ref().as_ref())
            });
            handles.push((id, file_path_owned, was_attempted, handle));
        }

        // Drain results sequentially with per-file timeout. We accumulate results
        // into a write_buffer and flush them to the DB in ONE transaction every
        // FLUSH_AT_N items. This collapses N mutex acquisitions + N implicit
        // transactions into a single BEGIN/COMMIT — ~10x faster DB throughput
        // on bulk indexing. UI progress is still emitted per file, so the user
        // sees movement continuously even though the DB write lags by < FLUSH_AT_N rows.
        const FLUSH_AT_N: usize = 20;
        for (file_id, file_path, was_attempted, handle) in handles {
            let file_name = std::path::Path::new(&file_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            // Emit "starting file X" so the popover updates the current filename right away.
            let _ = app.emit("content-indexed", serde_json::json!({
                "indexed": indexed,
                "total": total,
                "current": file_name,
                "done": false,
            }));

            let text = match tokio::time::timeout(PER_FILE_TIMEOUT, handle).await {
                Ok(Ok(text)) => text,
                _ => String::new(),
            };

            write_buffer.push((file_id, text));
            if write_buffer.len() >= FLUSH_AT_N {
                let to_write = std::mem::take(&mut write_buffer);
                flush_indexed_batch(&state, to_write, embed_cfg.as_ref()).await;
            }

            // Only count this file as a NEW attempt if it wasn't already attempted before.
            // Retried empty rows (force mode) don't change the DB's COUNT(*) of attempted
            // rows — incrementing here would overshoot total_files and produce e.g. 103%.
            if !was_attempted {
                indexed += 1;
            }

            // Emit "completed" so Processed / Remaining counters advance immediately.
            let _ = app.emit("content-indexed", serde_json::json!({
                "indexed": indexed,
                "total": total,
                "done": false,
            }));
        }

        // Yield between chunks.
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    }

    // Final flush of any remaining buffered writes.
    if !write_buffer.is_empty() {
        let to_write = std::mem::take(&mut write_buffer);
        flush_indexed_batch(&state, to_write, embed_cfg.as_ref()).await;
    }

    let _ = app.emit("content-indexed", serde_json::json!({
        "indexed": indexed,
        "total": total,
        "done": true,
    }));

    Ok(indexed)
}

#[tauri::command]
pub fn preview_file(path: String, state: tauri::State<AppState>) -> String {
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(_) => return format!("Cannot access: {}", path),
    };
    let size = meta.len() as i64;
    let ext = std::path::Path::new(&path)
        .extension().and_then(|e| e.to_str()).unwrap_or("").to_string();

    // Check cache first
    {
        let db_result = state.db.lock().ok().and_then(|db| {
            db.query_row(
                "SELECT fc.text_content FROM file_content fc
                 JOIN files f ON f.id = fc.file_id
                 WHERE f.path = ?1",
                rusqlite::params![&path],
                |row| row.get::<_, String>(0),
            ).ok()
        });
        if let Some(text) = db_result.filter(|s| !s.is_empty()) {
            return text.chars().take(500).collect();
        }
    }

    // Extract on demand (outside DB lock)
    let text = extract_text_content(&path, &ext, size);

    // Cache the result
    if !text.is_empty() {
        if let Ok(db) = state.db.lock() {
            if let Ok(id) = db.query_row(
                "SELECT id FROM files WHERE path = ?1",
                rusqlite::params![&path],
                |r| r.get::<_, i64>(0),
            ) {
                store_text_content(&db, id, &text);
            }
        }
        text.chars().take(500).collect()
    } else {
        "(no readable text content in this file)".to_string()
    }
}

/// Return text snippets for files directly inside `dir`, with pagination.
/// - `offset`: skip this many files (default 0)
/// - `limit`: return at most this many snippets (capped at 50)
/// Files are extracted on-demand (on-disk read outside the DB lock) and cached.
/// Files larger than 5 MB are skipped for on-demand extraction to avoid hangs.
#[tauri::command]
pub fn get_file_snippets(
    dir: String,
    offset: Option<usize>,
    limit: Option<usize>,
    state: tauri::State<AppState>,
) -> Result<crate::models::FileSnippetsPage, String> {
    const MAX_ON_DEMAND_BYTES: i64 = 5 * 1024 * 1024; // 5 MB — skip larger files live
    const PAGE_CAP: usize = 50;

    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(PAGE_CAP).min(PAGE_CAP);

    let prefix = {
        let d = dir.trim_end_matches(['\\', '/']);
        format!("{}\\", d)
    };

    // Phase 1 — all direct children from DB (with existing content if any)
    let all_rows: Vec<(i64, String, String, String, i64, Option<String>)> = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.prepare(
            "SELECT f.id, f.path, f.name, f.extension, f.size, fc.text_content
             FROM files f
             LEFT JOIN file_content fc ON fc.file_id = f.id
             WHERE f.path LIKE ?1 || '%'",
        )
        .and_then(|mut stmt| {
            stmt.query_map([&prefix], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            })
            .map(|iter| {
                iter.filter_map(|r| r.ok())
                    .filter(|(_, path, _, _, _, _)| {
                        let suffix = path.strip_prefix(&*prefix).unwrap_or(path.as_str());
                        !suffix.contains('\\') && !suffix.contains('/')
                    })
                    .collect::<Vec<_>>()
            })
        })
        .unwrap_or_default()
    }; // DB lock released

    let total = all_rows.len();
    let page_rows: Vec<_> = all_rows.into_iter().skip(offset).take(limit).collect();

    // Split into already-indexed and needs-extraction
    let mut have: Vec<crate::models::FileSnippet> = Vec::new();
    let mut need: Vec<(i64, String, String, i64)> = Vec::new();
    for (id, path, name, ext, size, content) in page_rows {
        match content.filter(|s| !s.is_empty()) {
            Some(text) => have.push(crate::models::FileSnippet {
                path, name,
                snippet: text.chars().take(200).collect(),
            }),
            None => {
                // Skip very large files for on-demand extraction
                if size <= MAX_ON_DEMAND_BYTES {
                    need.push((id, path, ext, size));
                }
                // else: silently skip — too large to extract live
            }
        }
    }

    // Phase 2 — extract text from disk without DB lock
    let freshly_extracted: Vec<(i64, String, String, String)> = need
        .iter()
        .filter_map(|(id, path, ext, size)| {
            let text = extract_text_content(path, ext, *size);
            if text.is_empty() { return None; }
            let name = std::path::Path::new(path)
                .file_name().and_then(|n| n.to_str())
                .unwrap_or(path.as_str()).to_string();
            Some((*id, path.clone(), name, text))
        })
        .collect();

    // Phase 3 — store and build result
    let mut new_snippets: Vec<crate::models::FileSnippet> = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        freshly_extracted.iter().map(|(id, path, name, text)| {
            store_text_content(&db, *id, text);
            crate::models::FileSnippet {
                path: path.clone(),
                name: name.clone(),
                snippet: text.chars().take(200).collect(),
            }
        }).collect()
    };

    have.append(&mut new_snippets);

    Ok(crate::models::FileSnippetsPage {
        snippets: have,
        total,
        offset,
        has_more: offset + limit < total,
    })
}

// NOTE: the former `copy_with_progress` command lived here. It was superseded
// by the transfer engine in fs_ops.rs (`copy_path` / `move_path` now emit real
// byte-level progress from a spawn_blocking worker, with cancellation). It had
// no frontend callers and its directory branch only emitted fake 0/1 progress.
