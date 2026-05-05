use crate::AppState;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct SharePermission {
    pub id: i64,
    pub context_id: i64,
    /// Empty string = workspace-wide default rule.
    pub path: String,
    pub can_list: bool,
    pub can_read: bool,
    pub can_create: bool,
    pub can_update: bool,
    pub can_delete: bool,
}

/// Fetch all permission rules for a context, ordered so that the workspace
/// default (empty path) comes first, then remaining rules by path length.
#[tauri::command]
pub fn get_share_permissions(
    context_id: i64,
    state: tauri::State<AppState>,
) -> Result<Vec<SharePermission>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT id, context_id, path,
                    can_list, can_read, can_create, can_update, can_delete
             FROM share_permissions
             WHERE context_id = ?1
             ORDER BY length(path) ASC, path ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([context_id], |row| {
            Ok(SharePermission {
                id:         row.get(0)?,
                context_id: row.get(1)?,
                path:       row.get(2)?,
                can_list:   row.get::<_, i64>(3)? != 0,
                can_read:   row.get::<_, i64>(4)? != 0,
                can_create: row.get::<_, i64>(5)? != 0,
                can_update: row.get::<_, i64>(6)? != 0,
                can_delete: row.get::<_, i64>(7)? != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

/// Upsert a permission rule. Use `path = ""` for the workspace-wide default.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn set_share_permission(
    context_id: i64,
    path: String,
    can_list: bool,
    can_read: bool,
    can_create: bool,
    can_update: bool,
    can_delete: bool,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO share_permissions
             (context_id, path, can_list, can_read, can_create, can_update, can_delete)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(context_id, path) DO UPDATE SET
             can_list   = excluded.can_list,
             can_read   = excluded.can_read,
             can_create = excluded.can_create,
             can_update = excluded.can_update,
             can_delete = excluded.can_delete",
        rusqlite::params![
            context_id, path,
            can_list as i64, can_read as i64, can_create as i64,
            can_update as i64, can_delete as i64,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete a specific permission rule (use this to revert a per-path override).
#[tauri::command]
pub fn delete_share_permission(
    id: i64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM share_permissions WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
