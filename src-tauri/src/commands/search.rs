use crate::{models::FileEntry, AppState};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use walkdir::WalkDir;

/// Result of `search_files`. Adds origin metadata so the UI can show "this match
/// came from the file's content, not its name" — without this, users see results
/// whose name doesn't contain their query and assume the search is broken.
///
/// `snippet` is populated for content matches: a short excerpt of the indexed
/// text with the matched terms wrapped in `<b>` / `</b>` markers. The frontend
/// parses the markers and renders them as React `<mark>` elements (no
/// `dangerouslySetInnerHTML` — safe by construction).
#[derive(Debug, Serialize)]
pub struct SearchHit {
    #[serde(flatten)]
    pub file: FileEntry,
    pub matched_name: bool,    // file name OR extension matched the FTS query
    pub matched_content: bool, // extracted text content matched
    pub snippet: Option<String>,
}

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

/// Tiered relevance for single-word name matches.
/// 0 = exact stem match (best), 1 = stem starts with query, 2 = stem contains it.
/// Stem = file name minus extension, lowercased.
fn name_match_tier(file_name: &str, needle_lower: &str) -> u8 {
    let stem = std::path::Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name)
        .to_lowercase();
    if stem == needle_lower {
        0
    } else if stem.starts_with(needle_lower) {
        1
    } else {
        2
    }
}

