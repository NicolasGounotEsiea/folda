use std::path::Path;

#[tauri::command]
pub fn rename_path(old_path: String, new_path: String) -> Result<(), String> {
    std::fs::rename(&old_path, &new_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
}

fn unique_dst(dst: &Path) -> std::path::PathBuf {
    if !dst.exists() {
        return dst.to_path_buf();
    }
    let stem = dst.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = dst.extension().and_then(|e| e.to_str()).unwrap_or("");
    let parent = dst.parent().unwrap_or(Path::new("."));
    let mut i = 1u32;
    loop {
        let name = if ext.is_empty() {
            format!("{} ({})", stem, i)
        } else {
            format!("{} ({}).{}", stem, i, ext)
        };
        let candidate = parent.join(&name);
        if !candidate.exists() {
            return candidate;
        }
        i += 1;
    }
}

fn copy_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if src.is_dir() {
        std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else {
        std::fs::copy(src, dst).map(|_| ()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn copy_path(src: String, dst_dir: String) -> Result<String, String> {
    let src_path = Path::new(&src);
    let file_name = src_path.file_name().ok_or("Invalid source path")?;
    let dst = unique_dst(&Path::new(&dst_dir).join(file_name));
    copy_recursive(src_path, &dst)?;
    Ok(dst.to_string_lossy().to_string())
}

#[tauri::command]
pub fn move_path(src: String, dst_dir: String) -> Result<String, String> {
    let src_path = Path::new(&src);
    let file_name = src_path.file_name().ok_or("Invalid source path")?;
    let dst = unique_dst(&Path::new(&dst_dir).join(file_name));
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    // Ensure parent exists
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::File::create(&path).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn duplicate_file(path: String) -> Result<String, String> {
    let src = Path::new(&path);
    let parent = src.parent().ok_or("No parent directory")?;
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("");
    let mut i = 1u32;
    loop {
        let name = if ext.is_empty() {
            format!("{} ({})", stem, i)
        } else {
            format!("{} ({}).{}", stem, i, ext)
        };
        let dst = parent.join(&name);
        if !dst.exists() {
            copy_recursive(src, &dst)?;
            return Ok(dst.to_string_lossy().to_string());
        }
        i += 1;
    }
}

#[tauri::command]
pub fn open_with_default(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let p = Path::new(&path);
        let target = if p.is_dir() {
            path.clone()
        } else {
            p.parent()
                .map(|d| d.to_string_lossy().to_string())
                .unwrap_or(path.clone())
        };
        std::process::Command::new("explorer.exe")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
