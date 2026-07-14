//! Encrypted vaults — password-protected folders.
//!
//! A "vault" is a folder whose contents are stored encrypted on disk. Locked,
//! it is a pile of opaque `.dat` blobs plus a `.nxsvault` header; unlocked, nxs
//! shows the real file names and can read/write them. See CLAUDE.md §43.
//!
//! ## Status: headless core (Phase 1)
//!
//! This module currently exposes the crypto + on-disk format only. It is
//! compiled in but not yet wired to any Tauri command, so it cannot affect any
//! existing behaviour. The commands, the in-memory unlocked-vault registry
//! (with its idle-lock timer), and the UI land in later phases — as do the
//! exclusions that keep vault contents out of the indexer, FTS5, the AI panel,
//! sharing, snapshots and automations.
//!
//! ## Threat model — what vaults DO and DON'T protect
//!
//! Protects against:
//! - A stolen laptop, a cloned disk, a drive pulled out of the machine.
//! - Cloud-sync exposure: Dropbox/OneDrive sync opaque blobs, not documents.
//! - Another user account on the same machine.
//!
//! Does NOT protect against:
//! - **Malware running while the vault is unlocked.** A compromised process can
//!   read the decrypted bytes, full stop.
//! - **A forgotten password AND a lost recovery code.** By design: there is no
//!   backdoor. That is the point, and the creation wizard must say so loudly.
//!
//! The UI must state this honestly rather than implying "encrypted = safe from
//! everything".

pub mod crypto;
pub mod format;
pub mod state;

use std::path::Path;

use crypto::{
    aead_open, aead_seal, generate_master_key, generate_salt, unwrap_master_key, wrap_master_key,
    KdfParams, KEY_LEN,
};
use format::{
    hex_decode, hex_encode, is_vault, KeySlot, VaultError, VaultHeader, VaultIndex, FORMAT_VERSION,
};

/// Alphabet for recovery codes. Same readable set as the sharing password
/// generator: no `0`/`O`, no `1`/`I`/`L`. The user may have to copy this off a
/// screen onto paper and type it back months later, possibly in a panic —
/// ambiguous glyphs are a real failure mode, not a cosmetic one.
const RECOVERY_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/// 16 characters from a 32-symbol alphabet = 80 bits of entropy. Displayed in
/// four groups of four (`XXXX-XXXX-XXXX-XXXX`) purely for transcription.
const RECOVERY_CHARS: usize = 16;
const RECOVERY_GROUP: usize = 4;

/// Generate a printable recovery code: `XXXX-XXXX-XXXX-XXXX`.
///
/// Drawn from the OS CSPRNG. Because it is random (unlike a human password), 80
/// bits is ample even though it is only stretched by the same Argon2id as the
/// password — there is nothing to guess.
pub fn generate_recovery_code() -> String {
    // 256 is divisible by 32, so `byte % 32` is already uniform; the rejection
    // loop is kept so that changing RECOVERY_ALPHABET's length later cannot
    // silently introduce modulo bias.
    let max_unbiased = (u8::MAX as usize / RECOVERY_ALPHABET.len()) * RECOVERY_ALPHABET.len();
    let mut chars: Vec<char> = Vec::with_capacity(RECOVERY_CHARS);
    let mut scratch = [0u8; 64];
    while chars.len() < RECOVERY_CHARS {
        getrandom::getrandom(&mut scratch).expect("OS entropy source failed");
        for &b in scratch.iter() {
            if (b as usize) < max_unbiased {
                chars.push(RECOVERY_ALPHABET[(b as usize) % RECOVERY_ALPHABET.len()] as char);
                if chars.len() == RECOVERY_CHARS {
                    break;
                }
            }
        }
    }
    chars
        .chunks(RECOVERY_GROUP)
        .map(|c| c.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("-")
}

/// Normalize a user-typed recovery code before deriving from it.
///
/// People retype these from paper: they add or drop the dashes, use spaces, and
/// get the case wrong. The code was generated uppercase and dash-grouped, and
/// the KDF is over the exact string — so without normalization, a perfectly
/// correct code typed as `abcd efgh jklm npqr` would be rejected and the user
/// would conclude their last-resort key is worthless. We canonicalize to the
/// generated form: uppercase, dash-grouped, nothing else.
pub fn normalize_recovery_code(input: &str) -> String {
    let cleaned: String = input
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    cleaned
        .as_bytes()
        .chunks(RECOVERY_GROUP)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect::<Vec<_>>()
        .join("-")
}

/// An unlocked vault's master key, held in memory only.
///
/// Deliberately NOT `Clone` and NOT `Debug`-printable: the key must not end up
/// duplicated across the codebase or written into a log line. The registry that
/// will hold these (Phase 2) is the single owner.
pub struct VaultKey([u8; KEY_LEN]);

impl VaultKey {
    pub fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }

    /// Wrap raw key bytes. Only `unlock_vault` (and tests) should ever call
    /// this — it exists so `state.rs` can hold the key without `crypto.rs`
    /// exposing the inner array publicly.
    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        VaultKey(bytes)
    }
}

