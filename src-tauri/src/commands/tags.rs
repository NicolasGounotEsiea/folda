use crate::{models::{Tag, TagRule, SavedView, TagStat}, AppState};

static TAG_COLORS: &[&str] = &[
    "#6366f1", "#ec4899", "#f59e0b", "#10b981",
    "#3b82f6", "#8b5cf6", "#ef4444", "#14b8a6",
    "#f43f5e", "#84cc16", "#06b6d4", "#a855f7",
];

// ── Existing tag commands ─────────────────────────────────────────────────────

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
                context_id: 0,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(tags)
}

#[tauri::command]
pub fn create_tag(name: String, color: Option<String>, state: tauri::State<AppState>) -> Result<i64, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let tag_color = color.unwrap_or_else(|| {
        let count: i64 = db.query_row("SELECT COUNT(*) FROM tags", [], |r| r.get(0)).unwrap_or(0);
        TAG_COLORS[(count as usize) % TAG_COLORS.len()].to_string()
    });

    db.execute(
        "INSERT OR IGNORE INTO tags (name, color) VALUES (?1, ?2)",
        rusqlite::params![name, tag_color],
    )
    .map_err(|e| e.to_string())?;

    let id: i64 = db
        .query_row("SELECT id FROM tags WHERE name = ?1", [&name], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    Ok(id)
}

