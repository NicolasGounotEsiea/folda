use crate::AppState;
use std::collections::HashMap;

#[tauri::command]
pub fn get_all_settings(state: tauri::State<AppState>) -> Result<HashMap<String, String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare("SELECT key, value FROM settings")
        .map_err(|e| e.to_string())?;
    let map = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(map)
}

#[tauri::command]
pub fn set_setting(key: String, value: String, state: tauri::State<AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn purge_old_activity(retention_days: i64, state: tauri::State<AppState>) -> Result<u64, String> {
    if retention_days <= 0 { return Ok(0); }
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let cutoff = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64 - retention_days * 86400;
    let rows = db.execute(
        "DELETE FROM activity WHERE timestamp < ?1",
        rusqlite::params![cutoff],
    ).map_err(|e| e.to_string())?;
    Ok(rows as u64)
}
