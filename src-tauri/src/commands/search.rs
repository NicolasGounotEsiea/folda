use crate::{models::FileEntry, AppState};

fn load_file_tags(
    db: &rusqlite::Connection,
    file_id: i64,
) -> Vec<crate::models::Tag> {
    db.prepare(
        "SELECT t.id, t.name, t.color, t.is_auto
         FROM tags t JOIN file_tags ft ON ft.tag_id = t.id
         WHERE ft.file_id = ?1",
    )
    .and_then(|mut s| {
        s.query_map([file_id], |row| {
            Ok(crate::models::Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                is_auto: row.get::<_, i64>(3)? != 0,
            })
        })
        .map(|iter| iter.filter_map(|r| r.ok()).collect())
    })
    .unwrap_or_default()
}

#[tauri::command]
pub fn search_files(
    query: String,
    state: tauri::State<AppState>,
) -> Result<Vec<FileEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let fts_query = format!("{}*", query.trim().replace('"', ""));

    let mut stmt = db
        .prepare(
            "SELECT f.id, f.path, f.name, f.extension, f.size,
                    f.created_at, f.modified_at, f.accessed_at
             FROM files f
             JOIN files_fts ON files_fts.rowid = f.id
             WHERE files_fts MATCH ?1
             ORDER BY rank
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
                let tags = load_file_tags(&db, id);
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
