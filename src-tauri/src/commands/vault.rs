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

/// One decrypted entry inside an unlocked vault.
#[derive(Serialize)]
pub struct VaultEntry {
    pub name: String,
    /// Plaintext size in bytes. Derived from the blob size minus the AEAD
    /// overhead (nonce + tag) — exact, and avoids decrypting just to list.
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

/// List the real file names inside an unlocked vault.
#[tauri::command]
pub fn vault_list(path: String) -> Result<Vec<VaultEntry>, String> {
    let dir = PathBuf::from(&path);
    require_unlocked(&dir, |_key, index| {
        let mut out: Vec<VaultEntry> = Vec::with_capacity(index.files.len());
        for (name, blob_id) in index.files.iter() {
            // Size and mtime come from the blob's own metadata — no decryption
            // needed just to render a listing.
            let meta = std::fs::metadata(format::blob_path(&dir, blob_id)).ok();
            let raw = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            out.push(VaultEntry {
                name: name.clone(),
                size: raw.saturating_sub(BLOB_OVERHEAD),
                modified_at: meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0),
            });
        }
        out.sort_by_key(|a| a.name.to_lowercase());
        Ok(out)
    })
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

    // Decrypt inside the registry lock so the key never escapes it.
    let plaintext = require_unlocked(&dir, |key, _index| {
        vault::read_blob(&dir, key, &blob_id).map_err(ui_err)
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
    std::fs::write(&tmp_path, &plaintext)
        .map_err(|e| format!("Cannot write the decrypted file: {}", e))?;
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

/// Encrypt bytes into the vault under `name`, replacing any existing entry.
#[tauri::command]
pub fn vault_write_file(path: String, name: String, content: Vec<u8>) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if name.trim().is_empty() {
        return Err("File name cannot be empty".to_string());
    }

    let (new_blob, old_blob) = require_unlocked(&dir, |key, index| {
        let new_blob = vault::write_blob(&dir, key, &content).map_err(ui_err)?;
        // Swap the index entry only AFTER the new blob is safely on disk, so a
        // failed write can never orphan the previous version.
        let old_blob = index.files.insert(name.clone(), new_blob.clone());
        Ok((new_blob, old_blob))
    })?;

    // Persist the index. If this fails, roll the in-memory index back and delete
    // the orphan blob — otherwise the vault would hold a blob nothing points to
    // and, worse, the in-RAM index would disagree with the disk.
    let save = require_unlocked(&dir, |key, index| {
        vault::save_index(&dir, key, index).map_err(ui_err)
    });
    if let Err(e) = save {
        let _ = require_unlocked(&dir, |_key, index| {
            match &old_blob {
                Some(prev) => index.files.insert(name.clone(), prev.clone()),
                None => index.files.remove(&name),
            };
            Ok(())
        });
        let _ = vault::delete_blob(&dir, &new_blob);
        return Err(e);
    }

    // The old version is unreachable now — delete its blob.
    if let Some(prev) = old_blob {
        let _ = vault::delete_blob(&dir, &prev);
    }
    Ok(())
}

/// Move a plaintext file from disk INTO the vault: encrypt it, then delete the
/// original. The original is removed only after the encrypted copy is committed.
#[tauri::command]
pub fn vault_add_file(path: String, src: String) -> Result<(), String> {
    let src_path = PathBuf::from(&src);
    let name = src_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid file name")?
        .to_string();
    let content = std::fs::read(&src_path).map_err(|e| format!("Cannot read '{}': {}", name, e))?;

    vault_write_file(path, name, content)?;

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

/// Encrypt every loose plaintext file already sitting in the vault folder.
///
/// Called right after `vault_create`. Resumable by design: each file is
/// encrypted, indexed and only THEN deleted, so a crash halfway leaves a vault
/// with some files encrypted and the rest still plainly there — running it again
/// finishes the job. Nothing is ever lost.
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

    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Cannot read the folder: {}", e))?;
    let mut to_encrypt: Vec<PathBuf> = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue; // sub-folders are out of scope for V1
        }
        let fname = e.file_name().to_string_lossy().to_string();

        // Our own metadata — including a `.nxsvault.tmp` left by a crash during
        // the atomic header write.
        if fname == format::VAULT_FILE || fname.starts_with(&format!("{}.", format::VAULT_FILE)) {
            continue;
        }
        // One of our blobs (exact match on the index), never a user file.
        let is_our_blob = p.extension().and_then(|x| x.to_str()) == Some(format::BLOB_EXT)
            && p.file_stem()
                .and_then(|s| s.to_str())
                .map(|stem| known_blobs.contains(stem))
                .unwrap_or(false);
        if is_our_blob {
            continue;
        }

        to_encrypt.push(p);
    }

    let mut count = 0usize;
    for p in to_encrypt {
        vault_add_file(path.clone(), p.to_string_lossy().to_string())?;
        count += 1;
    }
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
    use super::like_escape;

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
}
