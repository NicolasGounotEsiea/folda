use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

// Keeps the watcher alive for the entire app lifetime.
// Stored outside AppState because RecommendedWatcher is not Sync.
static WATCHER: Mutex<Option<notify::RecommendedWatcher>> = Mutex::new(None);

use crate::{models::FileEntry, AppState};

fn load_file_tags(
    db: &rusqlite::Connection,
    file_id: i64,
    context_id: i64,
) -> rusqlite::Result<Vec<crate::models::Tag>> {
    let mut stmt = db.prepare(
        "SELECT DISTINCT t.id, t.name, t.color, t.is_auto, ft.context_id
         FROM tags t JOIN file_tags ft ON ft.tag_id = t.id
         WHERE ft.file_id = ?1 AND (ft.context_id = 0 OR ft.context_id = ?2)
         ORDER BY ft.context_id ASC, t.name",
    )?;
    let tags = stmt
        .query_map(rusqlite::params![file_id, context_id], |row| {
            Ok(crate::models::Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                is_auto: row.get::<_, i64>(3)? != 0,
                context_id: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(tags)
}

fn load_folder_tags(
    db: &rusqlite::Connection,
    folder_path: &str,
    context_id: i64,
) -> rusqlite::Result<Vec<crate::models::Tag>> {
    let mut stmt = db.prepare(
        "SELECT DISTINCT t.id, t.name, t.color, t.is_auto, ft.context_id
         FROM tags t JOIN folder_tags ft ON ft.tag_id = t.id
         WHERE ft.folder_path = ?1 AND (ft.context_id = 0 OR ft.context_id = ?2)
         ORDER BY ft.context_id ASC, t.name",
    )?;
    let tags = stmt
        .query_map(rusqlite::params![folder_path, context_id], |row| {
            Ok(crate::models::Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                is_auto: row.get::<_, i64>(3)? != 0,
                context_id: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(tags)
}

fn auto_tag_for_ext(ext: &str) -> Option<(&'static str, &'static str)> {
    match ext.to_lowercase().as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "ico" | "bmp" | "tiff" | "avif" | "heic" => {
            Some(("Images", "#ec4899"))
        }
        "mp4" | "mkv" | "avi" | "mov" | "webm" | "flv" | "wmv" => Some(("Videos", "#8b5cf6")),
        "mp3" | "wav" | "flac" | "ogg" | "m4a" | "aac" | "opus" => Some(("Audio", "#06b6d4")),
        "pdf" | "doc" | "docx" | "odt" | "rtf" | "pages" => Some(("Documents", "#3b82f6")),
        "xls" | "xlsx" | "csv" | "ods" | "numbers" => Some(("Spreadsheets", "#10b981")),
        "ppt" | "pptx" | "odp" | "key" => Some(("Presentations", "#f59e0b")),
        "txt" | "md" | "rst" | "log" | "org" => Some(("Text", "#94a3b8")),
        "rs" | "js" | "ts" | "tsx" | "jsx" | "py" | "go" | "java" | "c" | "cpp" | "h"
        | "cs" | "rb" | "php" | "swift" | "kt" | "html" | "css" | "scss" | "json"
        | "toml" | "yaml" | "yml" | "sh" | "bash" | "ps1" | "lua" | "zig" => {
            Some(("Code", "#22c55e"))
        }
        "zip" | "tar" | "gz" | "7z" | "rar" | "bz2" | "xz" | "zst" => {
            Some(("Archives", "#f97316"))
        }
        "exe" | "msi" | "dll" => Some(("Programs", "#ef4444")),
        "ttf" | "otf" | "woff" | "woff2" => Some(("Fonts", "#a78bfa")),
        _ => None,
    }
}

fn ensure_auto_tag(db: &rusqlite::Connection, name: &str, color: &str) -> rusqlite::Result<i64> {
    db.execute(
        "INSERT OR IGNORE INTO tags (name, color, is_auto) VALUES (?1, ?2, 1)",
        rusqlite::params![name, color],
    )?;
    db.query_row("SELECT id FROM tags WHERE name = ?1", [name], |r| r.get(0))
}

#[allow(clippy::too_many_arguments)]
fn upsert_file(
    db: &rusqlite::Connection,
    path_str: &str,
    name: &str,
    extension: &str,
    size: i64,
    created_at: i64,
    modified_at: i64,
    accessed_at: i64,
) -> rusqlite::Result<i64> {
    // Upsert preserving id and existing tags (no DELETE + INSERT)
    db.execute(
        "INSERT INTO files (path, name, extension, size, created_at, modified_at, accessed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(path) DO UPDATE SET
           name=excluded.name,
           extension=excluded.extension,
           size=excluded.size,
           modified_at=excluded.modified_at,
           accessed_at=excluded.accessed_at",
        rusqlite::params![path_str, name, extension, size, created_at, modified_at, accessed_at],
    )?;
    db.query_row("SELECT id FROM files WHERE path = ?1", [path_str], |r| r.get(0))
}

struct RawFile {
    path: String,
    name: String,
    extension: String,
    size: i64,
    created_at: i64,
    modified_at: i64,
    accessed_at: i64,
}

fn should_skip(path: &std::path::Path) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        matches!(
            s.as_ref(),
            "$Recycle.Bin" | "System Volume Information" | "Windows"
                | "ProgramData" | "AppData" | ".git" | "node_modules"
                | "target" | ".cargo"
        )
    })
}

/// Loads all files under `path` with their tags in a single JOIN query.
fn load_files_with_tags(db: &rusqlite::Connection, path: &str, context_id: i64) -> Result<Vec<FileEntry>, String> {
    let mut stmt = db.prepare(
        "SELECT f.id, f.path, f.name, f.extension, f.size,
                f.created_at, f.modified_at, f.accessed_at,
                t.id, t.name, t.color, t.is_auto, ft.context_id
         FROM files f
         LEFT JOIN file_tags ft ON ft.file_id = f.id AND (ft.context_id = 0 OR ft.context_id = ?2)
         LEFT JOIN tags t ON t.id = ft.tag_id
         WHERE f.path LIKE ?1 || '%'
         ORDER BY f.modified_at DESC, f.id",
    ).map_err(|e| e.to_string())?;

    let mut file_map: indexmap::IndexMap<i64, FileEntry> = indexmap::IndexMap::new();

    let rows = stmt.query_map(rusqlite::params![path, context_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, Option<i64>>(8)?,
            row.get::<_, Option<String>>(9)?,
            row.get::<_, Option<String>>(10)?,
            row.get::<_, Option<i64>>(11)?,
            row.get::<_, Option<i64>>(12)?,
        ))
    }).map_err(|e| e.to_string())?;

    for row in rows.filter_map(|r| r.ok()) {
        let (id, path, name, ext, size, created, modified, accessed,
             tag_id, tag_name, tag_color, tag_is_auto, tag_context_id) = row;

        let entry = file_map.entry(id).or_insert_with(|| FileEntry {
            id, path, name, extension: ext, size,
            created_at: created, modified_at: modified, accessed_at: accessed,
            tags: vec![],
        });

        if let (Some(tid), Some(tname), Some(tcolor), Some(tis_auto)) =
            (tag_id, tag_name, tag_color, tag_is_auto)
        {
            entry.tags.push(crate::models::Tag {
                id: tid, name: tname, color: tcolor, is_auto: tis_auto != 0,
                context_id: tag_context_id.unwrap_or(0),
            });
        }
    }

    Ok(file_map.into_values().collect())
}

