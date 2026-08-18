//! Tauri commands for encrypted vaults. See CLAUDE.md §43.
//!
//! ## Error strings are user-facing
//!
//! Every `Err(String)` here lands in a toast or a modal, so they are written as
//! sentences a non-technical person can act on ("Wrong password" / "This folder
//! is already a vault"), not as debug output. The one thing they must never do
//! is distinguish *why* a secret failed — `WrongSecret` covers both "wrong
//! password" and "tampered key slot" on purpose.
//!
//! ## The cardinal rule
//!
//! **A vault's plaintext must never reach the database.** These commands never
//! write to `files`, `file_content`, FTS5, `activity` or `snapshots`. The
//! exclusion helpers in `crate::vault::format::is_vault` / `path_is_in_vault`
//! are what keep the *rest* of the app out; this module simply never puts it in.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::vault::{
    self,
    format::{self, VaultError},
    state, Secret,
};
use crate::AppState;

/// Turn a `VaultError` into the sentence the user sees.
fn ui_err(e: VaultError) -> String {
    e.to_string()
}

/// One entry inside an unlocked vault at a given level — either a file or a
/// virtual sub-folder. Folders are not stored anywhere; they are derived from
/// the `/`-separated relative-path keys in the encrypted index, so the on-disk
/// blobs stay flat and the folder structure never leaks to disk.
#[derive(Serialize)]
pub struct VaultEntry {
    /// Leaf name at this level (not the full path). Combined with the current
    /// `sub_path` by the caller to form the full index key for open/delete.
    pub name: String,
    pub is_dir: bool,
    /// File: plaintext size in bytes (blob size minus AEAD overhead — exact,
    /// no decryption needed). Folder: number of files it contains (recursively).
    pub size: u64,
    pub modified_at: i64,
}

/// A vault currently held open in memory.
#[derive(Serialize)]
pub struct UnlockedVaultInfo {
    pub path: String,
    /// Seconds since the last operation on this vault. The UI turns this into
    /// the auto-lock countdown.
    pub idle_secs: u64,
}

/// AEAD overhead per blob: 24-byte XChaCha nonce + 16-byte Poly1305 tag.
const BLOB_OVERHEAD: u64 = 24 + 16;

// ── Detection ────────────────────────────────────────────────────────────────

/// Is this folder an encrypted vault? Drives the lock icon in the file list.
#[tauri::command]
pub fn vault_is_vault(path: String) -> bool {
    format::is_vault(Path::new(&path))
}

/// Is it currently unlocked? Drives the open-lock icon and the "Lock" action.
#[tauri::command]
pub fn vault_is_unlocked(path: String) -> bool {
    state::is_unlocked(Path::new(&path))
}

/// Is this path a vault, or anywhere INSIDE one? The AI panel calls this before
/// every tool that touches the filesystem.
///
/// Note it returns true for LOCKED vaults too, not just unlocked ones. A locked
/// vault's blobs are unreadable, but an AI `plan_moves` could still happily drag
/// a `.dat` file out of the folder — severing it from the encrypted index and
/// making it permanently undecryptable. "Protected" means hands off, in both
/// states.
#[tauri::command]
pub fn vault_path_is_protected(path: String) -> bool {
    format::path_is_in_vault(Path::new(&path))
}

