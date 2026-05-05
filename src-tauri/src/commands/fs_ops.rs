use std::path::Path;
use crate::AppState;

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
pub fn delete_path(path: String, state: tauri::State<AppState>) -> Result<(), String> {
    let file_name = Path::new(&path)
        .file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    // Log before deleting so the DB row still has a chance to match
    if let Ok(db) = state.db.lock() {
        log_activity(&db, &path, &file_name, "deleted");
    }
    let p = Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
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
pub fn move_path(
    src: String, dst_dir: String,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    let src_path = Path::new(&src);
    let file_name = src_path.file_name().ok_or("Invalid source path")?;
    let dst = unique_dst(&Path::new(&dst_dir).join(file_name));
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    let dst_str = dst.to_string_lossy().to_string();
    if let Ok(db) = state.db.lock() {
        let name = dst.file_name().and_then(|n| n.to_str()).unwrap_or("");
        log_activity(&db, &dst_str, name, "renamed");
    }
    Ok(dst_str)
}

#[tauri::command]
pub fn create_file(path: String, state: tauri::State<AppState>) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::File::create(&path).map(|_| ()).map_err(|e| e.to_string())?;
    if let Ok(db) = state.db.lock() {
        let name = Path::new(&path).file_name().and_then(|n| n.to_str()).unwrap_or("");
        log_activity(&db, &path, name, "created");
    }
    Ok(())
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
