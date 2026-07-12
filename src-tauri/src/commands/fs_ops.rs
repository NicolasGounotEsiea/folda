use std::path::Path;
use std::time::UNIX_EPOCH;
use crate::AppState;
use crate::commands::files::{auto_tag_for_ext, ensure_auto_tag};

fn human_io_error(e: std::io::Error) -> String {
    match e.raw_os_error() {
        Some(5)   => "Permission denied".to_string(),
        Some(32)  => "File is in use by another application".to_string(),
        Some(2)   => "File not found".to_string(),
        Some(3)   => "Path not found".to_string(),
        Some(112) => "Disk is full".to_string(),
        Some(183) => "A file with that name already exists".to_string(),
        Some(17)  => "Cannot move between drives (cross-device)".to_string(),
        _         => e.to_string(),
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

#[tauri::command]
pub fn rename_path(
    old_path: String, new_path: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    std::fs::rename(&old_path, &new_path).map_err(|e| e.to_string())?;
    if let Ok(db) = state.db.lock() {
        let new_name = Path::new(&new_path)
            .file_name().and_then(|n| n.to_str()).unwrap_or("");
        log_activity(&db, &new_path, new_name, "renamed");
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_path(
    path: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    use tauri::Emitter;
    let file_name = Path::new(&path)
        .file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    if let Ok(db) = state.db.lock() {
        log_activity(&db, &path, &file_name, "deleted");
    }
    let p = Path::new(&path);
    if p.is_dir() {
        // Count items so the UI can show a progress bar for large directories
        let total = walkdir::WalkDir::new(p)
            .into_iter()
            .filter_map(|e| e.ok())
            .count() as u64;
        if total > 50 {
            let _ = app.emit("delete-progress", serde_json::json!({
                "name": file_name, "done": 0u64, "total": total, "finished": false
            }));
        }
        std::fs::remove_dir_all(p).map_err(human_io_error)?;
        if total > 50 {
            let _ = app.emit("delete-progress", serde_json::json!({
                "name": file_name, "done": total, "total": total, "finished": true
            }));
        }
    } else {
        std::fs::remove_file(p).map_err(human_io_error)?;
    }
    Ok(())
}

fn unique_dst(dst: &Path) -> std::path::PathBuf {
    if !dst.exists() {
        return dst.to_path_buf();
    }
    let stem = dst.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = dst.extension().and_then(|e| e.to_str()).unwrap_or("");
    let parent = dst.parent().unwrap_or(Path::new("."));
    let mut i = 1u32;
    loop {
        let name = if ext.is_empty() {
            format!("{} ({})", stem, i)
        } else {
            format!("{} ({}).{}", stem, i, ext)
        };
        let candidate = parent.join(&name);
        if !candidate.exists() {
            return candidate;
        }
        i += 1;
    }
}

// ── Transfer engine ───────────────────────────────────────────────────────────
//
// One shared engine behind BOTH `copy_path` and `move_path`'s cross-device
// fallback. Fixes two real user-facing problems the old code had:
//
//   1. **Whole-window freeze.** `copy_path` was a SYNC command — in Tauri 2,
//      sync commands run on the MAIN thread, so copying a big folder blocked
//      the entire event loop (no repaint, no input) until it finished. All
//      work now runs inside `spawn_blocking`.
//   2. **No real progress for directories.** Dir copies emitted a fake
//      0/1 → 1/1. The engine now pre-scans the tree (stat-only walk, fast)
//      to get the total byte count, then streams every file with throttled
//      byte-level progress events the existing `ProgressOverlay` renders.
//
// Cancellation: the frontend passes an optional `transfer_id`; `cancel_transfer`
// flips the matching AtomicBool. The engine checks it between chunks/files.
// On cancel the PARTIAL DESTINATION is deleted (all-or-nothing semantics) and
// the source is never touched — a cancelled move loses nothing.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Instant;

static TRANSFER_CANCELS: OnceLock<StdMutex<HashMap<u64, Arc<AtomicBool>>>> = OnceLock::new();

fn cancels() -> &'static StdMutex<HashMap<u64, Arc<AtomicBool>>> {
    TRANSFER_CANCELS.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn register_cancel_flag(id: Option<u64>) -> Option<Arc<AtomicBool>> {
    let id = id?;
    let flag = Arc::new(AtomicBool::new(false));
    cancels().lock().unwrap().insert(id, flag.clone());
    Some(flag)
}

fn clear_cancel_flag(id: Option<u64>) {
    if let Some(id) = id {
        cancels().lock().unwrap().remove(&id);
    }
}

/// Flip the cancel flag for an in-flight transfer. Sync + trivial (a map
/// lookup), safe on the main thread. Unknown ids are a no-op — the transfer
/// may have already finished.
#[tauri::command]
pub fn cancel_transfer(id: u64) {
    if let Some(flag) = cancels().lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Throttled progress emitter. At most one event per 100 ms (plus the final
/// one) — an unthrottled 256 KB-chunk loop on a 2 GB file would emit ~8000
/// events and hammer the webview's event bridge.
struct ProgressEmitter {
    app: tauri::AppHandle,
    event: &'static str,
    id: Option<u64>,
    name: String,
    total: u64,
    done: u64,
    last_emit: Instant,
}

impl ProgressEmitter {
    fn new(app: tauri::AppHandle, event: &'static str, id: Option<u64>, name: String, total: u64) -> Self {
        let mut em = Self { app, event, id, name, total, done: 0, last_emit: Instant::now() };
        em.emit(false); // initial event so the overlay card appears at 0% immediately
        em
    }

    fn add(&mut self, bytes: u64) {
        self.done += bytes;
        if self.last_emit.elapsed().as_millis() >= 100 {
            self.emit(false);
            self.last_emit = Instant::now();
        }
    }

    fn emit(&mut self, finished: bool) {
        use tauri::Emitter;
        let _ = self.app.emit(self.event, serde_json::json!({
            "id": self.id,
            "name": self.name,
            "done": self.done,
            "total": self.total,
            "finished": finished,
        }));
    }

    fn finish(&mut self) {
        self.done = self.total;
        self.emit(true);
    }
}

/// Total byte size of a file or directory tree. Stat-only walk — cheap even
/// on tens of thousands of files, and it's what makes the progress bar
/// meaningful instead of the old fake 0/1.
fn scan_total_bytes(path: &Path) -> u64 {
    if path.is_dir() {
        walkdir::WalkDir::new(path)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter_map(|e| e.metadata().ok())
            .map(|m| m.len())
            .sum()
    } else {
        std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
    }
}

fn check_cancel(cancel: &Option<Arc<AtomicBool>>) -> Result<(), String> {
    if cancel.as_ref().is_some_and(|f| f.load(Ordering::Relaxed)) {
        return Err("cancelled".to_string());
    }
    Ok(())
}

fn copy_file_streamed(
    src: &Path,
    dst: &Path,
    em: &mut ProgressEmitter,
    cancel: &Option<Arc<AtomicBool>>,
) -> Result<(), String> {
    use std::io::{Read, Write};
    let mut src_file = std::fs::File::open(src).map_err(human_io_error)?;
    let mut dst_file = std::fs::File::create(dst).map_err(human_io_error)?;
    let mut buf = vec![0u8; 1024 * 1024]; // 1 MiB — fewer syscalls than 256 KB, still responsive cancel
    loop {
        check_cancel(cancel)?;
        let n = src_file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        dst_file.write_all(&buf[..n]).map_err(human_io_error)?;
        em.add(n as u64);
    }
    Ok(())
}

fn copy_tree_streamed(
    src: &Path,
    dst: &Path,
    em: &mut ProgressEmitter,
    cancel: &Option<Arc<AtomicBool>>,
) -> Result<(), String> {
    if src.is_dir() {
        std::fs::create_dir_all(dst).map_err(human_io_error)?;
        for entry in std::fs::read_dir(src).map_err(human_io_error)? {
            check_cancel(cancel)?;
            let entry = entry.map_err(|e| e.to_string())?;
            copy_tree_streamed(&entry.path(), &dst.join(entry.file_name()), em, cancel)?;
        }
        Ok(())
    } else {
        copy_file_streamed(src, dst, em, cancel)
    }
}

/// Plain recursive copy without progress/cancel — kept for `duplicate_file`,
/// which duplicates in place (same folder, typically small) and doesn't need
/// the full transfer engine.
fn copy_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if src.is_dir() {
        std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else {
        std::fs::copy(src, dst).map(|_| ()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Best-effort removal of a partially-written destination after cancel/error.
/// All-or-nothing: the user never finds a half-copied tree they'd mistake for
/// the real thing.
fn cleanup_partial(dst: &Path) {
    if dst.is_dir() {
        let _ = std::fs::remove_dir_all(dst);
    } else {
        let _ = std::fs::remove_file(dst);
    }
}

/// Blocking body shared by copy_path and move_path's cross-device fallback.
/// Runs inside spawn_blocking. Returns the final destination path.
fn transfer_blocking(
    src: String,
    dst_dir: String,
    transfer_id: Option<u64>,
    app: tauri::AppHandle,
    event: &'static str,
    delete_src_after: bool,
) -> Result<String, String> {
    let src_path = Path::new(&src);
    let file_name = src_path.file_name().ok_or("Invalid source path")?;
    let name = file_name.to_string_lossy().to_string();
    let dst = unique_dst(&Path::new(&dst_dir).join(file_name));

    let total = scan_total_bytes(src_path);
    let cancel = register_cancel_flag(transfer_id);
    let mut em = ProgressEmitter::new(app, event, transfer_id, name, total);

    let result = copy_tree_streamed(src_path, &dst, &mut em, &cancel);
    clear_cancel_flag(transfer_id);

    match result {
        Ok(()) => {
            // finish() BEFORE the source delete: if the delete fails (source
            // file locked by another app — common on Windows), the `?` below
            // would otherwise return before finished:true is ever emitted and
            // the overlay card would be stuck on screen forever. The copy IS
            // complete at this point, so "done" is accurate; the delete error
            // still propagates to the caller's toast.
            em.finish();
            if delete_src_after {
                // Move: source removed only after a FULLY successful copy —
                // a failure or cancel anywhere leaves the source intact.
                if src_path.is_dir() {
                    std::fs::remove_dir_all(src_path).map_err(human_io_error)?;
                } else {
                    std::fs::remove_file(src_path).map_err(human_io_error)?;
                }
            }
            Ok(dst.to_string_lossy().to_string())
        }
        Err(e) => {
            cleanup_partial(&dst);
            em.finish(); // clears the overlay card
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn copy_path(
    src: String,
    dst_dir: String,
    transfer_id: Option<u64>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let dst_str = tokio::task::spawn_blocking(move || {
        transfer_blocking(src, dst_dir, transfer_id, app, "copy-progress", false)
    })
    .await
    .map_err(|e| e.to_string())??;

    if let Ok(db) = state.db.lock() {
        let name = Path::new(&dst_str)
            .file_name().and_then(|n| n.to_str()).unwrap_or("");
        log_activity(&db, &dst_str, name, "created");
    }
    Ok(dst_str)
}

#[tauri::command]
pub async fn move_path(
    src: String,
    dst_dir: String,
    transfer_id: Option<u64>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let src_path = Path::new(&src);
    let file_name = src_path.file_name().ok_or("Invalid source path")?;
    let dst = unique_dst(&Path::new(&dst_dir).join(file_name));

    let dst_str = match std::fs::rename(&src, &dst) {
        // Same-device rename: instant, no progress needed.
        Ok(_) => dst.to_string_lossy().to_string(),
        Err(e) => {
            let is_cross_device = e.kind() == std::io::ErrorKind::CrossesDevices
                || e.raw_os_error() == Some(17);
            if !is_cross_device {
                return Err(human_io_error(e));
            }
            // Cross-device: streamed copy with real progress, then delete source.
            tokio::task::spawn_blocking(move || {
                transfer_blocking(src, dst_dir, transfer_id, app, "move-progress", true)
            })
            .await
            .map_err(|e| e.to_string())??
        }
    };

    if let Ok(db) = state.db.lock() {
        let n = Path::new(&dst_str)
            .file_name().and_then(|n| n.to_str()).unwrap_or("");
        log_activity(&db, &dst_str, n, "renamed");
    }
    Ok(dst_str)
}

#[tauri::command]
pub fn create_file(dir: String, name: String, state: tauri::State<AppState>) -> Result<String, String> {
    // Build path entirely in Rust — guaranteed OS-native separators, no frontend conversion needed
    let full_path = Path::new(&dir).join(&name);
    if let Some(parent) = full_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::File::create(&full_path).map_err(|e| e.to_string())?;

    let path_str = full_path.to_string_lossy().to_string();
    let ext = full_path.extension().and_then(|e| e.to_str()).unwrap_or("");

    if let Ok(db) = state.db.lock() {
        let ts_secs = |t: std::io::Result<std::time::SystemTime>| {
            t.ok().map(|s| s.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64).unwrap_or(0)
        };
        let (created_at, modified_at, accessed_at) = std::fs::metadata(&full_path)
            .map(|m| (ts_secs(m.created()), ts_secs(m.modified()), ts_secs(m.accessed())))
            .unwrap_or((0, 0, 0));

        let file_id: Option<i64> = db.execute(
            "INSERT INTO files (path, name, extension, size, created_at, modified_at, accessed_at)
             VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6)
             ON CONFLICT(path) DO UPDATE SET
               name=excluded.name, extension=excluded.extension,
               modified_at=excluded.modified_at, accessed_at=excluded.accessed_at",
            rusqlite::params![path_str, name, ext, created_at, modified_at, accessed_at],
        ).ok().and_then(|_| {
            db.query_row("SELECT id FROM files WHERE path = ?1", [&path_str], |r| r.get(0)).ok()
        });

        if let (Some(file_id), Some((tag_name, tag_color))) = (file_id, auto_tag_for_ext(ext)) {
            if let Ok(tag_id) = ensure_auto_tag(&db, tag_name, tag_color) {
                let _ = db.execute(
                    "INSERT OR IGNORE INTO file_tags (file_id, tag_id, context_id) VALUES (?1, ?2, 0)",
                    rusqlite::params![file_id, tag_id],
                );
            }
        }

        log_activity(&db, &path_str, &name, "created");
    }
    Ok(path_str) // return actual path so frontend can use it if needed
}

#[tauri::command]
pub fn duplicate_file(path: String, state: tauri::State<AppState>) -> Result<String, String> {
    let src = Path::new(&path);
    let parent = src.parent().ok_or("No parent directory")?;
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("");
    let mut i = 1u32;
    loop {
        let name = if ext.is_empty() {
            format!("{} ({})", stem, i)
        } else {
            format!("{} ({}).{}", stem, i, ext)
        };
        let dst = parent.join(&name);
        if !dst.exists() {
            copy_recursive(src, &dst)?;
            let dst_str = dst.to_string_lossy().to_string();
            if let Ok(db) = state.db.lock() {
                log_activity(&db, &dst_str, &name, "created");
            }
            return Ok(dst_str);
        }
        i += 1;
    }
}

#[tauri::command]
pub fn open_with_default(path: String, state: tauri::State<AppState>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Ok(db) = state.db.lock() {
        let name = Path::new(&path).file_name().and_then(|n| n.to_str()).unwrap_or("");
        log_activity(&db, &path, name, "opened");
    }
    Ok(())
}

#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let p = Path::new(&path);
        let target = if p.is_dir() {
            path.clone()
        } else {
            p.parent()
                .map(|d| d.to_string_lossy().to_string())
                .unwrap_or(path.clone())
        };
        std::process::Command::new("explorer.exe")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
