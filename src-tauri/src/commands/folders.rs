use crate::{models::Tag, AppState};

#[tauri::command]
pub fn create_directory(path: String) -> Result<(), String> {
    std::fs::create_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_folder_tags(
    path: String,
    context_id: Option<i64>,
    state: tauri::State<AppState>,
) -> Result<Vec<Tag>, String> {
    let context_id = context_id.unwrap_or(0);
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT DISTINCT t.id, t.name, t.color, t.is_auto, ft.context_id
             FROM tags t
             JOIN folder_tags ft ON ft.tag_id = t.id
             WHERE ft.folder_path = ?1 AND (ft.context_id = 0 OR ft.context_id = ?2)
             ORDER BY ft.context_id ASC, t.name",
        )
        .map_err(|e| e.to_string())?;
    let tags = stmt
        .query_map(rusqlite::params![path, context_id], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                is_auto: row.get::<_, i64>(3)? != 0,
                context_id: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(tags)
}

#[tauri::command]
pub fn add_tag_to_folder(
    path: String,
    tag_id: i64,
    context_id: i64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR IGNORE INTO folder_tags (folder_path, tag_id, context_id) VALUES (?1, ?2, ?3)",
        rusqlite::params![path, tag_id, context_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_tag_from_folder(
    path: String,
    tag_id: i64,
    context_id: i64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "DELETE FROM folder_tags WHERE folder_path = ?1 AND tag_id = ?2 AND context_id = ?3",
        rusqlite::params![path, tag_id, context_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn promote_folder_tag_to_global(
    path: String,
    tag_id: i64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR IGNORE INTO folder_tags (folder_path, tag_id, context_id) VALUES (?1, ?2, 0)",
        rusqlite::params![path, tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
