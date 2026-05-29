use crate::AppState;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiMemory {
    pub id: i64,
    pub content: String,
    pub created_at: i64,
}

/// Max memories kept in active context. Beyond this, the oldest are dropped
/// from prompt injection (but kept in DB so the user can still review them).
const MAX_ACTIVE_MEMORIES: i64 = 30;

#[tauri::command]
pub fn get_ai_memories(state: tauri::State<AppState>) -> Result<Vec<AiMemory>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    // Return the most recent 30 memories, sorted oldest-first within the kept slice
    // (so prompt injection reads naturally chronologically).
    let mut stmt = db
        .prepare(
            "SELECT id, content, created_at FROM (
                SELECT id, content, created_at FROM ai_memory
                ORDER BY created_at DESC LIMIT ?1
             ) ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let memories = stmt
        .query_map([MAX_ACTIVE_MEMORIES], |row| {
            Ok(AiMemory {
                id: row.get(0)?,
                content: row.get(1)?,
                created_at: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(memories)
}

/// Returns the total count of memories stored (including those beyond the active window).
#[tauri::command]
pub fn count_ai_memories(state: tauri::State<AppState>) -> Result<i64, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.query_row("SELECT COUNT(*) FROM ai_memory", [], |row| row.get(0))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_ai_memory(content: String, state: tauri::State<AppState>) -> Result<i64, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO ai_memory (content) VALUES (?1)",
        rusqlite::params![content.trim()],
    )
    .map_err(|e| e.to_string())?;
    Ok(db.last_insert_rowid())
}

#[tauri::command]
pub fn delete_ai_memory(id: i64, state: tauri::State<AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM ai_memory WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