/// Every vault held open right now, with idle seconds — powers the status bar.
#[tauri::command]
pub fn vault_unlocked_list() -> Vec<UnlockedVaultInfo> {
    state::unlocked_list()
        .into_iter()
        .map(|(path, idle_secs)| UnlockedVaultInfo {
            path: path.to_string_lossy().to_string(),
            idle_secs,
        })
        .collect()
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/// Turn a folder into a vault. Returns the recovery code — shown to the user
/// exactly once, never stored anywhere in plaintext.
///
/// Existing files are NOT encrypted here; the caller follows up with
/// `vault_encrypt_existing` so a partial bulk-encryption can be retried without
/// the header being in a half-created state.
#[tauri::command]
pub fn vault_create(
    path: String,
    password: String,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    if password.is_empty() {
        return Err("Password cannot be empty".to_string());
    }
    let code = vault::create_vault(Path::new(&path), &password).map_err(ui_err)?;

    // The folder may have been indexed BEFORE it became a vault — in which case
    // `files` / `file_content` / FTS5 are holding its file names and extracted
    // text in the clear, in a database that is NOT encrypted. Locking the vault
    // would then leave a perfectly searchable copy of its contents behind, which
    // silently defeats the entire feature. Purge those rows now.
    //
    // Failure here is NOT fatal to vault creation (the vault exists and is
    // sound), but it is reported so the UI can warn rather than pretend.
    purge_index_under(&path, &state)?;
    Ok(code)
}

/// Delete every indexed trace of a folder's contents. `file_content` and the
/// FTS5 tables hang off `files.id` with `ON DELETE CASCADE`, so removing the
/// `files` rows takes the extracted text and the search index with them.
fn purge_index_under(path: &str, state: &AppState) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    // Match everything strictly BENEATH the folder. The trailing separator is
    // load-bearing: `path LIKE 'C:\Secret%'` (no separator) also matches a
    // sibling `C:\SecretPlans\...`, and deleting those `files` rows would
    // cascade-delete the user's TAGS (file_tags ON DELETE CASCADE) on an
    // unrelated folder — silent, permanent data loss. We also LIKE-escape
    // `%` / `_` (and the `\` escape char) so a vault path containing them
    // can't widen the match either.
    //
    // `files.path` is stored OS-native (backslashes on Windows) but callers may
    // hand us either flavour, so we purge under both spellings.
    let trimmed = path.trim_end_matches(['/', '\\']);
    let bs = format!("{}\\\\%", like_escape(&trimmed.replace('/', "\\"))); // …\Secret\%
    let fs = format!("{}/%", like_escape(&trimmed.replace('\\', "/"))); // …/Secret/%
    db.execute(
        "DELETE FROM files WHERE path LIKE ?1 ESCAPE '\\' OR path LIKE ?2 ESCAPE '\\'",
        rusqlite::params![bs, fs],
    )
    .map_err(|e| format!("Vault created, but its old search-index entries could not be removed: {}", e))?;
    db.execute(
        "DELETE FROM directories WHERE path LIKE ?1 ESCAPE '\\' OR path LIKE ?2 ESCAPE '\\'",
        rusqlite::params![bs, fs],
    )
    .ok();
    Ok(())
}

/// Escape LIKE metacharacters (`%`, `_`) and the `\` escape char so a literal
/// path can be used as a LIKE prefix under `ESCAPE '\'`. Order matters: the
/// backslash pass must run first so it doesn't double-escape the `\` we add
/// in front of `%` / `_`.
fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Unlock with a password. On success the master key lives in RAM until the
/// vault is locked (explicitly, by the idle timer, or on app close).
#[tauri::command]
pub fn vault_unlock(path: String, password: String) -> Result<(), String> {
    let dir = Path::new(&path);
    let (key, index) = vault::unlock_vault(dir, Secret::Password(&password)).map_err(ui_err)?;
    state::insert(dir, key, index);
    Ok(())
}

/// Unlock with the printable recovery code (user forgot the password).
#[tauri::command]
pub fn vault_unlock_with_recovery(path: String, recovery_code: String) -> Result<(), String> {
    let dir = Path::new(&path);
    let (key, index) =
        vault::unlock_vault(dir, Secret::RecoveryCode(&recovery_code)).map_err(ui_err)?;
    state::insert(dir, key, index);
    Ok(())
}

/// Drop the master key and delete this vault's decrypted temp files.
#[tauri::command]
pub fn vault_lock(path: String) -> Result<(), String> {
    state::lock(Path::new(&path));
    Ok(())
}

/// Lock every open vault. Called by the "Lock all" button and on app close.
#[tauri::command]
pub fn vault_lock_all() -> usize {
    state::lock_all()
}

#[tauri::command]
pub fn vault_change_password(
    path: String,
    old_password: String,
    new_password: String,
) -> Result<(), String> {
    if new_password.is_empty() {
        return Err("New password cannot be empty".to_string());
    }
    vault::change_password(Path::new(&path), &old_password, &new_password).map_err(ui_err)
}

/// Reset a forgotten password using the recovery code. Every file survives —
/// only the password key slot is rewritten.
#[tauri::command]
pub fn vault_reset_password(
    path: String,
    recovery_code: String,
    new_password: String,
) -> Result<(), String> {
    if new_password.is_empty() {
        return Err("New password cannot be empty".to_string());
    }
    vault::reset_password_with_recovery(Path::new(&path), &recovery_code, &new_password)
        .map_err(ui_err)
}

// ── Contents ─────────────────────────────────────────────────────────────────

fn require_unlocked<T>(
    dir: &Path,
    f: impl FnOnce(&vault::VaultKey, &mut format::VaultIndex) -> Result<T, String>,
) -> Result<T, String> {
    state::with_vault(dir, f).unwrap_or_else(|| Err("This vault is locked".to_string()))
}

/// Normalize a vault sub-path: strip surrounding slashes, unify separators.
/// `""` means the vault root. Used as a prefix against the index's `/`-keys.
fn norm_sub(sub: &str) -> String {
    sub.replace('\\', "/").trim_matches('/').to_string()
}

