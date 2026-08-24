//! Anthropic API key storage, backed by the OS credential store.
//!
//! ## Why this exists
//!
//! The key was previously kept in cleartext in the `settings` table of
//! `contextual.db`. That key has direct monetary value — it bills the user's
//! Anthropic account — and anyone who can read the disk can lift it. Shipping
//! encrypted vaults to protect the user's *files* against a stolen laptop while
//! leaving the *billable credential* in plaintext next to them was not
//! defensible, so the key now lives in Windows Credential Manager (via the
//! `keyring` crate) and the DB keeps only a presence flag.
//!
//! ## What the DB still holds
//!
//! `settings.claudeApiKey` becomes a flag: `""` (no key) or `"stored"` (the key
//! is in the credential store). The frontend uses it only to render "configured
//! / not configured" — it never carries the secret, so the Zustand store and the
//! DevTools console can't leak it either.
//!
//! ## Reading the key
//!
//! `get_api_key` is called at request time by the AI panel rather than being
//! held in frontend state. It is the one command that returns the secret, and
//! it exists because the Anthropic call is made from the webview.

use crate::AppState;

/// Credential-store coordinates. `SERVICE` matches the app identifier used
/// elsewhere (`%LOCALAPPDATA%\com.nxs.app`); changing either string orphans
/// every already-stored key, so treat them as a stable on-disk format.
const SERVICE: &str = "com.nxs.app";
const ACCOUNT: &str = "anthropic-api-key";

/// The value written to `settings.claudeApiKey` once the real key is in the
/// credential store. Anything else non-empty is a pre-migration cleartext key.
pub const STORED_FLAG: &str = "stored";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|e| format!("Cannot reach the Windows credential store: {}", e))
}

/// Store the key in the OS credential store and set the DB flag.
///
/// The flag is written only after the credential store accepted the secret —
/// otherwise a failed write would leave the app believing a key exists.
#[tauri::command]
pub fn set_api_key(key: String, state: tauri::State<AppState>) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return clear_api_key(state);
    }
    entry()?
        .set_password(&key)
        .map_err(|e| format!("Could not save the API key securely: {}", e))?;
    write_flag(&state, STORED_FLAG)
}

/// Fetch the key for an outgoing API call. `None` means "not configured",
/// which the caller surfaces as a normal "add your key in Settings" message.
#[tauri::command]
pub fn get_api_key() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(k) => Ok(Some(k)),
        // A missing entry is the normal "no key yet" state, not an error.
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Could not read the stored API key: {}", e)),
    }
}

/// Remove the key from the credential store and clear the DB flag.
#[tauri::command]
pub fn clear_api_key(state: tauri::State<AppState>) -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(format!("Could not remove the stored API key: {}", e)),
    }
    write_flag(&state, "")
}

fn write_flag(state: &tauri::State<AppState>, value: &str) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO settings (key, value) VALUES ('claudeApiKey', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// One-time migration of a pre-existing cleartext key into the credential store.
///
/// Runs at startup. Ordering is what makes it safe: the key is written to the
/// credential store FIRST and the DB row is blanked only after that write
/// succeeded. If the credential store is unavailable, the cleartext row is left
/// exactly as it was — the user keeps a working (if unprotected) key rather
/// than losing it, and the migration simply retries on the next launch.
///
/// Best-effort by design: a failure here must never block startup.
pub fn migrate_cleartext_key(db: &rusqlite::Connection) {
    let existing: Option<String> = db
        .query_row(
            "SELECT value FROM settings WHERE key = 'claudeApiKey'",
            [],
            |row| row.get(0),
        )
        .ok();

    let Some(key) = existing else { return };
    let key = key.trim();
    // Nothing to do for an empty row or one already migrated.
    if key.is_empty() || key == STORED_FLAG {
        return;
    }

    let Ok(entry) = keyring::Entry::new(SERVICE, ACCOUNT) else {
        eprintln!("[apikey] credential store unavailable; leaving the key in place for now");
        return;
    };
    if let Err(e) = entry.set_password(key) {
        eprintln!("[apikey] could not migrate the API key ({}); leaving it in place", e);
        return;
    }
    // Only now is it safe to drop the cleartext copy.
    if let Err(e) = db.execute(
        "UPDATE settings SET value = ?1 WHERE key = 'claudeApiKey'",
        rusqlite::params![STORED_FLAG],
    ) {
        eprintln!("[apikey] key migrated but the cleartext row could not be cleared: {}", e);
    }
}
