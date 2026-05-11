use serde::Serialize;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
pub struct ArchiveEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub compressed_size: u64,
}

enum Format {
    Zip,
    TarGz,
    Tar,
    Unsupported(String),
}

fn detect(path: &str) -> Format {
    let lower = path.to_lowercase();
    if lower.ends_with(".zip") {
        Format::Zip
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        Format::TarGz
    } else if lower.ends_with(".tar") {
        Format::Tar
    } else {
        let ext = Path::new(path)
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default();
        Format::Unsupported(ext)
    }
}

// ── List ──────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_archive(path: String) -> Result<Vec<ArchiveEntry>, String> {
    match detect(&path) {
        Format::Zip => list_zip(&path),
        Format::TarGz => {
            let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
            let gz = flate2::read::GzDecoder::new(file);
            let mut ar = tar::Archive::new(gz);
            collect_tar_entries(&mut ar)
        }
        Format::Tar => {
            let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
            let mut ar = tar::Archive::new(file);
            collect_tar_entries(&mut ar)
        }
        Format::Unsupported(ext) => Err(format!("Format .{ext} non supporté")),
    }
}

fn list_zip(path: &str) -> Result<Vec<ArchiveEntry>, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let raw = entry.name().to_string();
        let normalised = raw.trim_end_matches('/').replace('\\', "/");
        if normalised.is_empty() {
            continue;
        }
        let name = Path::new(&normalised)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| normalised.clone());
        entries.push(ArchiveEntry {
            path: normalised,
            name,
            is_dir: entry.is_dir(),
            size: entry.size(),
            compressed_size: entry.compressed_size(),
        });
    }
    Ok(entries)
}

fn collect_tar_entries<R: io::Read>(archive: &mut tar::Archive<R>) -> Result<Vec<ArchiveEntry>, String> {
    let mut entries = Vec::new();
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let raw = entry.path().map_err(|e| e.to_string())?;
        let normalised = raw.to_string_lossy().replace('\\', "/");
        let normalised = normalised.trim_end_matches('/').to_string();
        if normalised.is_empty() || normalised == "." {
            continue;
        }
        let name = Path::new(&normalised)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| normalised.clone());
        let is_dir = entry.header().entry_type().is_dir();
        let size = entry.header().size().unwrap_or(0);
        entries.push(ArchiveEntry {
            path: normalised,
            name,
            is_dir,
            size,
            compressed_size: 0,
        });
    }
    Ok(entries)
}

// ── Extract ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn extract_archive(path: String, dest: String) -> Result<u64, String> {
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let dest_path = Path::new(&dest);
    match detect(&path) {
        Format::Zip => extract_zip(&path, dest_path),
        Format::TarGz => {
            let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
            let gz = flate2::read::GzDecoder::new(file);
            let mut ar = tar::Archive::new(gz);
            unpack_tar(&mut ar, dest_path)
        }
        Format::Tar => {
            let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
            let mut ar = tar::Archive::new(file);
            unpack_tar(&mut ar, dest_path)
        }
        Format::Unsupported(ext) => Err(format!("Format .{ext} non supporté")),
    }
}

fn sanitize_path(base: &Path, entry_path: &str) -> Option<PathBuf> {
    let trimmed = entry_path.trim_start_matches('/').trim_start_matches('\\');
    let candidate = base.join(trimmed);
    if candidate.starts_with(base) { Some(candidate) } else { None }
}

fn extract_zip(path: &str, dest: &Path) -> Result<u64, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut count = 0u64;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let out = match sanitize_path(dest, entry.name()) {
            Some(p) => p,
            None => continue,
        };
        if entry.is_dir() {
            std::fs::create_dir_all(&out).ok();
        } else {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            let mut f = std::fs::File::create(&out).map_err(|e| e.to_string())?;
            io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
            count += 1;
        }
    }
    Ok(count)
}

fn unpack_tar<R: io::Read>(archive: &mut tar::Archive<R>, dest: &Path) -> Result<u64, String> {
    let mut count = 0u64;
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let raw = entry.path().map_err(|e| e.to_string())?;
        let rel = raw.to_string_lossy().to_string();
        let out = match sanitize_path(dest, &rel) {
            Some(p) => p,
            None => continue,
        };
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&out).ok();
        } else {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            entry.unpack(&out).map_err(|e| e.to_string())?;
            count += 1;
        }
    }
    Ok(count)
}

// ── Create ZIP ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn create_zip(source_paths: Vec<String>, dest: String) -> Result<(), String> {
    let out = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(out);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for source_str in &source_paths {
        let source = Path::new(source_str);
        if source.is_file() {
            let name = source
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".to_string());
            zip.start_file(&name, options).map_err(|e| e.to_string())?;
            let mut f = std::fs::File::open(source).map_err(|e| e.to_string())?;
            io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
        } else if source.is_dir() {
            let base = source.parent().unwrap_or(source);
            for entry in walkdir::WalkDir::new(source).into_iter().filter_map(|e| e.ok()) {
                let rel = entry
                    .path()
                    .strip_prefix(base)
                    .map_err(|e| e.to_string())?;
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                if rel_str.is_empty() {
                    continue;
                }
                if entry.file_type().is_dir() {
                    zip.add_directory(format!("{rel_str}/"), options)
                        .map_err(|e| e.to_string())?;
                } else {
                    zip.start_file(&rel_str, options).map_err(|e| e.to_string())?;
                    let mut f = std::fs::File::open(entry.path()).map_err(|e| e.to_string())?;
                    io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}