/// Given all index keys and a sub-path, return the immediate children at that
/// level: `(folder_name → recursive file count, leaf file keys)`. Pure so it
/// can be unit-tested without a live vault. A key `a/b/c.pdf` under sub `a`
/// yields folder `b`; under sub `a/b` it yields file `c.pdf`.
fn immediate_children<'a>(
    keys: impl Iterator<Item = &'a String>,
    sub: &str,
) -> (std::collections::BTreeMap<String, u64>, Vec<String>) {
    let prefix = if sub.is_empty() { String::new() } else { format!("{}/", sub) };
    let mut folders: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
    let mut files: Vec<String> = Vec::new();
    for key in keys {
        let rest = if prefix.is_empty() {
            key.as_str()
        } else if let Some(r) = key.strip_prefix(&prefix) {
            r
        } else {
            continue; // not under this sub-path
        };
        match rest.split_once('/') {
            Some((folder, _)) => *folders.entry(folder.to_string()).or_insert(0) += 1,
            None => files.push(rest.to_string()),
        }
    }
    (folders, files)
}

/// List the immediate entries (sub-folders + files) at `sub_path` inside an
/// unlocked vault. `sub_path` is `None`/empty for the vault root. Folders are
/// virtual — derived from the `/`-separated keys — and returned first.
#[tauri::command]
pub fn vault_list(path: String, sub_path: Option<String>) -> Result<Vec<VaultEntry>, String> {
    let dir = PathBuf::from(&path);
    let sub = norm_sub(&sub_path.unwrap_or_default());
    require_unlocked(&dir, |_key, index| {
        let (folders, files) = immediate_children(index.files.keys(), &sub);

        let mut out: Vec<VaultEntry> = folders
            .into_iter()
            .map(|(name, count)| VaultEntry { name, is_dir: true, size: count, modified_at: 0 })
            .collect();

        let prefix = if sub.is_empty() { String::new() } else { format!("{}/", sub) };
        let mut file_entries: Vec<VaultEntry> = files
            .into_iter()
            .map(|leaf| {
                let full_key = format!("{}{}", prefix, leaf);
                // Size + mtime from the blob's own metadata — no decryption to list.
                let meta = index
                    .files
                    .get(&full_key)
                    .and_then(|blob_id| std::fs::metadata(format::blob_path(&dir, blob_id)).ok());
                let raw = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                VaultEntry {
                    name: leaf,
                    is_dir: false,
                    size: raw.saturating_sub(BLOB_OVERHEAD),
                    modified_at: meta
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0),
                }
            })
            .collect();
        file_entries.sort_by_key(|a| a.name.to_lowercase());
        out.extend(file_entries);
        Ok(out)
    })
}

/// A destination path under `dir` for `leaf` that does not overwrite an existing
/// file — appends " (1)", " (2)", … like the file manager does. Extraction must
/// never clobber a file the user already has outside the vault.
fn unique_extract_path(dir: &Path, leaf: &str) -> PathBuf {
    let candidate = dir.join(leaf);
    if !candidate.exists() {
        return candidate;
    }
    let p = Path::new(leaf);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or(leaf);
    let ext = p.extension().and_then(|e| e.to_str());
    let mut i = 1u32;
    loop {
        let name = match ext {
            Some(e) => format!("{} ({}).{}", stem, i, e),
            None => format!("{} ({})", stem, i),
        };
        let c = dir.join(name);
        if !c.exists() {
            return c;
        }
        i += 1;
    }
}

/// Extract (copy OUT) a vault file to a plaintext file in `dest_dir`. The file
/// stays in the vault — this is a decrypt-and-copy, the user's deliberate way to
/// get a copy out. Returns the path written. Never overwrites an existing file.
#[tauri::command]
pub fn vault_extract_file(path: String, name: String, dest_dir: String) -> Result<String, String> {
    let dir = PathBuf::from(&path);
    let blob_id = require_unlocked(&dir, |_key, index| {
        index
            .files
            .get(&name)
            .cloned()
            .ok_or_else(|| format!("'{}' is not in this vault", name))
    })?;

    let leaf = name.rsplit('/').next().unwrap_or(&name);
    let dest = unique_extract_path(&PathBuf::from(&dest_dir), leaf);

    // Stream-decrypt straight into the destination (key never leaves the lock),
    // so extracting a large file doesn't buffer it whole in RAM. On failure,
    // remove the partial file so we never leave half-plaintext behind.
    let mut out = std::fs::File::create(&dest)
        .map_err(|e| format!("Cannot write to the destination: {}", e))?;
    let decrypt = require_unlocked(&dir, |key, _index| {
        vault::read_blob_to_writer(&dir, key, &blob_id, &mut out).map_err(ui_err)
    });
    if let Err(e) = decrypt {
        drop(out);
        let _ = std::fs::remove_file(&dest);
        return Err(e);
    }
    Ok(dest.to_string_lossy().to_string())
}