#[tauri::command]
pub fn update_tag(id: i64, name: String, color: String, state: tauri::State<AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "UPDATE tags SET name = ?1, color = ?2 WHERE id = ?3 AND is_auto = 0",
        rusqlite::params![name, color, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_tag(id: i64, state: tauri::State<AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    // Explicit cleanup first — don't rely solely on CASCADE
    let _ = db.execute("DELETE FROM tag_rules WHERE tag_id = ?1", rusqlite::params![id]);
    let _ = db.execute("DELETE FROM file_tags WHERE tag_id = ?1", rusqlite::params![id]);
    let _ = db.execute("DELETE FROM folder_tags WHERE tag_id = ?1", rusqlite::params![id]);
    db.execute("DELETE FROM tags WHERE id = ?1 AND is_auto = 0", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_tag_stats(context_id: Option<i64>, state: tauri::State<AppState>) -> Result<Vec<TagStat>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let ctx = context_id.unwrap_or(0);

    if ctx == 0 {
        // Global mode: count all tagged files regardless of path
        let mut stmt = db
            .prepare("SELECT tag_id, COUNT(DISTINCT file_id) FROM file_tags GROUP BY tag_id")
            .map_err(|e| e.to_string())?;
        let stats = stmt
            .query_map([], |row| Ok(TagStat { tag_id: row.get(0)?, count: row.get(1)? }))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        return Ok(stats);
    }

    // Workspace mode: load watched_paths from the context row
    let watched_json: String = db
        .query_row("SELECT watched_paths FROM contexts WHERE id = ?1", [ctx], |r| r.get(0))
        .unwrap_or_else(|_| "[]".to_string());
    let watched_paths: Vec<String> = serde_json::from_str(&watched_json).unwrap_or_default();

    if watched_paths.is_empty() {
        return Ok(vec![]);
    }

    // Build LIKE patterns for every watched path (normalize to forward slashes)
    let patterns: Vec<String> = watched_paths
        .iter()
        .map(|p| format!("{}%", p.replace('\\', "/")))
        .collect();

    // Accumulate counts across all watched paths
    use std::collections::HashMap;
    let mut totals: HashMap<i64, i64> = HashMap::new();

    for pattern in &patterns {
        let mut stmt = db
            .prepare(
                "SELECT ft.tag_id, COUNT(DISTINCT ft.file_id)
                 FROM file_tags ft
                 JOIN files f ON f.id = ft.file_id
                 WHERE replace(f.path, '\\', '/') LIKE ?1
                 GROUP BY ft.tag_id",
            )
            .map_err(|e| e.to_string())?;
        let rows: Vec<(i64, i64)> = stmt
            .query_map(rusqlite::params![pattern], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        for (tag_id, count) in rows {
            *totals.entry(tag_id).or_insert(0) += count;
        }
    }

    Ok(totals.into_iter().map(|(tag_id, count)| TagStat { tag_id, count }).collect())
}

#[tauri::command]
pub fn add_tag_to_file(
    file_id: i64, tag_id: i64, context_id: i64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR IGNORE INTO file_tags (file_id, tag_id, context_id) VALUES (?1, ?2, ?3)",
        rusqlite::params![file_id, tag_id, context_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_tag_from_file(
    file_id: i64, tag_id: i64, context_id: i64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "DELETE FROM file_tags WHERE file_id = ?1 AND tag_id = ?2 AND context_id = ?3",
        rusqlite::params![file_id, tag_id, context_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn promote_file_tag_to_global(
    file_id: i64, tag_id: i64,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR IGNORE INTO file_tags (file_id, tag_id, context_id) VALUES (?1, ?2, 0)",
        rusqlite::params![file_id, tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Tag rules ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_tag_rules(context_id: Option<i64>, state: tauri::State<AppState>) -> Result<Vec<TagRule>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let ctx = context_id.unwrap_or(0);
    let mut stmt = db
        .prepare(
            "SELECT id, tag_id, context_id, rule_type, rule_value FROM tag_rules
             WHERE context_id = 0 OR context_id = ?1
             ORDER BY tag_id, id",
        )
        .map_err(|e| e.to_string())?;
    let rules = stmt
        .query_map(rusqlite::params![ctx], |row| {
            Ok(TagRule {
                id: row.get(0)?,
                tag_id: row.get(1)?,
                context_id: row.get(2)?,
                rule_type: row.get(3)?,
                rule_value: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rules)
}

#[tauri::command]
pub fn create_tag_rule(
    tag_id: i64, rule_type: String, rule_value: String,
    context_id: Option<i64>,
    state: tauri::State<AppState>,
) -> Result<i64, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let ctx = context_id.unwrap_or(0);
    db.execute(
        "INSERT INTO tag_rules (tag_id, context_id, rule_type, rule_value) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![tag_id, ctx, rule_type, rule_value],
    )
    .map_err(|e| e.to_string())?;
    Ok(db.last_insert_rowid())
}

#[tauri::command]
pub fn delete_tag_rule(id: i64, state: tauri::State<AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM tag_rules WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn apply_tag_rules(path: String, context_id: Option<i64>, state: tauri::State<AppState>) -> Result<u64, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let ctx = context_id.unwrap_or(0);

    // Load all applicable rules
    let mut stmt = db
        .prepare("SELECT id, tag_id, rule_type, rule_value FROM tag_rules WHERE context_id = 0 OR context_id = ?1")
        .map_err(|e| e.to_string())?;
    let rules: Vec<(i64, i64, String, String)> = stmt
        .query_map(rusqlite::params![ctx], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    if rules.is_empty() {
        return Ok(0);
    }

    // Load all files under the given path
    let norm_path = path.replace('\\', "/");
    let like_pattern = format!("{}%", norm_path);
    let mut fstmt = db
        .prepare("SELECT id, name, extension, path, size FROM files WHERE path LIKE ?1")
        .map_err(|e| e.to_string())?;
    let files: Vec<(i64, String, String, String, i64)> = fstmt
        .query_map(rusqlite::params![like_pattern], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut applied: u64 = 0;
    for (file_id, name, ext, fpath, size) in &files {
        let name_lower = name.to_lowercase();
        let ext_lower = ext.to_lowercase();
        let path_lower = fpath.to_lowercase();

        for (_rule_id, tag_id, rule_type, rule_value) in &rules {
            let val_lower = rule_value.to_lowercase();
            let matches = match rule_type.as_str() {
                "ext"           => ext_lower == val_lower,
                "name_contains" => name_lower.contains(val_lower.as_str()),
                "name_starts"   => name_lower.starts_with(val_lower.as_str()),
                "path_contains" => path_lower.contains(val_lower.as_str()),
                "size_gt"       => rule_value.parse::<i64>().map(|v| *size > v).unwrap_or(false),
                "size_lt"       => rule_value.parse::<i64>().map(|v| *size < v).unwrap_or(false),
                _ => false,
            };
            if matches {
                let rows = db.execute(
                    "INSERT OR IGNORE INTO file_tags (file_id, tag_id, context_id) VALUES (?1, ?2, ?3)",
                    rusqlite::params![file_id, tag_id, ctx],
                ).unwrap_or(0);
                applied += rows as u64;
            }
        }
    }

    Ok(applied)
}

// ── Saved views ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_saved_views(context_id: Option<i64>, state: tauri::State<AppState>) -> Result<Vec<SavedView>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let ctx = context_id.unwrap_or(0);
    let mut stmt = db
        .prepare(
            "SELECT id, name, icon, tag_ids, context_id FROM saved_views
             WHERE context_id = 0 OR context_id = ?1
             ORDER BY created_at",
        )
        .map_err(|e| e.to_string())?;
    let views = stmt
        .query_map(rusqlite::params![ctx], |row| {
            let tag_ids_json: String = row.get(3)?;
            let tag_ids: Vec<i64> = serde_json::from_str(&tag_ids_json).unwrap_or_default();
            Ok(SavedView {
                id: row.get(0)?,
                name: row.get(1)?,
                icon: row.get(2)?,
                tag_ids,
                context_id: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(views)
}

#[tauri::command]
pub fn create_saved_view(
    name: String, icon: String, tag_ids: Vec<i64>,
    context_id: Option<i64>,
    state: tauri::State<AppState>,
) -> Result<i64, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let ctx = context_id.unwrap_or(0);
    let tag_ids_json = serde_json::to_string(&tag_ids).map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO saved_views (name, icon, tag_ids, context_id) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![name, icon, tag_ids_json, ctx],
    )
    .map_err(|e| e.to_string())?;
    Ok(db.last_insert_rowid())
}

#[tauri::command]
pub fn delete_saved_view(id: i64, state: tauri::State<AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM saved_views WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
