use crate::{models::Tag, AppState};

static TAG_COLORS: &[&str] = &[
    "#6366f1", "#ec4899", "#f59e0b", "#10b981",
    "#3b82f6", "#8b5cf6", "#ef4444", "#14b8a6",
];

#[tauri::command]
pub fn get_tags(state: tauri::State<AppState>) -> Result<Vec<Tag>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare("SELECT id, name, color, is_auto FROM tags ORDER BY name")
        .map_err(|e| e.to_string())?;

    let tags = stmt
        .query_map([], |row| {
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
pub fn create_tag(name: String, state: tauri::State<AppState>) -> Result<i64, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let count: i64 = db
        .query_row("SELECT COUNT(*) FROM tags", [], |r| r.get(0))
        .unwrap_or(0);
    let color = TAG_COLORS[(count as usize) % TAG_COLORS.len()];

    db.execute(
        "INSERT OR IGNORE INTO tags (name, color) VALUES (?1, ?2)",
        rusqlite::params![name, color],
    )
    .map_err(|e| e.to_string())?;

    let id: i64 = db
        .query_row("SELECT id FROM tags WHERE name = ?1", [&name], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    Ok(id)
}

#[tauri::command]
pub fn add_tag_to_file(
    file_id: i64,
    tag_id: i64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?1, ?2)",
        rusqlite::params![file_id, tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_tag_from_file(
    file_id: i64,
    tag_id: i64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "DELETE FROM file_tags WHERE file_id = ?1 AND tag_id = ?2",
        rusqlite::params![file_id, tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