/// Decrypt a file to a temp path so an existing viewer can open it.
///
/// The temp file is tracked and deleted when the vault locks; a startup sweep
/// (`purge_orphaned_temp_files`) catches any that survive a crash. This is the
/// V1 trade-off: plaintext touches the disk in a user-ACL folder rather than
/// every viewer being refactored to take bytes over IPC. See CLAUDE.md §38.
#[tauri::command]
pub fn vault_read_file(path: String, name: String) -> Result<String, String> {
    let dir = PathBuf::from(&path);
    let blob_id = require_unlocked(&dir, |_key, index| {
        index
            .files
            .get(&name)
            .cloned()
            .ok_or_else(|| format!("'{}' is not in this vault", name))
    })?;

    let tmp_dir = state::temp_dir().ok_or("Cannot resolve the temp folder")?;
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("Cannot create temp folder: {}", e))?;

    // Name the temp file with a RANDOM id + the real EXTENSION only — never the
    // real basename. The temp PATH gets persisted in places we don't fully
    // control (a restored-open-tabs list in the DB, for one), and a basename
    // there would leak a vault filename the encrypted index is meant to hide.
    // Nothing needs the name in the path: the viewer shows it from the tab
    // metadata (in RAM), and write-back re-encrypts by the name tracked in
    // `track_temp_file`. The extension is kept so extension-based viewer/handler
    // dispatch still works. A random id also stops two vaults' files colliding.
    let ext = Path::new(&name).extension().and_then(|e| e.to_str()).unwrap_or("");
    let tmp_name = if ext.is_empty() {
        format::generate_blob_id()
    } else {
        format!("{}.{}", format::generate_blob_id(), ext)
    };
    let tmp_path = tmp_dir.join(tmp_name);

    // Stream-decrypt straight into the temp file inside the lock (key never
    // escapes it), so a multi-GB vault file isn't buffered whole in RAM. If the
    // decrypt fails, drop the half-written temp so no partial plaintext lingers.
    let mut tmp_file = std::fs::File::create(&tmp_path)
        .map_err(|e| format!("Cannot write the decrypted file: {}", e))?;
    let decrypt = require_unlocked(&dir, |key, _index| {
        vault::read_blob_to_writer(&dir, key, &blob_id, &mut tmp_file).map_err(ui_err)
    });
    if let Err(e) = decrypt {
        drop(tmp_file);
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }

    // Track the temp WITH its vault entry name — that mapping is what lets a
    // later save be re-encrypted back into the vault instead of being written
    // to the temp copy and then deleted on lock (silently losing the user's work).
    state::track_temp_file(&dir, tmp_path.clone(), name.clone());

    Ok(tmp_path.to_string_lossy().to_string())
}

/// Is this path a decrypted vault temp file, and which vault entry is it?
/// The viewers call this to decide whether a save must be re-encrypted.
/// Returns `null` for ordinary files (and for a vault that has since locked).
#[derive(Serialize)]
pub struct TempTarget {
    pub vault_path: String,
    pub name: String,
}

#[tauri::command]
pub fn vault_temp_target(path: String) -> Option<TempTarget> {
    state::resolve_temp(Path::new(&path)).map(|(dir, name)| TempTarget {
        vault_path: dir.to_string_lossy().to_string(),
        name,
    })
}

/// Save an edited vault file: re-encrypt it into the vault, and refresh the
/// decrypted temp copy so the viewer doesn't read stale bytes if it reloads.
///
/// Errors — never destructive:
///   - The vault locked between opening and saving (idle sweeper, "Lock all",
///     another window): we return a clear message and change NOTHING. The
///     caller still holds the user's text in its editor buffer, so the fix is
///     "unlock and press save again", not "your work is gone". This is the case
///     that matters: the sweeper firing mid-edit must never cost anyone a
///     document.
///   - The re-encryption itself fails: `vault_write_file` rolls the index back
///     and deletes the orphan blob, so the vault is left exactly as it was.
#[tauri::command]
pub fn vault_write_back(temp_path: String, content: Vec<u8>) -> Result<(), String> {
    let tmp = PathBuf::from(&temp_path);
    let (vault_dir, name) = state::resolve_temp(&tmp).ok_or_else(|| {
        "This vault was locked while you were editing. Unlock it and save again — your changes are still here.".to_string()
    })?;

    vault_write_file(
        vault_dir.to_string_lossy().to_string(),
        name,
        content.clone(),
    )?;

    // Keep the on-disk temp in step with what's now in the vault. Without this,
    // closing and re-opening the tab (without locking) would re-read the OLD
    // bytes and the user would watch their save silently revert.
    std::fs::write(&tmp, &content)
        .map_err(|e| format!("Saved to the vault, but the working copy could not be refreshed: {}", e))
}

