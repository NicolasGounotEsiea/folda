use std::io::Write;
use tauri::Manager;

fn log_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir()
        .map_err(|e| e.to_string())?
        .join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("errors.log"))
}

/// Append one pre-formatted line to the local error log.
/// Rotates to errors.log.bak when the file exceeds 5 MB.
#[tauri::command]
pub fn write_log(entry: String, app: tauri::AppHandle) -> Result<(), String> {
    let path = log_path(&app)?;

    // Rotate at 5 MB
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 5 * 1024 * 1024 {
            let bak = path.with_extension("log.bak");
            let _ = std::fs::rename(&path, &bak);
        }
    }

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;

    file.write_all(format!("{}\n", entry).as_bytes())
        .map_err(|e| e.to_string())
}

/// Return the absolute path to the log file (may not exist yet).
#[tauri::command]
pub fn get_log_path(app: tauri::AppHandle) -> Result<String, String> {
    log_path(&app).map(|p| p.to_string_lossy().to_string())
}

/// Erase the log file content.
#[tauri::command]
pub fn clear_log(app: tauri::AppHandle) -> Result<(), String> {
    let path = log_path(&app)?;
    if path.exists() {
        std::fs::write(&path, b"").map_err(|e| e.to_string())?;
    }
    Ok(())
}