impl std::fmt::Debug for VaultKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print key material, even by accident.
        f.write_str("VaultKey(<redacted>)")
    }
}

/// Turn `dir` into an encrypted vault.
///
/// Creates the `.nxsvault` header with two key slots (password + recovery code)
/// wrapping one fresh master key, and an empty encrypted index. Existing files
/// in the folder are NOT touched — encrypting them is a separate, resumable
/// step (Phase 2), because a half-done bulk encryption must never be able to
/// destroy user data.
///
/// Returns the recovery code. It is shown to the user exactly once and never
/// stored anywhere: only its Argon2id-derived KEK exists on disk, wrapping the
/// master key.
pub fn create_vault(dir: &Path, password: &str) -> Result<String, VaultError> {
    if is_vault(dir) {
        return Err(VaultError::AlreadyExists);
    }
    if !dir.is_dir() {
        return Err(VaultError::Io(format!("{} is not a folder", dir.display())));
    }

    let master_key = generate_master_key();
    let params = KdfParams::default();

    let recovery_code = generate_recovery_code();
    let pw_salt = generate_salt();
    let rc_salt = generate_salt();

    let password_slot = KeySlot {
        salt: hex_encode(&pw_salt),
        wrapped_key: hex_encode(&wrap_master_key(password, &pw_salt, params, &master_key)?),
    };
    let recovery_slot = KeySlot {
        salt: hex_encode(&rc_salt),
        wrapped_key: hex_encode(&wrap_master_key(&recovery_code, &rc_salt, params, &master_key)?),
    };

    let index = VaultIndex::default();
    let index_json = serde_json::to_vec(&index)
        .map_err(|e| VaultError::Io(format!("cannot serialize index: {}", e)))?;

    let header = VaultHeader {
        version: FORMAT_VERSION,
        kdf: "argon2id".into(),
        m_cost: params.m_cost,
        t_cost: params.t_cost,
        p_cost: params.p_cost,
        password_slot,
        recovery_slot,
        encrypted_index: hex_encode(&aead_seal(&master_key, &index_json)),
    };
    header.save(dir)?;

    Ok(recovery_code)
}