#[tauri::command]
pub fn scan_directory(
    path: String,
    state: tauri::State<AppState>,
) -> Result<Vec<FileEntry>, String> {
    const MAX_FILES: usize = 100_000;

    struct RawDir { path: String, name: String, modified_at: i64 }

    // Phase 1: collect metadata — no DB lock held
    let mut raw_files: Vec<RawFile> = Vec::new();
    let mut raw_dirs: Vec<RawDir> = Vec::new();

    let mut count = 0usize;
    for entry in WalkDir::new(&path)
        .follow_links(false)
        .max_depth(8)
        .into_iter()
        .filter_entry(|e| !should_skip(e.path()))
        .filter_map(|e| e.ok())
    {
        let file_path = entry.path();
        if entry.file_type().is_dir() {
            if file_path.to_string_lossy() != path {
                let name = file_path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
                let modified_at = entry.metadata().ok()
                    .and_then(|m| m.modified().ok())
                    .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64)
                    .unwrap_or(0);
                raw_dirs.push(RawDir { path: file_path.to_string_lossy().into_owned(), name, modified_at });
            }
        } else if count < MAX_FILES {
            if let Ok(metadata) = entry.metadata() {
                let ts = |t: std::io::Result<std::time::SystemTime>| {
                    t.map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64)
                        .unwrap_or(0)
                };
                raw_files.push(RawFile {
                    path: file_path.to_string_lossy().into_owned(),
                    name: file_path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string(),
                    extension: file_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_string(),
                    size: metadata.len() as i64,
                    created_at: ts(metadata.created()),
                    modified_at: ts(metadata.modified()),
                    accessed_at: ts(metadata.accessed()),
                });
                count += 1;
            }
        }
    }

    // Phase 2: single transaction for all inserts
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute_batch("BEGIN").map_err(|e| e.to_string())?;

    let insert_result = (|| -> rusqlite::Result<()> {
        db.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('last_path', ?1)",
            [&path],
        )?;
        db.execute(
            "INSERT OR IGNORE INTO watched_paths (path) VALUES (?1)",
            [&path],
        )?;

        for d in &raw_dirs {
            let _ = db.execute(
                "INSERT OR REPLACE INTO directories (path, name, modified_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![d.path, d.name, d.modified_at],
            );
        }

        for f in &raw_files {
            let Ok(id) = upsert_file(&db, &f.path, &f.name, &f.extension,
                f.size, f.created_at, f.modified_at, f.accessed_at) else { continue };

            if let Some((tag_name, tag_color)) = auto_tag_for_ext(&f.extension) {
                if let Ok(tag_id) = ensure_auto_tag(&db, tag_name, tag_color) {
                    let _ = db.execute(
                        "INSERT OR IGNORE INTO file_tags (file_id, tag_id, context_id) VALUES (?1, ?2, 0)",
                        rusqlite::params![id, tag_id],
                    );
                }
            }

            let _ = db.execute(
                "INSERT OR IGNORE INTO activity (file_id, file_path, file_name, action, timestamp)
                 VALUES (?1, ?2, ?3, 'modified', ?4)",
                rusqlite::params![id, &f.path, &f.name, f.modified_at],
            );
        }
        Ok(())
    })();

    match insert_result {
        Ok(()) => db.execute_batch("COMMIT").map_err(|e| e.to_string())?,
        Err(e) => {
            let _ = db.execute_batch("ROLLBACK");
            return Err(e.to_string());
        }
    }

    // Phase 3: single JOIN query — no per-file queries
    load_files_with_tags(&db, &path, 0)
}

