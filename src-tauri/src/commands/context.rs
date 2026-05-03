use crate::{models::Context, AppState};
use serde_json;

#[tauri::command]
pub fn get_watched_paths(state: tauri::State<AppState>) -> Result<Vec<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare("SELECT path FROM watched_paths ORDER BY added_at DESC")
        .map_err(|e| e.to_string())?;
    let paths = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(paths)
}

#[tauri::command]
pub fn get_last_path(state: tauri::State<AppState>) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let result = db.query_row(
        "SELECT value FROM settings WHERE key = 'last_path'",
        [],
        |r| r.get(0),
    );
    match result {
        Ok(path) => Ok(Some(path)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn parse_json_i64_array(s: &str) -> Vec<i64> {
    serde_json::from_str(s).unwrap_or_default()
}

fn parse_json_string_array(s: &str) -> Vec<String> {
    serde_json::from_str(s).unwrap_or_default()
}

#[tauri::command]
pub fn get_contexts(state: tauri::State<AppState>) -> Result<Vec<Context>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT id, name, icon, watched_paths, pinned_tag_ids, is_active,
                    COALESCE(last_path,''), COALESCE(open_tabs,'[]'), COALESCE(open_file_tabs,'[]')
             FROM contexts ORDER BY id",
        )
        .map_err(|e| e.to_string())?;

    let contexts = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .map(|(id, name, icon, watched_paths, pinned_tag_ids, is_active, last_path, open_tabs, open_file_tabs)| Context {
            id,
            name,
            icon,
            watched_paths: parse_json_string_array(&watched_paths),
            pinned_tag_ids: parse_json_i64_array(&pinned_tag_ids),
            is_active: is_active != 0,
            last_path,
            open_tabs: parse_json_string_array(&open_tabs),
            open_file_tabs: parse_json_string_array(&open_file_tabs),
        })
        .collect();

    Ok(contexts)
}

#[tauri::command]
pub fn update_context(
    id: i64,
    name: String,
    icon: String,
    watched_paths: Vec<String>,
    last_path: String,
    active_tag_ids: Vec<i64>,
    open_tabs: Vec<String>,
    open_file_tabs: Vec<String>,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let paths_json = serde_json::to_string(&watched_paths).unwrap_or_default();
    let tags_json = serde_json::to_string(&active_tag_ids).unwrap_or_default();
    let tabs_json = serde_json::to_string(&open_tabs).unwrap_or_default();
    let file_tabs_json = serde_json::to_string(&open_file_tabs).unwrap_or_default();
    db.execute(
        "UPDATE contexts SET name=?2, icon=?3, watched_paths=?4, last_path=?5, pinned_tag_ids=?6, open_tabs=?7, open_file_tabs=?8 WHERE id=?1",
        rusqlite::params![id, name, icon, paths_json, last_path, tags_json, tabs_json, file_tabs_json],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_context(id: i64, state: tauri::State<AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM contexts WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn create_context(
    name: String,
    icon: String,
    state: tauri::State<AppState>,
) -> Result<i64, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO contexts (name, icon) VALUES (?1, ?2)",
        rusqlite::params![name, icon],
    )
    .map_err(|e| e.to_string())?;
    Ok(db.last_insert_rowid())
}

#[tauri::command]
pub fn set_active_context(
    context_id: i64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("UPDATE contexts SET is_active = 0", [])
        .map_err(|e| e.to_string())?;
    db.execute(
        "UPDATE contexts SET is_active = 1 WHERE id = ?1",
        [context_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_timeline(
    from: i64,
    to: i64,
    folder: Option<String>,
    state: tauri::State<AppState>,
) -> Result<Vec<crate::models::ActivityEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    // Normalise to forward-slashes so the LIKE works regardless of how paths
    // were stored (Windows backslash vs forward-slash).
    let prefix: Option<String> = folder.filter(|f| !f.is_empty()).map(|f| {
        let norm = f.replace('\\', "/");
        let norm = norm.trim_end_matches('/');
        format!("{}/%", norm)
    });

    let mut stmt = db
        .prepare(
            "SELECT id, file_id,
                    replace(file_path, '\\', '/') as fp,
                    file_name, action, timestamp, app_name
             FROM activity
             WHERE timestamp BETWEEN ?1 AND ?2
               AND (?3 IS NULL OR replace(file_path, '\\', '/') LIKE ?3)
             ORDER BY timestamp DESC
             LIMIT 500",
        )
        .map_err(|e| e.to_string())?;

    let entries = stmt
        .query_map(rusqlite::params![from, to, prefix], |row| {
            Ok(crate::models::ActivityEntry {
                id: row.get(0)?,
                file_id: row.get(1)?,
                file_path: row.get(2)?,
                file_name: row.get(3)?,
                action: row.get(4)?,
                timestamp: row.get(5)?,
                app_name: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(entries)
}
