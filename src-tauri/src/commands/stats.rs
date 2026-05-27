use crate::models::{FolderStats, TypeBreakdown};
use std::collections::HashMap;
use walkdir::WalkDir;

#[derive(serde::Serialize)]
pub struct FolderSizeEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
}


const SKIP_DIRS: &[&str] = &[
    "node_modules", "target", ".git", "__pycache__", ".cache",
    ".cargo", "vendor", "dist", ".next", ".nuxt", "build",
];

fn dir_size_capped(p: &std::path::Path) -> u64 {
    WalkDir::new(p)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !SKIP_DIRS.contains(&name.as_ref())
        })
        .filter_map(|e| e.ok())
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

#[tauri::command]
pub async fn get_folder_sizes(path: String) -> Result<Vec<FolderSizeEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let read = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
        let mut entries: Vec<FolderSizeEntry> = read
            .filter_map(|e| e.ok())
            .map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let ep = e.path();
                let is_dir = ep.is_dir();
                let size = if is_dir {
                    dir_size_capped(&ep)
                } else {
                    e.metadata().map(|m| m.len()).unwrap_or(0)
                };
                FolderSizeEntry { name, path: ep.to_string_lossy().to_string(), size, is_dir }
            })
            .collect();
        entries.sort_by_key(|b| std::cmp::Reverse(b.size));
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_folder_stats(path: String) -> Result<FolderStats, String> {
    tokio::task::spawn_blocking(move || {
        let mut total_size: i64 = 0;
        let mut file_count: i64 = 0;
        let mut dir_count: i64 = 0;
        let mut ext_map: HashMap<String, (i64, i64)> = HashMap::new();

        for entry in WalkDir::new(&path)
            .min_depth(1)
            .into_iter()
            .filter_entry(|e| {
                let name = e.file_name().to_string_lossy();
                !SKIP_DIRS.contains(&name.as_ref()) && !name.starts_with('.')
            })
            .filter_map(|e| e.ok())
        {
            let ft = entry.file_type();
            if ft.is_dir() {
                dir_count += 1;
            } else if ft.is_file() {
                let size = entry.metadata().map(|m| m.len() as i64).unwrap_or(0);
                total_size += size;
                file_count += 1;
                let ext = entry
                    .path()
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                let e = ext_map.entry(ext.to_string()).or_insert((0, 0));
                e.0 += 1;
                e.1 += size;
            }
        }

        let mut breakdown: Vec<TypeBreakdown> = ext_map
            .into_iter()
            .map(|(ext, (count, size))| TypeBreakdown { ext, count, size })
            .collect();
        breakdown.sort_by_key(|b| std::cmp::Reverse(b.size));
        breakdown.truncate(8);

        Ok(FolderStats { total_size, file_count, dir_count, breakdown })
    })
    .await
    .map_err(|e| e.to_string())?
}