/// Point `name` at `new_blob` in the index and persist. On a failed save, roll the
/// in-memory index back and delete the orphaned new blob (so RAM and disk stay in
/// agreement and nothing dangles); on success, delete the blob the name used to
/// point at. Shared by every "write a file into the vault" path.
fn commit_blob(dir: &Path, name: &str, new_blob: String) -> Result<(), String> {
    // Swap the index entry only AFTER the new blob is safely on disk.
    let old_blob =
        require_unlocked(dir, |_key, index| Ok(index.files.insert(name.to_string(), new_blob.clone())))?;

    let save = require_unlocked(dir, |key, index| vault::save_index(dir, key, index).map_err(ui_err));
    if let Err(e) = save {
        let _ = require_unlocked(dir, |_key, index| {
            match &old_blob {
                Some(prev) => index.files.insert(name.to_string(), prev.clone()),
                None => index.files.remove(name),
            };
            Ok(())
        });
        let _ = vault::delete_blob(dir, &new_blob);
        return Err(e);
    }

    if let Some(prev) = old_blob {
        let _ = vault::delete_blob(dir, &prev);
    }
    Ok(())
}

/// Encrypt in-memory bytes into the vault under `name`, replacing any existing
/// entry. Used for content already in RAM — chiefly an edited text file coming
/// back through write-back.
#[tauri::command]
pub fn vault_write_file(path: String, name: String, content: Vec<u8>) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if name.trim().is_empty() {
        return Err("File name cannot be empty".to_string());
    }
    let new_blob =
        require_unlocked(&dir, |key, _index| vault::write_blob(&dir, key, &content).map_err(ui_err))?;
    commit_blob(&dir, &name, new_blob)
}

/// Move a plaintext file from disk INTO the vault: STREAM-encrypt it (chunked, so
/// a multi-GB file never lands wholly in RAM), then delete the original — but only
/// after the encrypted copy is committed, so a failure anywhere leaves the source
/// untouched. `dest_dir` is the sub-folder to place it in (`None`/empty = root).
#[tauri::command]
pub fn vault_add_file(path: String, src: String, dest_dir: Option<String>) -> Result<(), String> {
    let src_path = PathBuf::from(&src);
    let base = src_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid file name")?
        .to_string();
    let dest = norm_sub(&dest_dir.unwrap_or_default());
    let name = if dest.is_empty() { base.clone() } else { format!("{}/{}", dest, base) };

    let dir = PathBuf::from(&path);
    let new_blob = require_unlocked(&dir, |key, _index| {
        let f = std::fs::File::open(&src_path).map_err(|e| format!("Cannot read '{}': {}", base, e))?;
        vault::write_blob_from_reader(&dir, key, f).map_err(ui_err)
    })?;
    commit_blob(&dir, &name, new_blob)?;

    // Only now is it safe to remove the plaintext original.
    std::fs::remove_file(&src_path)
        .map_err(|e| format!("Encrypted, but the original could not be deleted: {}", e))
}

#[tauri::command]
pub fn vault_delete_file(path: String, name: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    let blob_id = require_unlocked(&dir, |_key, index| {
        index
            .files
            .remove(&name)
            .ok_or_else(|| format!("'{}' is not in this vault", name))
    })?;
    require_unlocked(&dir, |key, index| {
        vault::save_index(&dir, key, index).map_err(ui_err)
    })?;
    let _ = vault::delete_blob(&dir, &blob_id);
    Ok(())
}

/// Delete a whole virtual sub-folder inside the vault: every file whose key is
/// under `sub_path/` is removed (index entries first, then their blobs, mirroring
/// `vault_delete_file`'s ordering so a crash can't leave the index pointing at a
/// gone blob).
#[tauri::command]
pub fn vault_delete_folder(path: String, sub_path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    let sub = norm_sub(&sub_path);
    if sub.is_empty() {
        return Err("No folder specified".to_string());
    }
    let prefix = format!("{}/", sub);

    let removed_blobs: Vec<String> = require_unlocked(&dir, |_key, index| {
        let keys: Vec<String> = index
            .files
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        let mut blobs = Vec::with_capacity(keys.len());
        for k in &keys {
            if let Some(b) = index.files.remove(k) {
                blobs.push(b);
            }
        }
        Ok(blobs)
    })?;

    if removed_blobs.is_empty() {
        return Ok(()); // nothing under that path — treat as success
    }

    require_unlocked(&dir, |key, index| {
        vault::save_index(&dir, key, index).map_err(ui_err)
    })?;
    for b in removed_blobs {
        let _ = vault::delete_blob(&dir, &b);
    }
    Ok(())
}

