use crate::{models::PinnedItem, AppState};

#[tauri::command]
pub fn get_pinned_items(
    context_id: i64,
    state: tauri::State<AppState>,
) -> Result<Vec<PinnedItem>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT id, path, name, is_dir, context_id FROM pinned_items
             WHERE (context_id = 0 OR context_id = ?1)
             ORDER BY context_id DESC, added_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let items = stmt
        .query_map(rusqlite::params![context_id], |row| {
            Ok(PinnedItem {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                is_dir: row.get::<_, i64>(3)? != 0,
                context_id: row.get(4)?,
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
    context_id: i64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO pinned_items (path, name, is_dir, context_id) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![path, name, is_dir as i64, context_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn unpin_item(
    path: String,
    context_id: i64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "DELETE FROM pinned_items WHERE path = ?1 AND context_id = ?2",
        rusqlite::params![path, context_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn promote_pin_to_global(
    path: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let (name, is_dir): (String, i64) = db
        .query_row(
            "SELECT name, is_dir FROM pinned_items WHERE path = ?1 LIMIT 1",
            rusqlite::params![path],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO pinned_items (path, name, is_dir, context_id) VALUES (?1, ?2, ?3, 0)",
        rusqlite::params![path, name, is_dir],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
