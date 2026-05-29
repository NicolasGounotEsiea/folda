//! Composite AI tools — single-call operations that the AI would otherwise have to
//! emulate with long chains of atomic tool calls. Bigger return values, much fewer
//! turns. Especially valuable for small Ollama models that lose track after ~10 calls.

use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MatchedFile {
    pub path: String,
    pub name: String,
}

/// Tag every file in `dir` whose name matches `pattern` (substring, case-insensitive)
/// OR whose extension matches `extension`. At least one of the two must be provided.
/// Returns the list of files that were tagged.
///
/// Recurses into subdirectories. Use this for "tag all PDFs in this folder",
/// "tag every file containing 'invoice' in its name", etc.
#[tauri::command]
pub fn tag_files_matching(
    dir: String,
    pattern: Option<String>,
    extension: Option<String>,
    tag_name: String,
    context_id: Option<i64>,
    state: tauri::State<AppState>,
) -> Result<Vec<MatchedFile>, String> {
    let context_id = context_id.unwrap_or(0);
    let pattern_lower = pattern.as_deref().map(|s| s.to_lowercase());
    let ext_lower = extension.as_deref().map(|s| s.trim_start_matches('.').to_lowercase());
    if pattern_lower.is_none() && ext_lower.is_none() {
        return Err("Provide at least one of `pattern` or `extension`.".to_string());
    }

    let db = state.db.lock().map_err(|e| e.to_string())?;

    // Resolve or create the tag
    let tag_id: i64 = match db.query_row(
        "SELECT id FROM tags WHERE LOWER(name) = LOWER(?1)",
        rusqlite::params![&tag_name],
        |r| r.get(0),
    ) {
        Ok(id) => id,
        Err(_) => {
            db.execute(
                "INSERT INTO tags (name, color, is_auto) VALUES (?1, '#6366f1', 0)",
                rusqlite::params![&tag_name],
            )
            .map_err(|e| e.to_string())?;
            db.last_insert_rowid()
        }
    };

    // Walk the directory tree
    let mut tagged: Vec<MatchedFile> = Vec::new();
    for entry in WalkDir::new(&dir)
        .max_depth(8)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let name_lower = name.to_lowercase();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        let name_match = pattern_lower
            .as_deref()
            .map(|p| name_lower.contains(p))
            .unwrap_or(false);
        let ext_match = ext_lower.as_deref().map(|e| ext == *e).unwrap_or(false);
        if !name_match && !ext_match {
            continue;
        }

        let path_str = path.to_string_lossy().to_string();
        // Upsert into files
        let file_id: Option<i64> = db
            .query_row(
                "SELECT id FROM files WHERE path = ?1",
                rusqlite::params![&path_str],
                |r| r.get(0),
            )
            .ok();
        let file_id = match file_id {
            Some(id) => id,
            None => {
                // Insert minimal row so tag has a valid foreign key
                let meta = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                let size = meta.len() as i64;
                db.execute(
                    "INSERT OR IGNORE INTO files (path, name, extension, size)
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![&path_str, &name, &ext, size],
                )
                .ok();
                match db.query_row(
                    "SELECT id FROM files WHERE path = ?1",
                    rusqlite::params![&path_str],
                    |r| r.get::<_, i64>(0),
                ) {
                    Ok(id) => id,
                    Err(_) => continue,
                }
            }
        };

        let inserted = db.execute(
            "INSERT OR IGNORE INTO file_tags (file_id, tag_id, context_id) VALUES (?1, ?2, ?3)",
            rusqlite::params![file_id, tag_id, context_id],
        );
        if matches!(inserted, Ok(n) if n > 0) {
            tagged.push(MatchedFile { path: path_str, name });
        }

        if tagged.len() >= 500 {
            break; // safety cap
        }
    }

    Ok(tagged)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DuplicateGroup {
    pub size: i64,
    pub paths: Vec<String>,
}

/// Find duplicate files by (size, name) within `dir`. Recursive, fast (no hashing).
/// Two files are reported as duplicates if they share the same exact filename AND size.
/// This catches the common case (copies of the same file in multiple folders) without
/// the cost of hashing every file. Returns groups of 2+ duplicates, sorted by size desc.
#[tauri::command]
pub fn find_duplicates(dir: String) -> Result<Vec<DuplicateGroup>, String> {
    let mut by_key: HashMap<(String, i64), Vec<String>> = HashMap::new();
    for entry in WalkDir::new(&dir)
        .max_depth(8)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let name = entry
            .file_name()
            .to_str()
            .unwrap_or("")
            .to_lowercase();
        let size = match entry.metadata() {
            Ok(m) => m.len() as i64,
            Err(_) => continue,
        };
        if size == 0 {
            continue; // ignore empty files
        }
        let path = entry.path().to_string_lossy().to_string();
        by_key.entry((name, size)).or_default().push(path);
    }

    let mut groups: Vec<DuplicateGroup> = by_key
        .into_iter()
        .filter(|(_, v)| v.len() >= 2)
        .map(|((_, size), paths)| DuplicateGroup { size, paths })
        .collect();
    groups.sort_by_key(|g| std::cmp::Reverse(g.size));
    groups.truncate(50);
    Ok(groups)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UnusedFile {
    pub path: String,
    pub name: String,
    pub last_activity: Option<i64>,
    pub size: i64,
}

/// Find files inside `dir` that have NO activity (opened/modified/etc.) in the last
/// `days` days. Uses the existing `activity` table. Recursive, capped at 200 results.
#[tauri::command]
pub fn find_unused(
    dir: String,
    days: i64,
    state: tauri::State<AppState>,
) -> Result<Vec<UnusedFile>, String> {
    let cutoff = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64 - days * 86_400)
        .unwrap_or(0);

    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT f.path, f.name, f.size,
                    (SELECT MAX(timestamp) FROM activity a WHERE a.file_id = f.id) AS last_act
             FROM files f
             WHERE f.path LIKE ?1 || '%'
               AND (last_act IS NULL OR last_act < ?2)
             ORDER BY COALESCE(last_act, 0) ASC
             LIMIT 200",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<UnusedFile> = stmt
        .query_map(rusqlite::params![&dir, cutoff], |row| {
            Ok(UnusedFile {
                path: row.get(0)?,
                name: row.get(1)?,
                size: row.get(2)?,
                last_activity: row.get::<_, Option<i64>>(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}
