use crate::models::{FolderStats, TypeBreakdown};
use std::collections::HashMap;
use walkdir::WalkDir;

#[tauri::command]
pub fn get_folder_stats(path: String) -> Result<FolderStats, String> {
    let mut total_size: i64 = 0;
    let mut file_count: i64 = 0;
    let mut dir_count: i64 = 0;
    let mut ext_map: HashMap<String, (i64, i64)> = HashMap::new(); // ext -> (count, size)

    for entry in WalkDir::new(&path)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.')
                && !matches!(
                    name.as_ref(),
                    "node_modules" | "target" | ".git" | "__pycache__" | ".cache"
                )
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

    Ok(FolderStats {
        total_size,
        file_count,
        dir_count,
        breakdown,
    })
}