#[tauri::command]
pub fn search_files(
    query: String,
    context_id: Option<i64>,
    state: tauri::State<AppState>,
) -> Result<Vec<SearchHit>, String> {
    let context_id = context_id.unwrap_or(0);
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let fts_query = format!("{}*", query.trim().replace('"', ""));

    // Two separate FTS queries — we need to know, per result, which table
    // matched (or both) AND we want bm25() relevance ranking + snippet excerpts.
    // The previous UNION lost the origin info and ranked alphabetically.
    //
    // bm25() returns smaller-is-better scores (negative for very relevant
    // matches). We sort ASC throughout.
    let mut name_stmt = db
        .prepare("SELECT rowid, bm25(files_fts) FROM files_fts WHERE files_fts MATCH ?1")
        .map_err(|e| e.to_string())?;
    let name_scores: HashMap<i64, f64> = name_stmt
        .query_map([&fts_query], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    // snippet(table, column_idx, open_marker, close_marker, ellipsis, max_tokens).
    // file_content_fts has one column (`text_content`) → index 0. 24 tokens ≈
    // 120-180 chars typical; long enough to give context, short enough to fit
    // in a single line in the FileList row.
    let mut content_stmt = db
        .prepare(
            "SELECT rowid,
                    snippet(file_content_fts, 0, '<b>', '</b>', '…', 24),
                    bm25(file_content_fts)
             FROM file_content_fts WHERE file_content_fts MATCH ?1",
        )
        .map_err(|e| e.to_string())?;
    let content_results: HashMap<i64, (String, f64)> = content_stmt
        .query_map([&fts_query], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, f64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .map(|(id, snip, score)| (id, (snip, score)))
        .collect();

    // Union, then rank: name matches FIRST (most intuitive — searching "report"
    // should show files named report.pdf before files whose text just mentions
    // "report"), then content-only matches. Within each bucket, sort by bm25.
    let mut all_ids: Vec<i64> = name_scores
        .keys()
        .copied()
        .chain(content_results.keys().copied())
        .collect::<HashSet<i64>>()
        .into_iter()
        .collect();
    all_ids.sort_by(|a, b| {
        let a_name = name_scores.contains_key(a);
        let b_name = name_scores.contains_key(b);
        if a_name != b_name {
            // `true` sorts AFTER `false` by default — invert so name-match comes first
            return b_name.cmp(&a_name);
        }
        // Same bucket → bm25 ascending (smaller is more relevant)
        let score_a = name_scores
            .get(a)
            .copied()
            .or_else(|| content_results.get(a).map(|(_, s)| *s))
            .unwrap_or(0.0);
        let score_b = name_scores
            .get(b)
            .copied()
            .or_else(|| content_results.get(b).map(|(_, s)| *s))
            .unwrap_or(0.0);
        score_a.partial_cmp(&score_b).unwrap_or(std::cmp::Ordering::Equal)
    });
    all_ids.truncate(200);

    if all_ids.is_empty() {
        return Ok(Vec::new());
    }

    // Hydrate. SQLite default param limit is 999; 200 fits easily.
    let placeholders = std::iter::repeat_n("?", all_ids.len()).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT f.id, f.path, f.name, f.extension, f.size,
                f.created_at, f.modified_at, f.accessed_at
         FROM files f
         WHERE f.id IN ({})",
        placeholders,
    );
    let params: Vec<&dyn rusqlite::ToSql> = all_ids.iter().map(|i| i as &dyn rusqlite::ToSql).collect();
    let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;

    // Hydrate into a map so we can rebuild in the ranked order — SQL's IN(…)
    // returns rows in arbitrary order regardless of the param list.
    let mut by_id: HashMap<i64, FileEntry> = HashMap::with_capacity(all_ids.len());
    stmt
        .query_map(rusqlite::params_from_iter(params), |row| {
            Ok(FileEntry {
                id: row.get::<_, i64>(0)?,
                path: row.get::<_, String>(1)?,
                name: row.get::<_, String>(2)?,
                extension: row.get::<_, String>(3)?,
                size: row.get::<_, i64>(4)?,
                created_at: row.get::<_, i64>(5)?,
                modified_at: row.get::<_, i64>(6)?,
                accessed_at: row.get::<_, i64>(7)?,
                tags: Vec::new(), // filled in below
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .for_each(|f| {
            by_id.insert(f.id, f);
        });

    let mut files: Vec<SearchHit> = all_ids
        .into_iter()
        .filter_map(|id| {
            let mut file = by_id.remove(&id)?;
            file.tags = load_file_tags(&db, id, context_id);
            Some(SearchHit {
                matched_name: name_scores.contains_key(&id),
                matched_content: content_results.contains_key(&id),
                snippet: content_results.get(&id).map(|(s, _)| s.clone()),
                file,
            })
        })
        .collect();

    // SINGLE-WORD QUERIES — re-sort name matches by intuitive name relevance:
    //   tier 0: file stem == query exactly      → "compta.pdf"
    //   tier 1: file stem starts with query     → "compta_2023.pdf"
    //   tier 2: file stem contains the query    → "rapport_compta_annual.pdf"
    //
    // bm25 on a single filename term is essentially flat — every file has one
    // occurrence — so without this tiered re-sort, results within the name
    // bucket were in arbitrary order. For multi-word queries bm25 carries real
    // signal (more occurrences = higher relevance), so we keep its order.
    //
    // Content-only matches keep their existing position (after all name matches).
    let q = query.trim();
    let is_single_word = !q.is_empty() && !q.contains(char::is_whitespace);
    if is_single_word {
        let needle = q.to_lowercase();
        files.sort_by(|a, b| {
            // Bucket: name matches first, then content-only (unchanged invariant).
            if a.matched_name != b.matched_name {
                return b.matched_name.cmp(&a.matched_name);
            }
            // Within name bucket, apply the tier ranking.
            if a.matched_name && b.matched_name {
                let tier_a = name_match_tier(&a.file.name, &needle);
                let tier_b = name_match_tier(&b.file.name, &needle);
                if tier_a != tier_b {
                    return tier_a.cmp(&tier_b);
                }
                // Tie inside the same tier → alphabetical (stable, predictable).
                return a.file.name.to_lowercase().cmp(&b.file.name.to_lowercase());
            }
            // Both content-only → keep their previous bm25 order (already sorted).
            std::cmp::Ordering::Equal
        });
    }

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
