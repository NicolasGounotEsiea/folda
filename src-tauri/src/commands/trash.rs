use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use crate::AppState;
use tauri::State;

#[derive(Serialize, Clone)]
pub struct TrashEntry {
    pub id: String,
    pub original_path: String,
    pub name: String,
    pub is_dir: bool,
    pub deleted_at: i64,
    pub size: i64,
}

fn generate_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let pid = std::process::id();
    format!("{:016x}{:08x}", ts, pid)
}

fn trash_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = data_dir.join("trash");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn compute_size(path: &Path) -> i64 {
    if path.is_file() {
        return path.metadata().map(|m| m.len() as i64).unwrap_or(0);
    }
    walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.metadata().map(|m| m.len() as i64).unwrap_or(0))
        .sum()
}

fn now_unix() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

// ── Move to trash ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn move_to_trash(
    app: AppHandle,
    state: State<AppState>,
    paths: Vec<String>,
) -> Result<(), String> {
    let dir = trash_dir(&app)?;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let now = now_unix();

    for path_str in &paths {
        let src = Path::new(path_str);
        if !src.exists() {
            continue;
        }
        let id = generate_id();
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let is_dir = src.is_dir();
        let size = compute_size(src);
        let dest = dir.join(&id);

        if let Err(e) = std::fs::rename(src, &dest) {
            // Cross-device move fallback
            let cross_device = e.raw_os_error() == Some(17)
                || e.kind() == std::io::ErrorKind::CrossesDevices;
            if cross_device {
                if is_dir {
                    copy_dir_all(src, &dest).map_err(|ce| ce.to_string())?;
                    std::fs::remove_dir_all(src).map_err(|re| re.to_string())?;
                } else {
                    std::fs::copy(src, &dest).map_err(|ce| ce.to_string())?;
                    std::fs::remove_file(src).map_err(|re| re.to_string())?;
                }
            } else {
                return Err(e.to_string());
            }
        }

        db.execute(
            "INSERT INTO trash_items (id, original_path, name, is_dir, deleted_at, size) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, path_str, name, is_dir as i64, now, size],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

// ── List trash ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_trash(state: State<AppState>) -> Result<Vec<TrashEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db.prepare(
        "SELECT id, original_path, name, is_dir, deleted_at, size FROM trash_items ORDER BY deleted_at DESC",
    ).map_err(|e| e.to_string())?;

    let entries = stmt.query_map([], |row| {
        Ok(TrashEntry {
            id: row.get(0)?,
            original_path: row.get(1)?,
            name: row.get(2)?,
            is_dir: row.get::<_, i64>(3)? != 0,
            deleted_at: row.get(4)?,
            size: row.get(5)?,
        })
    })
    .map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();

    Ok(entries)
}

// ── Restore ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn restore_from_trash(
    app: AppHandle,
    state: State<AppState>,
    id: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let (original_path,): (String,) = db.query_row(
        "SELECT original_path FROM trash_items WHERE id = ?1",
        rusqlite::params![id],
        |row| row.get(0).map(|p: String| (p,)),
    ).map_err(|_| "Item not found in trash".to_string())?;

    let dir = trash_dir(&app)?;
    let src = dir.join(&id);

    if !src.exists() {
        // Gone from disk — just remove the DB entry
        db.execute("DELETE FROM trash_items WHERE id = ?1", rusqlite::params![id])
            .map_err(|e| e.to_string())?;
        return Err("Trash file missing from disk".to_string());
    }

    let dest = Path::new(&original_path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    // If destination exists, find a non-conflicting name
    let final_dest = if dest.exists() {
        let stem = dest.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let ext = dest.extension().map(|e| e.to_string_lossy().to_string());
        let parent = dest.parent().unwrap_or(Path::new(""));
        let mut i = 1usize;
        loop {
            let candidate = if let Some(ref e) = ext {
                parent.join(format!("{} ({}). {}", stem, i, e))
            } else {
                parent.join(format!("{} ({})", stem, i))
            };
            if !candidate.exists() {
                break candidate;
            }
            i += 1;
        }
    } else {
        dest.to_path_buf()
    };

    std::fs::rename(&src, &final_dest).map_err(|e| e.to_string())?;

    db.execute("DELETE FROM trash_items WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Delete permanently ────────────────────────────────────────────────────────

#[tauri::command]
pub fn delete_permanently(
    app: AppHandle,
    state: State<AppState>,
    id: String,
) -> Result<(), String> {
    let dir = trash_dir(&app)?;
    let path = dir.join(&id);

    if path.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    } else if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }

    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM trash_items WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Empty trash ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn empty_trash(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let dir = trash_dir(&app)?;
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let ids: Vec<String> = {
        let mut stmt = db.prepare("SELECT id FROM trash_items").map_err(|e| e.to_string())?;
        let rows: Vec<String> = stmt.query_map([], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };

    for id in &ids {
        let path = dir.join(id);
        if path.is_dir() {
            std::fs::remove_dir_all(&path).ok();
        } else if path.exists() {
            std::fs::remove_file(&path).ok();
        }
    }

    db.execute_batch("DELETE FROM trash_items").map_err(|e| e.to_string())?;
    Ok(())
}