fn handle_fs_event(
    res: notify::Result<notify::Event>,
    db: &Arc<Mutex<rusqlite::Connection>>,
    app: &tauri::AppHandle,
) {
    use notify::EventKind;
    use tauri::Emitter;

    let Ok(event) = res else { return };

    let action = match &event.kind {
        EventKind::Create(_) => "created",
        EventKind::Modify(_) => "modified",
        EventKind::Remove(_) => "deleted",
        _ => return,
    };

    for path in &event.paths {
        if path.is_dir() { continue; }

        let path_str = path.to_string_lossy().to_string();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        let timestamp = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        if let Ok(db) = db.lock() {
            let file_id: Option<i64> = if action != "deleted" {
                if let Ok(meta) = std::fs::metadata(path) {
                    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                    let _ = upsert_file(
                        &db, &path_str, &name, ext,
                        meta.len() as i64, timestamp, timestamp, timestamp,
                    );
                }
                db.query_row("SELECT id FROM files WHERE path = ?1", [&path_str], |r| r.get(0)).ok()
            } else {
                db.query_row("SELECT id FROM files WHERE path = ?1", [&path_str], |r| r.get(0)).ok()
            };

            let _ = db.execute(
                "INSERT INTO activity (file_id, file_path, file_name, action, timestamp)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![file_id, path_str, name, action, timestamp],
            );
        }

        let _ = app.emit("file-changed", serde_json::json!({
            "path": path_str,
            "name": name,
            "action": action,
            "timestamp": timestamp,
        }));
    }
}

