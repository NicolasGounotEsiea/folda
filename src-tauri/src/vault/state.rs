//! In-memory registry of unlocked vaults + the idle auto-lock timer.
//!
//! ## What "unlocked" means
//!
//! Unlocking a vault means one thing: its 32-byte master key is held **in this
//! process's RAM** (and nowhere else, ever). Locking means dropping that key and
//! deleting any decrypted temp files we handed to viewers. Nothing on disk
//! changes when a vault locks or unlocks — the blobs are always encrypted.
//!
//! ## Why a global registry and not `AppState`
//!
//! The idle-lock background task must be able to lock vaults without holding a
//! Tauri `State<'_, AppState>` (it isn't running inside a command), and the
//! panic-safety story is simpler if key material lives in exactly one place with
//! one lock discipline. `AppState` gets a thin accessor instead.
//!
//! ## Auto-lock
//!
//! A background task ticks every `SWEEP_INTERVAL` and locks any vault idle for
//! longer than the user's timeout. **Every vault operation resets the timer** —
//! including reads, so browsing a vault keeps it open, and a viewer left open on
//! a decrypted PDF does NOT keep it open (viewing is a one-shot read; the timer
//! then runs down). That asymmetry is deliberate: the alternative (keeping the
//! vault open while a viewer is on screen) means walking away from an open PDF
//! leaves the vault unlocked indefinitely.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::{VaultIndex, VaultKey};

/// How often the background task looks for idle vaults.
const SWEEP_INTERVAL: Duration = Duration::from_secs(30);
/// Fallback when the setting is missing/unparseable. 15 minutes.
pub const DEFAULT_IDLE_LOCK_SECS: u64 = 15 * 60;
/// `0` in the setting means "never auto-lock".
pub const NEVER_AUTO_LOCK: u64 = 0;

/// A decrypted copy handed to a viewer, and the vault entry it came from.
///
/// The `name` is what makes SAVING possible: when the editor writes back, we
/// look the temp path up here to learn which vault file to re-encrypt into.
/// Without it, an edit to a vault file would land in the temp copy, never reach
/// the vault, and be deleted on lock — silently destroying the user's work.
#[derive(Clone)]
pub struct TempFile {
    pub path: PathBuf,
    /// The real file name inside the vault (the index key).
    pub name: String,
}

struct UnlockedVault {
    key: VaultKey,
    index: VaultIndex,
    last_activity: Instant,
    /// Decrypted files handed to viewers. Deleted when the vault locks.
    /// See the threat-model note in `mod.rs`: these are the one place where
    /// plaintext touches the disk, in a user-only-ACL folder, for as long as
    /// the vault is unlocked.
    temp_files: Vec<TempFile>,
}

type Registry = HashMap<PathBuf, UnlockedVault>;

static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();

fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Take the registry lock, **recovering from poisoning**.
///
/// A plain `.lock().unwrap()` would panic forever after any thread panicked
/// while holding this lock — every subsequent vault operation, for the rest of
/// the session, would die. That is a far worse outcome than continuing with the
/// map: the registry holds no invariant that a mid-operation panic can break
/// (inserts and removes are single statements), so `into_inner` is safe here.
///
/// Concretely: without this, one panic anywhere near a vault call would make
/// the user unable to lock their vaults — leaving them unlocked and their temp
/// files undeleted.
fn lock_registry() -> std::sync::MutexGuard<'static, Registry> {
    registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Canonicalize so `C:\Vault`, `C:/Vault` and `C:\vault\` are one key.
/// Falls back to the raw path when the folder can't be canonicalized (it was
/// deleted under us) — better a stale entry than a panic.
fn key_for(dir: &Path) -> PathBuf {
    std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf())
}

/// Register a freshly-unlocked vault. Replaces any previous entry for the same
/// folder (re-unlocking is idempotent from the caller's point of view).
pub fn insert(dir: &Path, key: VaultKey, index: VaultIndex) {
    let mut reg = lock_registry();
    reg.insert(
        key_for(dir),
        UnlockedVault { key, index, last_activity: Instant::now(), temp_files: Vec::new() },
    );
}

pub fn is_unlocked(dir: &Path) -> bool {
    lock_registry().contains_key(&key_for(dir))
}

/// Run `f` against an unlocked vault's key and index, resetting its idle timer.
///
/// This is the ONLY way to reach key material: it never leaves the lock, so a
/// caller cannot accidentally stash a copy of the master key somewhere with a
/// longer lifetime than the unlocked session.
pub fn with_vault<T>(
    dir: &Path,
    f: impl FnOnce(&VaultKey, &mut VaultIndex) -> T,
) -> Option<T> {
    let mut reg = lock_registry();
    let v = reg.get_mut(&key_for(dir))?;
    v.last_activity = Instant::now();
    Some(f(&v.key, &mut v.index))
}

/// Record a decrypted temp file so it gets deleted when the vault locks, and so
/// a later save can be routed back to the right vault entry.
pub fn track_temp_file(dir: &Path, path: PathBuf, name: String) {
    let mut reg = lock_registry();
    if let Some(v) = reg.get_mut(&key_for(dir)) {
        v.last_activity = Instant::now();
        // Re-opening the same file reuses the entry rather than growing the list.
        v.temp_files.retain(|t| t.path != path);
        v.temp_files.push(TempFile { path, name });
    }
}

/// Which vault entry does this decrypted temp file belong to?
///
/// Returns `(vault_dir, name_in_vault)`, or `None` when the path is not a
/// tracked temp — which is also what happens once the vault has LOCKED, since
/// locking drops the entry. Callers must treat `None` as "the vault closed
/// under you", never as "not a vault file, write it to disk as-is": doing the
/// latter would dump the user's plaintext into the temp folder forever.
pub fn resolve_temp(temp_path: &Path) -> Option<(PathBuf, String)> {
    let reg = lock_registry();
    for (dir, v) in reg.iter() {
        if let Some(t) = v.temp_files.iter().find(|t| t.path == temp_path) {
            return Some((dir.clone(), t.name.clone()));
        }
    }
    None
}

/// Lock one vault: drop its master key and delete its decrypted temp files.
/// Returns false if it wasn't unlocked (already locked = success, not an error).
pub fn lock(dir: &Path) -> bool {
    let removed = lock_registry().remove(&key_for(dir));
    match removed {
        Some(v) => {
            purge_temp_files(&v.temp_files);
            true
        }
        None => false,
    }
}

/// Lock every unlocked vault. Called on app close and by "Lock all".
pub fn lock_all() -> usize {
    let drained: Vec<UnlockedVault> = {
        let mut reg = lock_registry();
        reg.drain().map(|(_, v)| v).collect()
    };
    let n = drained.len();
    for v in &drained {
        purge_temp_files(&v.temp_files);
    }
    n
}

fn purge_temp_files(files: &[TempFile]) {
    for f in files {
        // Best-effort: a viewer may still hold the handle. The startup sweep
        // (`purge_orphaned_temp_files`) catches whatever survives.
        let _ = std::fs::remove_file(&f.path);
    }
}

/// Folders currently unlocked, with seconds since their last activity — powers
/// the status-bar badge and its per-vault countdowns.
pub fn unlocked_list() -> Vec<(PathBuf, u64)> {
    lock_registry()
        .iter()
        .map(|(p, v)| (p.clone(), v.last_activity.elapsed().as_secs()))
        .collect()
}

/// Lock every vault idle for longer than `idle_secs`. Returns the folders it
/// locked so the caller can notify the frontend.
pub fn sweep_idle(idle_secs: u64) -> Vec<PathBuf> {
    if idle_secs == NEVER_AUTO_LOCK {
        return Vec::new();
    }
    let expired: Vec<PathBuf> = {
        let reg = lock_registry();
        reg.iter()
            .filter(|(_, v)| v.last_activity.elapsed().as_secs() >= idle_secs)
            .map(|(p, _)| p.clone())
            .collect()
    };
    // lock() re-takes the mutex per vault — fine, and it keeps the temp-file
    // deletion (which does IO) outside the registry lock.
    expired.iter().filter(|p| lock(p)).cloned().collect()
}

// ── Temp files for viewers ───────────────────────────────────────────────────

/// `%LOCALAPPDATA%\com.nxs.app\.vault-tmp\` — decrypted files live here while a
/// vault is unlocked. Inherits the user-only ACL of `%LOCALAPPDATA%` on Windows,
/// so another OS account cannot read them. This is the V1 trade documented in
/// CLAUDE.md §38: RAM-only viewers would need every viewer refactored to take
/// bytes over IPC, for protection against a threat (malware already running as
/// this user) that a compromised machine loses anyway.
pub fn temp_dir() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join("com.nxs.app").join(".vault-tmp"))
}

/// Delete every leftover temp file at startup.
///
/// If nxs is killed (crash, Task Manager, power cut) while a vault is unlocked,
/// `lock()` never runs and decrypted files stay on disk. Without this sweep they
/// would persist forever — a silent, permanent plaintext leak that completely
/// defeats the feature. Runs before anything else can touch the folder.
pub fn purge_orphaned_temp_files() {
    let Some(dir) = temp_dir() else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for e in entries.flatten() {
        let _ = std::fs::remove_file(e.path());
    }
}

/// Spawn the background auto-lock task. `idle_secs_fn` is re-read on every tick
/// so changing the timeout in Settings takes effect without a restart.
pub fn spawn_idle_locker<F>(app: tauri::AppHandle, idle_secs_fn: F)
where
    F: Fn() -> u64 + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(SWEEP_INTERVAL).await;
            let locked = sweep_idle(idle_secs_fn());
            if !locked.is_empty() {
                use tauri::Emitter;
                let paths: Vec<String> =
                    locked.iter().map(|p| p.to_string_lossy().to_string()).collect();
                let _ = app.emit("vault://auto-locked", serde_json::json!({ "paths": paths }));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::crypto::generate_master_key;

    /// The registry is process-global and `lock_all()` drains ALL of it — so a
    /// test calling it would wipe the vaults of any test running concurrently
    /// (cargo runs tests in parallel by default). Every test that touches the
    /// registry takes this lock first, making them serial with respect to each
    /// other. Poison-tolerant so one failing test doesn't cascade into the rest.
    static TEST_SERIAL: Mutex<()> = Mutex::new(());
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Distinct paths per test, so a leaked entry can't confuse another test.
    fn unique_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "nxs-vault-state-{}-{}-{:?}",
            tag,
            std::process::id(),
            std::thread::current().id()
        ))
    }

    fn fake_key() -> VaultKey {
        VaultKey::from_bytes(generate_master_key())
    }

    #[test]
    fn insert_then_lock_round_trip() {
        let _serial = serial();
        let dir = unique_dir("roundtrip");
        assert!(!is_unlocked(&dir));
        insert(&dir, fake_key(), VaultIndex::default());
        assert!(is_unlocked(&dir));
        assert!(lock(&dir));
        assert!(!is_unlocked(&dir));
        // Locking an already-locked vault is a no-op, not an error.
        assert!(!lock(&dir));
    }

    /// Long enough that `last_activity.elapsed().as_secs()` reads >= 1.
    ///
    /// These tests deliberately WAIT rather than back-dating `last_activity`
    /// with `Instant::now() - Duration`. `Instant` counts from an arbitrary
    /// monotonic epoch (boot, on most platforms), so subtracting an hour PANICS
    /// on a machine that booted less than an hour ago — an uptime-dependent,
    /// machine-dependent failure that also poisons the global registry mutex and
    /// takes every other vault test down with it. (It did exactly that.) Waiting
    /// a real second exercises the real code path and cannot overflow.
    const AGE: Duration = Duration::from_millis(1100);

    fn idle_of(dir: &Path) -> u64 {
        unlocked_list()
            .into_iter()
            .find(|(p, _)| p == &key_for(dir))
            .expect("vault should be unlocked")
            .1
    }

    #[test]
    fn with_vault_resets_the_idle_timer() {
        let _serial = serial();
        let dir = unique_dir("timer");
        insert(&dir, fake_key(), VaultIndex::default());

        std::thread::sleep(AGE);
        assert!(idle_of(&dir) >= 1, "vault should have aged");

        with_vault(&dir, |_, _| ()).unwrap();

        assert_eq!(idle_of(&dir), 0, "activity must reset the idle timer");
        lock(&dir);
    }

    #[test]
    fn sweep_locks_only_expired_vaults() {
        let _serial = serial();
        let stale = unique_dir("stale");
        insert(&stale, fake_key(), VaultIndex::default());
        std::thread::sleep(AGE);

        // Inserted AFTER the wait, so `fresh` is new while `stale` has aged.
        let fresh = unique_dir("fresh");
        insert(&fresh, fake_key(), VaultIndex::default());

        let locked = sweep_idle(1);
        assert!(locked.contains(&key_for(&stale)), "the idle vault must lock");
        assert!(!is_unlocked(&stale));
        assert!(is_unlocked(&fresh), "the active vault must stay open");

        lock(&fresh);
    }

    #[test]
    fn sweep_never_locks_when_timeout_is_zero() {
        let _serial = serial();
        // `0` = "never" in the setting. A bug here would auto-lock a user who
        // explicitly asked for no auto-lock.
        let dir = unique_dir("never");
        insert(&dir, fake_key(), VaultIndex::default());
        std::thread::sleep(AGE);

        assert!(sweep_idle(NEVER_AUTO_LOCK).is_empty());
        assert!(is_unlocked(&dir), "timeout 0 must never auto-lock");
        lock(&dir);
    }

    #[test]
    fn locking_deletes_tracked_temp_files() {
        let _serial = serial();
        let dir = unique_dir("temps");
        insert(&dir, fake_key(), VaultIndex::default());

        let tmp = std::env::temp_dir().join(format!("nxs-vault-tmp-{}.txt", std::process::id()));
        std::fs::write(&tmp, b"decrypted plaintext").unwrap();
        track_temp_file(&dir, tmp.clone(), "secret.txt".to_string());
        assert!(tmp.exists());

        lock(&dir);
        assert!(!tmp.exists(), "locking must delete decrypted temp files");
    }

    #[test]
    fn resolve_temp_maps_back_then_returns_none_once_locked() {
        let _serial = serial();
        let dir = unique_dir("resolve");
        insert(&dir, fake_key(), VaultIndex::default());

        let tmp = std::env::temp_dir().join(format!("nxs-vault-resolve-{}.txt", std::process::id()));
        track_temp_file(&dir, tmp.clone(), "secret.txt".to_string());

        // While unlocked, the temp maps back to (vault_dir, name_in_vault).
        let got = resolve_temp(&tmp);
        assert_eq!(got, Some((dir.clone(), "secret.txt".to_string())));

        // An unrelated path is never a tracked temp.
        assert_eq!(resolve_temp(Path::new("C:/nope/whatever.txt")), None);

        // After lock, resolution MUST be None — the contract that stops a save
        // from being written to the temp folder as plaintext after the key is gone.
        lock(&dir);
        assert_eq!(
            resolve_temp(&tmp),
            None,
            "a locked vault's temp must not resolve — otherwise a save leaks plaintext"
        );
    }

    #[test]
    fn lock_all_clears_everything() {
        let _serial = serial();
        let a = unique_dir("all-a");
        let b = unique_dir("all-b");
        insert(&a, fake_key(), VaultIndex::default());
        insert(&b, fake_key(), VaultIndex::default());
        assert!(lock_all() >= 2);
        assert!(!is_unlocked(&a));
        assert!(!is_unlocked(&b));
    }

    #[test]
    fn with_vault_returns_none_for_a_locked_vault() {
        let _serial = serial();
        let dir = unique_dir("locked");
        assert!(with_vault(&dir, |_, _| 42).is_none());
    }
}
