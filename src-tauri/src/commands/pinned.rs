use crate::{models::PinnedItem, AppState};

#[tauri::command]
pub fn get_pinned_items(state: tauri::State<AppState>) -> Result<Vec<PinnedItem>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare("SELECT id, path, name, is_dir FROM pinned_items ORDER BY added_at DESC")
        .map_err(|e| e.to_string())?;
    let items = stmt
        .query_map([], |row| {
            Ok(PinnedItem {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                is_dir: row.get::<_, i64>(3)? != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(items)
}

#[tauri::command]
pub fn pin_item(
    path: String,
    name: String,
    is_dir: bool,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO pinned_items (path, name, is_dir) VALUES (?1, ?2, ?3)",
        rusqlite::params![path, name, is_dir as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn unpin_item(path: String, state: tauri::State<AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM pinned_items WHERE path = ?1", [path])
        .map_err(|e| e.to_string())?;
    Ok(())
}