/// Which door the caller is opening the vault with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Secret<'a> {
    Password(&'a str),
    /// The raw string the user typed — normalized internally, so callers pass
    /// it through untouched.
    RecoveryCode(&'a str),
}

/// Unlock a vault, returning its master key and decrypted index.
///
/// A wrong secret yields `CryptoError::WrongSecret`; a mangled header yields
/// `VaultError::Corrupt`. The caller must not leak *which slot* failed beyond
/// what it already knows (it chose the slot).
pub fn unlock_vault(dir: &Path, secret: Secret<'_>) -> Result<(VaultKey, VaultIndex), VaultError> {
    let header = VaultHeader::load(dir)?
        .ok_or_else(|| VaultError::Io("this folder is not a vault".to_string()))?;
    let params = header.kdf_params();

    let (slot, secret_str) = match secret {
        Secret::Password(p) => (&header.password_slot, p.to_string()),
        Secret::RecoveryCode(c) => (&header.recovery_slot, normalize_recovery_code(c)),
    };

    // load() already validated these decode and have the right length.
    let salt = hex_decode(&slot.salt).ok_or_else(|| VaultError::Corrupt("bad salt".into()))?;
    let wrapped =
        hex_decode(&slot.wrapped_key).ok_or_else(|| VaultError::Corrupt("bad wrapped key".into()))?;

    let master_key = unwrap_master_key(&secret_str, &salt, params, &wrapped)?;
    let index = decrypt_index(&master_key, &header)?;
    Ok((VaultKey(master_key), index))
}

fn decrypt_index(master_key: &[u8; KEY_LEN], header: &VaultHeader) -> Result<VaultIndex, VaultError> {
    let sealed = hex_decode(&header.encrypted_index)
        .ok_or_else(|| VaultError::Corrupt("encrypted index is not hex".into()))?;
    let json = aead_open(master_key, &sealed)
        .map_err(|_| VaultError::Corrupt("index failed authentication".into()))?;
    serde_json::from_slice(&json)
        .map_err(|_| VaultError::Corrupt("index is not valid JSON".into()))
}

/// Re-encrypt and persist the index. Called after any add/remove/rename of a
/// file inside an unlocked vault.
pub fn save_index(dir: &Path, key: &VaultKey, index: &VaultIndex) -> Result<(), VaultError> {
    let mut header = VaultHeader::load(dir)?
        .ok_or_else(|| VaultError::Io("this folder is not a vault".to_string()))?;
    let json = serde_json::to_vec(index)
        .map_err(|e| VaultError::Io(format!("cannot serialize index: {}", e)))?;
    header.encrypted_index = hex_encode(&aead_seal(key.as_bytes(), &json));
    header.save(dir)
}

/// Change the vault password.
///
/// Unwraps the master key with the OLD password and re-wraps it under a KEK
/// derived from the NEW one (with a fresh salt). **No file is re-encrypted** —
/// that is the entire reason for the master-key indirection. The recovery slot
/// is untouched and keeps working.
pub fn change_password(dir: &Path, old_password: &str, new_password: &str) -> Result<(), VaultError> {
    let mut header = VaultHeader::load(dir)?
        .ok_or_else(|| VaultError::Io("this folder is not a vault".to_string()))?;
    let params = header.kdf_params();

    let old_salt = hex_decode(&header.password_slot.salt)
        .ok_or_else(|| VaultError::Corrupt("bad salt".into()))?;
    let old_wrapped = hex_decode(&header.password_slot.wrapped_key)
        .ok_or_else(|| VaultError::Corrupt("bad wrapped key".into()))?;
    let master_key = unwrap_master_key(old_password, &old_salt, params, &old_wrapped)?;

    // Fresh salt on every change: reusing the old one would let someone who
    // captured the previous header attack both passwords with one KDF pass.
    let new_salt = generate_salt();
    header.password_slot = KeySlot {
        salt: hex_encode(&new_salt),
        wrapped_key: hex_encode(&wrap_master_key(new_password, &new_salt, params, &master_key)?),
    };
    header.save(dir)
}

/// Reset the password using the recovery code. The master key — and therefore
/// every encrypted file — survives untouched.
pub fn reset_password_with_recovery(
    dir: &Path,
    recovery_code: &str,
    new_password: &str,
) -> Result<(), VaultError> {
    let mut header = VaultHeader::load(dir)?
        .ok_or_else(|| VaultError::Io("this folder is not a vault".to_string()))?;
    let params = header.kdf_params();

    let rc_salt = hex_decode(&header.recovery_slot.salt)
        .ok_or_else(|| VaultError::Corrupt("bad salt".into()))?;
    let rc_wrapped = hex_decode(&header.recovery_slot.wrapped_key)
        .ok_or_else(|| VaultError::Corrupt("bad wrapped key".into()))?;
    let normalized = normalize_recovery_code(recovery_code);
    let master_key = unwrap_master_key(&normalized, &rc_salt, params, &rc_wrapped)?;

    let new_salt = generate_salt();
    header.password_slot = KeySlot {
        salt: hex_encode(&new_salt),
        wrapped_key: hex_encode(&wrap_master_key(new_password, &new_salt, params, &master_key)?),
    };
    header.save(dir)
}

/// Encrypt `plaintext` and store it as a new blob. Returns the blob id, which
/// the caller records in the index against the real file name.
pub fn write_blob(dir: &Path, key: &VaultKey, plaintext: &[u8]) -> Result<String, VaultError> {
    let blob_id = format::generate_blob_id();
    let sealed = aead_seal(key.as_bytes(), plaintext);
    let path = format::blob_path(dir, &blob_id);
    std::fs::write(&path, &sealed)
        .map_err(|e| VaultError::Io(format!("cannot write vault blob: {}", e)))?;
    Ok(blob_id)
}

/// Read and decrypt a blob. A failed authentication tag here means the blob was
/// corrupted or tampered with — never a wrong password (the key already opened
/// the header).
pub fn read_blob(dir: &Path, key: &VaultKey, blob_id: &str) -> Result<Vec<u8>, VaultError> {
    let path = format::blob_path(dir, blob_id);
    let sealed = std::fs::read(&path)
        .map_err(|e| VaultError::Io(format!("cannot read vault blob: {}", e)))?;
    aead_open(key.as_bytes(), &sealed).map_err(VaultError::Crypto)
}

/// Delete a blob from disk. The caller removes the index entry.
pub fn delete_blob(dir: &Path, blob_id: &str) -> Result<(), VaultError> {
    let path = format::blob_path(dir, blob_id);
    std::fs::remove_file(&path)
        .map_err(|e| VaultError::Io(format!("cannot delete vault blob: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crypto::CryptoError;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nxs-vault-mod-{}-{}-{:?}",
            tag,
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn recovery_code_is_well_formed_and_unique() {
        let a = generate_recovery_code();
        let b = generate_recovery_code();
        assert_ne!(a, b, "codes must not repeat");
        assert_eq!(a.len(), 19, "16 chars + 3 dashes");
        assert_eq!(a.matches('-').count(), 3);
        // No ambiguous glyphs — the user transcribes this to paper and back.
        // The alphabet drops 0/O and 1/I (the two classic confusion pairs);
        // `L` is deliberately KEPT, because with both `1` and `I` already gone
        // there is nothing left for an uppercase L to be confused with. This
        // matches the sharing password generator's alphabet on purpose.
        for c in a.chars().filter(|c| *c != '-') {
            assert!(RECOVERY_ALPHABET.contains(&(c as u8)), "unexpected glyph {}", c);
            assert!(!"01IO".contains(c), "ambiguous glyph {} in recovery code", c);
        }
    }

    #[test]
    fn recovery_code_normalizes_user_typing() {
        // All of these are the SAME code as far as the user is concerned. If we
        // rejected any of them, a user with a correct code on paper would think
        // their last resort was worthless.
        let canonical = "ABCD-EFGH-JKLM-NPQR";
        for typed in [
            "ABCD-EFGH-JKLM-NPQR",
            "abcd-efgh-jklm-npqr",
            "ABCDEFGHJKLMNPQR",
            "abcd efgh jklm npqr",
            "  ABCD-EFGH-JKLM-NPQR  ",
            "ABCD–EFGH–JKLM–NPQR", // en-dashes from a word processor
        ] {
            assert_eq!(normalize_recovery_code(typed), canonical, "failed on {:?}", typed);
        }
    }

    #[test]
    fn create_unlock_round_trip() {
        let dir = tmp_dir("create");
        let code = create_vault(&dir, "hunter2").unwrap();
        assert!(is_vault(&dir));

        let (key, index) = unlock_vault(&dir, Secret::Password("hunter2")).unwrap();
        assert!(index.files.is_empty(), "a new vault starts empty");
        assert_ne!(key.as_bytes(), &[0u8; KEY_LEN]);

        // The recovery code opens the SAME vault.
        let (key2, _) = unlock_vault(&dir, Secret::RecoveryCode(&code)).unwrap();
        assert_eq!(key.as_bytes(), key2.as_bytes(), "both slots must yield one master key");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_password_does_not_unlock() {
        let dir = tmp_dir("wrongpw");
        create_vault(&dir, "correct").unwrap();
        let err = unlock_vault(&dir, Secret::Password("incorrect")).unwrap_err();
        assert!(matches!(err, VaultError::Crypto(CryptoError::WrongSecret)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_recovery_code_does_not_unlock() {
        let dir = tmp_dir("wrongrc");
        create_vault(&dir, "pw").unwrap();
        let err = unlock_vault(&dir, Secret::RecoveryCode("ZZZZ-ZZZZ-ZZZZ-ZZZZ")).unwrap_err();
        assert!(matches!(err, VaultError::Crypto(CryptoError::WrongSecret)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cannot_create_a_vault_twice() {
        let dir = tmp_dir("twice");
        create_vault(&dir, "pw").unwrap();
        // A second create must NOT overwrite the header — that would orphan the
        // master key and permanently destroy every file already in the vault.
        assert!(matches!(create_vault(&dir, "other"), Err(VaultError::AlreadyExists)));
        // And the original password still works.
        assert!(unlock_vault(&dir, Secret::Password("pw")).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn blob_round_trips_through_the_index() {
        let dir = tmp_dir("blob");
        create_vault(&dir, "pw").unwrap();
        let (key, mut index) = unlock_vault(&dir, Secret::Password("pw")).unwrap();

        let content = b"my 2026 tax return, do not share";
        let blob_id = write_blob(&dir, &key, content).unwrap();
        index.files.insert("taxes.pdf".to_string(), blob_id.clone());
        save_index(&dir, &key, &index).unwrap();

        // The blob on disk must NOT contain the plaintext.
        let raw = std::fs::read(format::blob_path(&dir, &blob_id)).unwrap();
        assert!(
            !raw.windows(content.len()).any(|w| w == content),
            "plaintext leaked into the encrypted blob"
        );

        // Re-unlock from scratch: the index must have persisted.
        let (key2, index2) = unlock_vault(&dir, Secret::Password("pw")).unwrap();
        assert_eq!(index2.files.get("taxes.pdf"), Some(&blob_id));
        assert_eq!(read_blob(&dir, &key2, &blob_id).unwrap(), content);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tampered_blob_is_detected() {
        let dir = tmp_dir("tamper");
        create_vault(&dir, "pw").unwrap();
        let (key, _) = unlock_vault(&dir, Secret::Password("pw")).unwrap();
        let blob_id = write_blob(&dir, &key, b"original content").unwrap();

        // Flip a byte, as bit-rot or a malicious edit would.
        let path = format::blob_path(&dir, &blob_id);
        let mut raw = std::fs::read(&path).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0xff;
        std::fs::write(&path, &raw).unwrap();

        // We must REFUSE, not return garbage that the app would then render.
        assert!(matches!(
            read_blob(&dir, &key, &blob_id),
            Err(VaultError::Crypto(CryptoError::Tampered))
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn change_password_keeps_files_readable() {
        // The catastrophic-bug test: a password change must never orphan data.
        let dir = tmp_dir("changepw");
        let code = create_vault(&dir, "old-pw").unwrap();
        let (key, mut index) = unlock_vault(&dir, Secret::Password("old-pw")).unwrap();
        let blob_id = write_blob(&dir, &key, b"written under the OLD password").unwrap();
        index.files.insert("f.txt".into(), blob_id.clone());
        save_index(&dir, &key, &index).unwrap();

        change_password(&dir, "old-pw", "new-pw").unwrap();

        // Old password is dead.
        assert!(matches!(
            unlock_vault(&dir, Secret::Password("old-pw")),
            Err(VaultError::Crypto(CryptoError::WrongSecret))
        ));
        // New password opens it, and the pre-existing file still decrypts.
        let (key2, index2) = unlock_vault(&dir, Secret::Password("new-pw")).unwrap();
        assert_eq!(index2.files.get("f.txt"), Some(&blob_id));
        assert_eq!(read_blob(&dir, &key2, &blob_id).unwrap(), b"written under the OLD password");
        // The recovery code is UNAFFECTED by a password change.
        assert!(unlock_vault(&dir, Secret::RecoveryCode(&code)).is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn change_password_rejects_a_wrong_old_password() {
        let dir = tmp_dir("changepw-wrong");
        create_vault(&dir, "real").unwrap();
        assert!(matches!(
            change_password(&dir, "guessed", "new"),
            Err(VaultError::Crypto(CryptoError::WrongSecret))
        ));
        // The real password must still work — a failed change must not corrupt.
        assert!(unlock_vault(&dir, Secret::Password("real")).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recovery_resets_a_forgotten_password_and_keeps_data() {
        let dir = tmp_dir("recover");
        let code = create_vault(&dir, "forgotten").unwrap();
        let (key, mut index) = unlock_vault(&dir, Secret::Password("forgotten")).unwrap();
        let blob_id = write_blob(&dir, &key, b"still here").unwrap();
        index.files.insert("keep.txt".into(), blob_id.clone());
        save_index(&dir, &key, &index).unwrap();

        // User forgot the password; types the code off paper, lowercase, no dashes.
        let typed = code.to_lowercase().replace('-', "");
        reset_password_with_recovery(&dir, &typed, "brand-new-pw").unwrap();

        let (key2, index2) = unlock_vault(&dir, Secret::Password("brand-new-pw")).unwrap();
        assert_eq!(index2.files.get("keep.txt"), Some(&blob_id));
        assert_eq!(read_blob(&dir, &key2, &blob_id).unwrap(), b"still here");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_plain_folder_cannot_be_unlocked() {
        let dir = tmp_dir("plain-unlock");
        let err = unlock_vault(&dir, Secret::Password("x")).unwrap_err();
        assert!(matches!(err, VaultError::Io(_)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn vault_key_never_prints_its_material() {
        // Guards against a key landing in a log line or a panic message.
        let dir = tmp_dir("redact");
        create_vault(&dir, "pw").unwrap();
        let (key, _) = unlock_vault(&dir, Secret::Password("pw")).unwrap();
        let printed = format!("{:?}", key);
        assert_eq!(printed, "VaultKey(<redacted>)");
        assert!(!printed.contains(&hex_encode(key.as_bytes())));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
