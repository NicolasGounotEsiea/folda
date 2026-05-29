use crate::{models::FileEntry, AppState};
use walkdir::WalkDir;

fn load_file_tags(
    db: &rusqlite::Connection,
    file_id: i64,
    context_id: i64,
) -> Vec<crate::models::Tag> {
    db.prepare(
        "SELECT DISTINCT t.id, t.name, t.color, t.is_auto, ft.context_id
         FROM tags t JOIN file_tags ft ON ft.tag_id = t.id
         WHERE ft.file_id = ?1 AND (ft.context_id = 0 OR ft.context_id = ?2)
         ORDER BY ft.context_id ASC, t.name",
    )
    .and_then(|mut s| {
        s.query_map(rusqlite::params![file_id, context_id], |row| {
            Ok(crate::models::Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                is_auto: row.get::<_, i64>(3)? != 0,
                context_id: row.get(4)?,
            })
        })
        .map(|iter| iter.filter_map(|r| r.ok()).collect())
    })
    .unwrap_or_default()
}

#[tauri::command]
pub fn search_files(
    query: String,
    context_id: Option<i64>,
    state: tauri::State<AppState>,
) -> Result<Vec<FileEntry>, String> {
    let context_id = context_id.unwrap_or(0);
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let fts_query = format!("{}*", query.trim().replace('"', ""));

    let mut stmt = db
        .prepare(
            "SELECT DISTINCT f.id, f.path, f.name, f.extension, f.size,
                    f.created_at, f.modified_at, f.accessed_at
             FROM files f
             WHERE f.id IN (
                 SELECT rowid FROM files_fts WHERE files_fts MATCH ?1
                 UNION
                 SELECT rowid FROM file_content_fts WHERE file_content_fts MATCH ?1
             )
             ORDER BY f.name
             LIMIT 200",
        )
        .map_err(|e| e.to_string())?;

    let files = stmt
        .query_map([&fts_query], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .map(
            |(id, path, name, extension, size, created_at, modified_at, accessed_at)| {
                let tags = load_file_tags(&db, id, context_id);
                FileEntry {
                    id, path, name, extension, size,
                    created_at, modified_at, accessed_at, tags,
                }
            },
        )
        .collect();

    Ok(files)
}

#[tauri::command]
pub fn search_folders(
    query: String,
    state: tauri::State<AppState>,
) -> Result<Vec<crate::models::ListEntry>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }

    let pattern = format!("%{}%", q);
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let mut stmt = db
        .prepare(
            "SELECT path, name, modified_at FROM directories
             WHERE name LIKE ?1
             ORDER BY name COLLATE NOCASE
             LIMIT 200",
        )
        .map_err(|e| e.to_string())?;

    let results = stmt
        .query_map([&pattern], |row| {
            Ok(crate::models::ListEntry {
                is_dir: true,
                path: row.get(0)?,
                name: row.get(1)?,
                created_at: 0,
                modified_at: row.get(2)?,
                size: 0,
                extension: String::new(),
                id: None,
                tags: vec![],
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(results)
}

/// Real-time filesystem search — walks `path` up to 3 levels deep and returns
/// files whose name contains `query` (case-insensitive).  Bounded to 50 results
/// so it can't block for long.  Complements the DB-backed search for files that
/// haven't been indexed yet.
#[tauri::command]
pub async fn search_live(query: String, path: String) -> Vec<FileEntry> {
    let q = query.trim().to_lowercase();
    if q.is_empty() || path.is_empty() {
        return vec![];
    }
    tokio::task::spawn_blocking(move || {
        let mut results = Vec::new();
        for entry in WalkDir::new(&path)
            .max_depth(3)
            .into_iter()
            .filter_entry(|e| {
                let name = e.file_name().to_string_lossy();
                !matches!(name.as_ref(), "node_modules" | "target" | ".git" | "__pycache__")
            })
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
        {
            let name = entry.file_name().to_string_lossy();
            if name.to_lowercase().contains(&q) {
                let path_str = entry.path().to_string_lossy().to_string();
                let meta = entry.metadata().ok();
                let size = meta.as_ref().map(|m| m.len() as i64).unwrap_or(0);
                let modified = meta.as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                let ext = entry.path()
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default()
                    .to_string();
                results.push(FileEntry {
                    id: -1,
                    path: path_str,
                    name: name.to_string(),
                    extension: ext,
                    size,
                    created_at: 0,
                    modified_at: modified,
                    accessed_at: 0,
                    tags: vec![],
                });
                if results.len() >= 50 {
                    break;
                }
            }
        }
        results
    })
    .await
    .unwrap_or_default()
}
