//! Per-workspace notes. Free-form markdown stored as plain text.
//! One row per workspace context_id; context_id = 0 is the "global" notes
//! used when no workspace is active.

use crate::AppState;

#[tauri::command]
pub fn get_workspace_note(
    context_id: i64,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let content: String = db
        .query_row(
            "SELECT content FROM workspace_notes WHERE context_id = ?1",
            rusqlite::params![context_id],
            |row| row.get(0),
        )
        .unwrap_or_default();
    Ok(content)
}

#[tauri::command]
pub fn save_workspace_note(
    context_id: i64,
    content: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO workspace_notes (context_id, content)
         VALUES (?1, ?2)
         ON CONFLICT(context_id) DO UPDATE SET
           content    = excluded.content,
           updated_at = unixepoch()",
        rusqlite::params![context_id, content],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