/// Re-key the index for a rename — pure (no IO), so it's unit-testable. Validates
/// EVERYTHING before mutating, so on an `Err` the map is untouched. Renaming a
/// file moves one key→blob mapping; renaming a folder re-prefixes every key under
/// it. No blob is ever read, written or moved: the folder tree is virtual.
fn rename_in_index(
    files: &mut std::collections::BTreeMap<String, String>,
    old_key: &str,
    new_key: &str,
    new_leaf: &str,
    is_dir: bool,
) -> Result<(), String> {
    if is_dir {
        let old_prefix = format!("{}/", old_key);
        let new_prefix = format!("{}/", new_key);
        // Collision: a file OR folder already occupies the destination name.
        if files.keys().any(|k| k == new_key || k.starts_with(&new_prefix)) {
            return Err(format!("\"{}\" already exists", new_leaf));
        }
        let to_move: Vec<(String, String)> = files
            .iter()
            .filter(|(k, _)| k.starts_with(&old_prefix))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        if to_move.is_empty() {
            return Err("Folder not found".to_string());
        }
        // All checks passed — now mutate.
        for (k, _) in &to_move {
            files.remove(k);
        }
        for (k, v) in to_move {
            let suffix = &k[old_prefix.len()..];
            files.insert(format!("{}{}", new_prefix, suffix), v);
        }
    } else {
        // Collision with a file of that name OR a folder of that name.
        let folder_prefix = format!("{}/", new_key);
        if files.contains_key(new_key) || files.keys().any(|k| k.starts_with(&folder_prefix)) {
            return Err(format!("\"{}\" already exists", new_leaf));
        }
        if !files.contains_key(old_key) {
            return Err("File not found".to_string());
        }
        let blob = files.remove(old_key).unwrap();
        files.insert(new_key.to_string(), blob);
    }
    Ok(())
}

/// Rename a file or a whole sub-folder inside an unlocked vault. `old_name` /
/// `new_name` are the LEAF names at `sub_path`; the full keys are built here so
/// the frontend can't hand us a traversal. No blob is touched — only the
/// encrypted index is re-keyed and re-saved (with in-memory rollback on a failed
/// save, so RAM never diverges from disk).
#[tauri::command]
pub fn vault_rename(
    path: String,
    sub_path: Option<String>,
    old_name: String,
    new_name: String,
    is_dir: bool,
) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    let new_leaf = new_name.trim();
    if new_leaf.is_empty() {
        return Err("Name cannot be empty".to_string());
    }
    if new_leaf.contains('/') || new_leaf.contains('\\') || new_leaf == "." || new_leaf == ".." {
        return Err("Name cannot contain a path separator".to_string());
    }
    if new_leaf == old_name {
        return Ok(()); // no-op
    }

    let sub = norm_sub(&sub_path.unwrap_or_default());
    let keyed = |leaf: &str| {
        if sub.is_empty() {
            leaf.to_string()
        } else {
            format!("{}/{}", sub, leaf)
        }
    };
    let old_key = keyed(&old_name);
    let new_key = keyed(new_leaf);

    require_unlocked(&dir, |key, index| {
        let snapshot = index.files.clone();
        rename_in_index(&mut index.files, &old_key, &new_key, new_leaf, is_dir)?;
        if let Err(e) = vault::save_index(&dir, key, index) {
            index.files = snapshot; // keep RAM consistent with disk on failure
            return Err(ui_err(e));
        }
        Ok(())
    })
}

/// Recursively collect every plaintext file under `cur`, paired with its
/// `/`-separated path RELATIVE to the vault `root`. Skips vault metadata and our
/// own blobs (which only ever live at the root). Pure filesystem read — testable
/// against a real temp tree.
fn collect_plaintext_files(
    root: &Path,
    cur: &Path,
    known_blobs: &std::collections::HashSet<String>,
    out: &mut Vec<(PathBuf, String)>,
) -> std::io::Result<()> {
    for e in std::fs::read_dir(cur)? {
        let e = e?;
        let p = e.path();
        if p.is_dir() {
            collect_plaintext_files(root, &p, known_blobs, out)?;
            continue;
        }
        let rel = p.strip_prefix(root).unwrap_or(&p);
        let rel_key = rel.to_string_lossy().replace('\\', "/");

        // Vault metadata + our own blobs only ever sit at the ROOT (blobs are
        // written flat via `blob_path`). A `.dat` inside a sub-folder is a user
        // file and MUST be encrypted, so only apply the skip at depth 0.
        if !rel_key.contains('/') {
            let fname = p.file_name().unwrap_or_default().to_string_lossy();
            if fname == format::VAULT_FILE || fname.starts_with(&format!("{}.", format::VAULT_FILE)) {
                continue;
            }
            let is_our_blob = p.extension().and_then(|x| x.to_str()) == Some(format::BLOB_EXT)
                && p.file_stem()
                    .and_then(|s| s.to_str())
                    .map(|stem| known_blobs.contains(stem))
                    .unwrap_or(false);
            if is_our_blob {
                continue;
            }
        }
        out.push((p.clone(), rel_key));
    }
    Ok(())
}

