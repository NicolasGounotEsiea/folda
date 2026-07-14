use crate::AppState;
use serde::Serialize;

#[derive(Serialize)]
pub struct Snapshot {
    pub id: i64,
    pub file_path: String,
    pub timestamp: i64,
    pub size: i64,
}

/// Create a snapshot of `file_path` if the file is ≤ 1 MB, then enforce max count.
#[tauri::command]
pub fn create_snapshot(
    file_path: String,
    max_count: i64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    // Snapshots store file bytes in the `snapshots` table — an UNENCRYPTED
    // database. Snapshotting a decrypted vault file would therefore write its
    // plaintext into contextual.db, where it would outlive the vault being
    // locked. Silently skip (Ok, not Err): the editor calls this automatically
    // on save, and a hard error would surface as a scary toast for what is
    // correct, intended behaviour.
    if crate::vault::format::path_is_in_vault(std::path::Path::new(&file_path)) {
        return Ok(());
    }

    let content = std::fs::read(&file_path).map_err(|e| e.to_string())?;
    if content.len() > 10 * 1024 * 1024 {
        return Ok(()); // silently skip large files (>10 MB)
    }

    let size = content.len() as i64;
    let db = state.db.lock().map_err(|e| e.to_string())?;

    db.execute(
        "INSERT INTO snapshots (file_path, size, content) VALUES (?1, ?2, ?3)",
        rusqlite::params![file_path, size, content],
    )
    .map_err(|e| e.to_string())?;

    // Enforce max count: delete oldest snapshots beyond the limit
    let max = max_count.max(2);
    db.execute(
        "DELETE FROM snapshots WHERE file_path = ?1 AND id NOT IN (
             SELECT id FROM snapshots WHERE file_path = ?1
             ORDER BY timestamp DESC LIMIT ?2
         )",
        rusqlite::params![file_path, max],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// List all snapshots for a file, newest first (content excluded for performance).
#[tauri::command]
pub fn get_snapshots(
    file_path: String,
    state: tauri::State<AppState>,
) -> Result<Vec<Snapshot>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT id, file_path, timestamp, size
             FROM snapshots WHERE file_path = ?1
             ORDER BY timestamp DESC",
        )
        .map_err(|e| e.to_string())?;

    let snaps = stmt
        .query_map([&file_path], |row| {
            Ok(Snapshot {
                id:        row.get(0)?,
                file_path: row.get(1)?,
                timestamp: row.get(2)?,
                size:      row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(snaps)
}

/// Restore a snapshot: overwrite `file_path` with the stored content.
#[tauri::command]
pub fn restore_snapshot(
    snapshot_id: i64,
    file_path: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let content: Vec<u8> = db
        .query_row(
            "SELECT content FROM snapshots WHERE id = ?1",
            [snapshot_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    drop(db); // release lock before writing to disk
    std::fs::write(&file_path, &content).map_err(|e| e.to_string())?;
    Ok(())
}

/// Return the text content of a single snapshot (UTF-8; lossy for binary).
#[tauri::command]
pub fn get_snapshot_content(
    snapshot_id: i64,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let bytes: Vec<u8> = db
        .query_row(
            "SELECT content FROM snapshots WHERE id = ?1",
            [snapshot_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Delete a single snapshot entry.
#[tauri::command]
pub fn delete_snapshot(
    snapshot_id: i64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM snapshots WHERE id = ?1", [snapshot_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