#[tauri::command]
pub fn watch_directory(
    path: String,
    state: tauri::State<AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use notify::{RecursiveMode, Watcher};

    let db = Arc::clone(&state.db);
    let app_handle = app.clone();

    let mut watcher = notify::RecommendedWatcher::new(
        move |res| handle_fs_event(res, &db, &app_handle),
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;

    watcher
        .watch(std::path::Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    // Replace the previous watcher (drops it, stopping the old watch)
    *WATCHER.lock().map_err(|e| e.to_string())? = Some(watcher);
    Ok(())
}

#[tauri::command]
pub fn get_files(
    path: String,
    context_id: Option<i64>,
    state: tauri::State<AppState>,
) -> Result<Vec<FileEntry>, String> {
    let context_id = context_id.unwrap_or(0);
    let db = state.db.lock().map_err(|e| e.to_string())?;
    load_files_with_tags(&db, &path, context_id)
}

#[tauri::command]
pub fn list_directory(
    path: String,
    context_id: Option<i64>,
    state: tauri::State<AppState>,
) -> Result<Vec<crate::models::ListEntry>, String> {
    let context_id = context_id.unwrap_or(0);
    use crate::models::ListEntry;

    let read = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let db = state.db.lock().map_err(|e| e.to_string())?;

    // Load tag rules and their tag details once, before iterating entries
    let rules: Vec<(i64, String, String)> = db
        .prepare("SELECT tag_id, rule_type, rule_value FROM tag_rules WHERE context_id = 0 OR context_id = ?1")
        .and_then(|mut s| {
            s.query_map(rusqlite::params![context_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();

    let rule_tags: std::collections::HashMap<i64, crate::models::Tag> = {
        let mut map = std::collections::HashMap::new();
        for (tag_id, _, _) in &rules {
            if map.contains_key(tag_id) { continue; }
            if let Ok(tag) = db.query_row(
                "SELECT id, name, color, is_auto FROM tags WHERE id = ?1",
                [tag_id],
                |row| Ok(crate::models::Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    is_auto: row.get::<_, i64>(3)? != 0,
                    context_id: 0,
                }),
            ) {
                map.insert(*tag_id, tag);
            }
        }
        map
    };

    let mut result: Vec<ListEntry> = read
        .filter_map(|e| e.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();

            let file_type = entry.file_type().ok()?;
            let meta = entry.metadata().ok()?;
            let entry_path = entry.path().to_string_lossy().to_string();
            let modified_at = meta.modified().ok()
                .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64)
                .unwrap_or(0);

            if file_type.is_dir() {
                let child_count = std::fs::read_dir(&entry_path)
                    .map(|it| it.count())
                    .unwrap_or(0) as i64;
                let folder_tags = load_folder_tags(&db, &entry_path, context_id).unwrap_or_default();
                Some(ListEntry {
                    is_dir: true, name, path: entry_path,
                    size: child_count, modified_at, extension: String::new(),
                    id: None, tags: folder_tags,
                })
            } else {
                let extension = std::path::Path::new(&entry_path)
                    .extension().and_then(|e| e.to_str()).unwrap_or("").to_string();
                let size = meta.len() as i64;
                let (id, mut tags) = db
                    .query_row("SELECT id FROM files WHERE path = ?1", [&entry_path], |r| r.get::<_, i64>(0))
                    .ok()
                    .map(|id| (Some(id), load_file_tags(&db, id, context_id).unwrap_or_default()))
                    .unwrap_or((None, vec![]));

                // Apply tag rules inline
                if !rules.is_empty() {
                    let name_lower = name.to_lowercase();
                    let ext_lower = extension.to_lowercase();
                    let path_lower = entry_path.to_lowercase();
                    for (tag_id, rule_type, rule_value) in &rules {
                        let val_lower = rule_value.to_lowercase();
                        let matches = match rule_type.as_str() {
                            "ext"           => ext_lower == val_lower,
                            "name_contains" => name_lower.contains(val_lower.as_str()),
                            "name_starts"   => name_lower.starts_with(val_lower.as_str()),
                            "path_contains" => path_lower.contains(val_lower.as_str()),
                            "size_gt"       => rule_value.parse::<i64>().map(|v| size > v).unwrap_or(false),
                            "size_lt"       => rule_value.parse::<i64>().map(|v| size < v).unwrap_or(false),
                            _ => false,
                        };
                        if matches {
                            if let Some(fid) = id {
                                let _ = db.execute(
                                    "INSERT OR IGNORE INTO file_tags (file_id, tag_id, context_id) VALUES (?1, ?2, ?3)",
                                    rusqlite::params![fid, tag_id, context_id],
                                );
                            }
                            if !tags.iter().any(|t| t.id == *tag_id) {
                                if let Some(tag) = rule_tags.get(tag_id) {
                                    tags.push(tag.clone());
                                }
                            }
                        }
                    }
                }

                Some(ListEntry { is_dir: false, name, path: entry_path, size, modified_at, extension, id, tags })
            }
        })
        .collect();

    result.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(result)
}

#[tauri::command]
pub fn get_file_tags(
    file_id: i64,
    context_id: Option<i64>,
    state: tauri::State<AppState>,
) -> Result<Vec<crate::models::Tag>, String> {
    let context_id = context_id.unwrap_or(0);
    let db = state.db.lock().map_err(|e| e.to_string())?;
    load_file_tags(&db, file_id, context_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_file_preview(path: String) -> Result<Option<String>, String> {
    use std::io::Read;

    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    const TEXT_EXTS: &[&str] = &[
        "txt", "md", "rst", "log", "csv", "xml", "html", "htm",
        "rs", "js", "ts", "tsx", "jsx", "py", "go", "java", "c", "cpp", "h",
        "cs", "rb", "php", "swift", "kt", "css", "scss", "json", "toml",
        "yaml", "yml", "sh", "bash", "ps1", "lua", "zig", "sql", "env",
    ];

    if !TEXT_EXTS.contains(&ext.as_str()) {
        return Ok(None);
    }

    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 6144];
    let n = file.read(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(n);

    match String::from_utf8(buf) {
        Ok(s) => Ok(Some(s)),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub fn read_file_full(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 10 * 1024 * 1024 {
        return Err("File too large to edit (>10 MB)".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_home_dir() -> String {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| "C:\\Users".to_string())
}