/// Remove now-empty sub-directories under `dir` (deepest first). Best-effort:
/// `remove_dir` only succeeds on an empty directory, so a folder still holding a
/// file we intentionally skipped is left untouched. Never removes `dir` itself.
fn remove_empty_subdirs(dir: &Path) {
    fn recurse(p: &Path) {
        if let Ok(rd) = std::fs::read_dir(p) {
            for e in rd.flatten() {
                let cp = e.path();
                if cp.is_dir() {
                    recurse(&cp);
                }
            }
        }
        let _ = std::fs::remove_dir(p); // no-op if not empty
    }
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let cp = e.path();
            if cp.is_dir() {
                recurse(&cp);
            }
        }
    }
}

/// Encrypt every loose plaintext file already sitting in the vault folder —
/// INCLUDING those in sub-folders. The folder structure is preserved as
/// `/`-separated keys in the encrypted index while the blobs stay flat on disk,
/// so encrypting a folder tree leaves nothing readable behind and the structure
/// itself never leaks.
///
/// Called right after `vault_create`. Resumable by design: files are collected
/// FIRST (so blobs we create mid-run aren't re-collected), then each is
/// encrypted, indexed and only THEN deleted — a crash halfway leaves the rest
/// still plainly there, and running it again finishes the job. Nothing is lost.
///
/// Returns how many files were encrypted.
#[tauri::command]
pub fn vault_encrypt_existing(path: String) -> Result<usize, String> {
    let dir = PathBuf::from(&path);
    if !state::is_unlocked(&dir) {
        return Err("This vault is locked".to_string());
    }

    // Which `.dat` files are OURS. Checked against the index, not by extension:
    // skipping every `*.dat` would silently leave a user's own `backup.dat` /
    // `save.dat` UNENCRYPTED in a folder they believe is protected — a plaintext
    // leak that looks exactly like success.
    let known_blobs: std::collections::HashSet<String> =
        require_unlocked(&dir, |_key, index| Ok(index.files.values().cloned().collect()))?;

    let mut to_encrypt: Vec<(PathBuf, String)> = Vec::new();
    collect_plaintext_files(&dir, &dir, &known_blobs, &mut to_encrypt)
        .map_err(|e| format!("Cannot read the folder: {}", e))?;

    let mut count = 0usize;
    for (abs, rel_key) in &to_encrypt {
        let content =
            std::fs::read(abs).map_err(|e| format!("Cannot read '{}': {}", rel_key, e))?;
        vault_write_file(path.clone(), rel_key.clone(), content)?;
        std::fs::remove_file(abs).map_err(|e| {
            format!("Encrypted '{}', but the original could not be deleted: {}", rel_key, e)
        })?;
        count += 1;
    }

    // The plaintext tree is gone; drop the emptied sub-directories so the vault
    // folder shows only blobs + the header.
    remove_empty_subdirs(&dir);

    Ok(count)
}

// ── Settings-backed idle timeout ─────────────────────────────────────────────

