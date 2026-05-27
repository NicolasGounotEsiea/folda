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

#[tauri::command]
pub fn copy_path(
    src: String, dst_dir: String,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    let src_path = Path::new(&src);
    let file_name = src_path.file_name().ok_or("Invalid source path")?;
    let dst = unique_dst(&Path::new(&dst_dir).join(file_name));
    copy_recursive(src_path, &dst)?;
    let dst_str = dst.to_string_lossy().to_string();
    if let Ok(db) = state.db.lock() {
        let name = dst.file_name().and_then(|n| n.to_str()).unwrap_or("");
        log_activity(&db, &dst_str, name, "created");
    }
    Ok(dst_str)
}

#[tauri::command]
pub async fn move_path(
    src: String, dst_dir: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    use tauri::Emitter;
    use std::io::{Read, Write};
    let src_path = Path::new(&src);
    let file_name = src_path.file_name().ok_or("Invalid source path")?;
    let name = file_name.to_string_lossy().to_string();
    let dst = unique_dst(&Path::new(&dst_dir).join(file_name));

    match std::fs::rename(&src, &dst) {
        Ok(_) => {} // Same-device rename: instant, no progress needed
        Err(e) => {
            let is_cross_device = e.kind() == std::io::ErrorKind::CrossesDevices
                || e.raw_os_error() == Some(17);
            if !is_cross_device {
                return Err(human_io_error(e));
            }
            // Cross-device: copy with byte-level progress, then delete source
            let meta = std::fs::metadata(&src).map_err(|e| human_io_error(e))?;
            if meta.is_dir() {
                let _ = app.emit("move-progress", serde_json::json!({
                    "name": name, "done": 0u64, "total": 1u64, "finished": false
                }));
                copy_recursive(src_path, &dst)?;
                std::fs::remove_dir_all(&src).map_err(human_io_error)?;
                let _ = app.emit("move-progress", serde_json::json!({
                    "name": name, "done": 1u64, "total": 1u64, "finished": true
                }));
            } else {
                let total = meta.len();
                let mut src_file = std::fs::File::open(&src).map_err(human_io_error)?;
                let mut dst_file = std::fs::File::create(&dst).map_err(human_io_error)?;
                let mut buf = vec![0u8; 256 * 1024];
                let mut copied: u64 = 0;
                loop {
                    let n = src_file.read(&mut buf).map_err(|e| e.to_string())?;
                    if n == 0 { break; }
                    dst_file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                    copied += n as u64;
                    let _ = app.emit("move-progress", serde_json::json!({
                        "name": name, "done": copied, "total": total, "finished": false
                    }));
                }
                drop(src_file);
                drop(dst_file);
                std::fs::remove_file(&src).map_err(human_io_error)?;
                let _ = app.emit("move-progress", serde_json::json!({
                    "name": name, "done": total, "total": total, "finished": true
                }));
            }
        }
    }

    let dst_str = dst.to_string_lossy().to_string();
    if let Ok(db) = state.db.lock() {
        let n = dst.file_name().and_then(|n| n.to_str()).unwrap_or("");
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
