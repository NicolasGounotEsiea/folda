use crate::{models::Tag, AppState};

#[tauri::command]
pub fn create_directory(path: String) -> Result<(), String> {
    std::fs::create_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_folder_tags(path: String, state: tauri::State<AppState>) -> Result<Vec<Tag>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT t.id, t.name, t.color, t.is_auto
             FROM tags t
             JOIN folder_tags ft ON ft.tag_id = t.id
             WHERE ft.folder_path = ?1",
        )
        .map_err(|e| e.to_string())?;
    let tags = stmt
        .query_map([&path], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                is_auto: row.get::<_, i64>(3)? != 0,
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
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR IGNORE INTO folder_tags (folder_path, tag_id) VALUES (?1, ?2)",
        rusqlite::params![path, tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_tag_from_folder(
    path: String,
    tag_id: i64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "DELETE FROM folder_tags WHERE folder_path = ?1 AND tag_id = ?2",
        rusqlite::params![path, tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