/// Read `vaultIdleLockSecs` from the settings table. `0` = never auto-lock.
/// Falls back to the 15-minute default when the row is missing or unparseable —
/// a corrupt setting must never mean "keep vaults open forever".
pub fn idle_lock_secs(state: &AppState) -> u64 {
    state
        .db
        .lock()
        .ok()
        .and_then(|db| {
            db.query_row(
                "SELECT value FROM settings WHERE key = 'vaultIdleLockSecs'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()
        })
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(state::DEFAULT_IDLE_LOCK_SECS)
}

#[cfg(test)]
mod tests {
    use super::{collect_plaintext_files, immediate_children, like_escape, norm_sub, rename_in_index};
    use std::collections::{BTreeMap, HashSet};
    use std::path::PathBuf;

    fn index_of(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn rename_file_moves_the_key_and_keeps_the_blob() {
        let mut files = index_of(&[("a.txt", "blob1"), ("photos/x.jpg", "blob2")]);
        rename_in_index(&mut files, "a.txt", "b.txt", "b.txt", false).unwrap();
        assert_eq!(files.get("b.txt"), Some(&"blob1".to_string()));
        assert!(!files.contains_key("a.txt"));
        // Same blob id — no re-encryption happened.
        assert_eq!(files.get("photos/x.jpg"), Some(&"blob2".to_string()));
    }

    #[test]
    fn rename_file_rejects_a_name_collision() {
        let mut files = index_of(&[("a.txt", "b1"), ("b.txt", "b2")]);
        let err = rename_in_index(&mut files, "a.txt", "b.txt", "b.txt", false).unwrap_err();
        assert!(err.contains("already exists"));
        // Untouched on error.
        assert_eq!(files.get("a.txt"), Some(&"b1".to_string()));
        assert_eq!(files.get("b.txt"), Some(&"b2".to_string()));
    }

    #[test]
    fn rename_folder_reprefixes_every_descendant() {
        let mut files = index_of(&[
            ("photos/a.jpg", "b1"),
            ("photos/2024/x.jpg", "b2"),
            ("docs/cv.pdf", "b3"),
        ]);
        rename_in_index(&mut files, "photos", "pics", "pics", true).unwrap();
        assert_eq!(files.get("pics/a.jpg"), Some(&"b1".to_string()));
        assert_eq!(files.get("pics/2024/x.jpg"), Some(&"b2".to_string()));
        assert!(files.keys().all(|k| !k.starts_with("photos/")));
        // A sibling folder is untouched (prefix match is separator-terminated).
        assert_eq!(files.get("docs/cv.pdf"), Some(&"b3".to_string()));
    }

    #[test]
    fn rename_folder_rejects_collision_and_missing() {
        // Destination folder already exists.
        let mut files = index_of(&[("photos/a.jpg", "b1"), ("pics/b.jpg", "b2")]);
        assert!(rename_in_index(&mut files, "photos", "pics", "pics", true).is_err());
        // Source folder doesn't exist.
        let mut files2 = index_of(&[("photos/a.jpg", "b1")]);
        assert!(rename_in_index(&mut files2, "nope", "x", "x", true).is_err());
    }

    #[test]
    fn like_escape_neutralizes_wildcards_and_escape_char() {
        // `%` and `_` are LIKE wildcards; `\` is our escape char. All three must
        // come out escaped so a literal path can't widen a LIKE prefix match.
        assert_eq!(like_escape("My_Vault"), "My\\_Vault");
        assert_eq!(like_escape("50%off"), "50\\%off");
        // Backslash first, so the separators in a Windows path become literal
        // `\\` rather than getting tangled with the `%`/`_` escapes.
        assert_eq!(like_escape("C:\\Secret"), "C:\\\\Secret");
        assert_eq!(like_escape("a\\b_c%d"), "a\\\\b\\_c\\%d");
        // A plain path is untouched.
        assert_eq!(like_escape("C:/Users/me/Docs"), "C:/Users/me/Docs");
    }

    #[test]
    fn norm_sub_strips_slashes_and_unifies_separators() {
        assert_eq!(norm_sub(""), "");
        assert_eq!(norm_sub("/"), "");
        assert_eq!(norm_sub("a/b/"), "a/b");
        assert_eq!(norm_sub("\\a\\b\\"), "a/b");
    }

    #[test]
    fn immediate_children_derives_the_folder_tree_from_flat_keys() {
        let keys = [
            "root.txt".to_string(),
            "photos/a.jpg".to_string(),
            "photos/b.jpg".to_string(),
            "photos/2024/x.jpg".to_string(),
            "docs/cv.pdf".to_string(),
        ];

        // At the root: two folders (with recursive counts) + one file.
        let (folders, files) = immediate_children(keys.iter(), "");
        assert_eq!(folders.get("photos"), Some(&3)); // a, b, 2024/x
        assert_eq!(folders.get("docs"), Some(&1));
        assert_eq!(files, vec!["root.txt".to_string()]);

        // Inside `photos`: one sub-folder (2024) + two files.
        let (folders, mut files) = immediate_children(keys.iter(), "photos");
        assert_eq!(folders.get("2024"), Some(&1));
        files.sort();
        assert_eq!(files, vec!["a.jpg".to_string(), "b.jpg".to_string()]);

        // Deep leaf level: just the file, no folders.
        let (folders, files) = immediate_children(keys.iter(), "photos/2024");
        assert!(folders.is_empty());
        assert_eq!(files, vec!["x.jpg".to_string()]);
    }

    #[test]
    fn collect_plaintext_files_recurses_and_skips_metadata_and_blobs() {
        let base =
            std::env::temp_dir().join(format!("nxs-vault-collect-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("sub/deep")).unwrap();
        std::fs::write(base.join(".nxsvault"), b"header").unwrap();
        std::fs::write(base.join("deadbeef.dat"), b"a real blob").unwrap();
        std::fs::write(base.join("note.txt"), b"root file").unwrap();
        std::fs::write(base.join("sub/a.pdf"), b"nested").unwrap();
        std::fs::write(base.join("sub/deep/b.png"), b"deep").unwrap();
        // A user file that happens to end in .dat but is NOT one of our blobs.
        std::fs::write(base.join("sub/save.dat"), b"user data").unwrap();

        let mut known = HashSet::new();
        known.insert("deadbeef".to_string()); // the real blob's id

        let mut out: Vec<(PathBuf, String)> = Vec::new();
        collect_plaintext_files(&base, &base, &known, &mut out).unwrap();

        let mut keys: Vec<String> = out.iter().map(|(_, k)| k.clone()).collect();
        keys.sort();
        // The header and the known blob are skipped; the sub-folder `.dat` (a
        // user file) is kept; every path is relative with `/` separators.
        assert_eq!(
            keys,
            vec![
                "note.txt".to_string(),
                "sub/a.pdf".to_string(),
                "sub/deep/b.png".to_string(),
                "sub/save.dat".to_string(),
            ]
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
