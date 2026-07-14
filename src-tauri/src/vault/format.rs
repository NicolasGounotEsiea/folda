//! The `.nxsvault` header — on-disk layout of an encrypted vault.
//!
//! ## What a vault looks like on disk
//!
//! ```text
//! MySecretFolder/
//!   .nxsvault            ← this file: JSON, the only unencrypted thing
//!   3f9a…c1.dat          ← one opaque blob per file (name is a random id)
//!   8b2e…07.dat
//! ```
//!
//! The `.dat` file names are **random ids, not encrypted names** — deliberately.
//! An encrypted name would still leak its length; a random id leaks nothing at
//! all. The real names live in the `encrypted_index`, which only the master key
//! opens. An attacker with the folder learns the file count and each file's
//! approximate size, and nothing else. (See `crypto.rs` for the full "what is
//! NOT protected" list.)
//!
//! ## Key slots
//!
//! Two independent slots wrap the same master key: one derived from the user's
//! password, one from the recovery code. Either opens the vault; neither can be
//! computed from the other. Changing the password rewrites only `password_slot`.
//!
//! ## Defensive parsing (this matters)
//!
//! A user can legitimately have a file literally named `.nxsvault` in some
//! folder for unrelated reasons — a stray download, a filename collision, a
//! half-written file from a crashed sync. Treating any such file as a vault
//! would pop an unlock prompt on a normal folder and, worse, make the folder
//! look encrypted when it is not.
//!
//! So [`VaultHeader::load`] parses **strictly**: valid JSON, a known `version`,
//! a recognised `kdf`, and every binary field present with the exact expected
//! length. Anything else returns `Ok(None)` = "this is not a vault", never an
//! error and never a partial vault. Callers use [`is_vault`] as the single
//! source of truth for "is this folder encrypted?".

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::crypto::{CryptoError, KdfParams, KEY_LEN, NONCE_LEN, SALT_LEN};

/// The marker/metadata file at a vault's root.
pub const VAULT_FILE: &str = ".nxsvault";
/// Extension of the per-file encrypted blobs.
pub const BLOB_EXT: &str = "dat";
/// Current on-disk format version. Bump only for BREAKING layout changes; new
/// optional fields don't need it (serde defaults cover them).
pub const FORMAT_VERSION: u32 = 1;
/// The only KDF we currently accept. Stored as a string so a future version can
/// add another without the header becoming ambiguous.
const KDF_ARGON2ID: &str = "argon2id";

/// Length of a `.dat` file's random id, in bytes (rendered as 32 hex chars).
/// 16 bytes = 128 bits: collisions are unreachable, and the id reveals nothing.
pub const BLOB_ID_LEN: usize = 16;

/// Anything that can go wrong reading or writing a vault header.
#[derive(Debug)]
pub enum VaultError {
    /// Crypto-layer failure (wrong password, tampered data, …).
    Crypto(CryptoError),
    /// Filesystem failure, with the path that caused it.
    Io(String),
    /// The header exists but is structurally unusable. Distinct from "not a
    /// vault" (which is `Ok(None)`) — this means the marker file IS a vault
    /// header but we cannot work with it.
    Corrupt(String),
    /// A vault already exists at this path (create would clobber it).
    AlreadyExists,
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VaultError::Crypto(e) => write!(f, "{}", e),
            VaultError::Io(m) => write!(f, "{}", m),
            VaultError::Corrupt(m) => write!(f, "Vault is corrupt: {}", m),
            VaultError::AlreadyExists => write!(f, "This folder is already a vault"),
        }
    }
}

impl std::error::Error for VaultError {}

impl From<CryptoError> for VaultError {
    fn from(e: CryptoError) -> Self {
        VaultError::Crypto(e)
    }
}

/// One way in to the master key: a salt + the master key wrapped under the KEK
/// derived from a secret with that salt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeySlot {
    /// Argon2id salt, hex. Distinct per slot — a shared salt would let an
    /// attacker attack both secrets with one KDF pass.
    pub salt: String,
    /// `nonce || ciphertext || tag`, hex. Opens to the 32-byte master key.
    pub wrapped_key: String,
}

/// The `.nxsvault` file's contents.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultHeader {
    pub version: u32,
    /// Always `"argon2id"` today. A string, not an enum, so an older build
    /// reading a newer vault fails the *check* rather than the *deserialize*
    /// and can say "this vault needs a newer nxs".
    pub kdf: String,
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
    /// Unlocked with the user's password.
    pub password_slot: KeySlot,
    /// Unlocked with the printable recovery code. Same master key.
    pub recovery_slot: KeySlot,
    /// `nonce || ciphertext || tag`, hex. Opens (under the master key) to the
    /// JSON of a [`VaultIndex`].
    pub encrypted_index: String,
}

/// The plaintext (once decrypted) mapping of real file names to blob ids.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VaultIndex {
    /// real file name → blob id (hex, `BLOB_ID_LEN` bytes).
    #[serde(default)]
    pub files: std::collections::BTreeMap<String, String>,
}

impl VaultHeader {
    pub fn kdf_params(&self) -> KdfParams {
        KdfParams { m_cost: self.m_cost, t_cost: self.t_cost, p_cost: self.p_cost }
    }

    /// Path of the marker file inside `vault_dir`.
    pub fn path_in(vault_dir: &Path) -> PathBuf {
        vault_dir.join(VAULT_FILE)
    }

    /// Read and STRICTLY validate the header in `vault_dir`.
    ///
    /// Returns:
    /// - `Ok(Some(header))` — this is a genuine, usable vault.
    /// - `Ok(None)`         — there is no vault here. Covers "no `.nxsvault`
    ///   file" AND "a file called `.nxsvault` that isn't one" (garbage, a
    ///   coincidental name, a truncated sync artifact). Never guesses.
    /// - `Err(Corrupt)`     — it IS a vault header (right shape and version)
    ///   but a field is unusable, so we must not pretend the folder is normal.
    pub fn load(vault_dir: &Path) -> Result<Option<VaultHeader>, VaultError> {
        let path = Self::path_in(vault_dir);
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            // No marker file at all → plainly not a vault. Any other IO error
            // (permissions, IO fault) also means we cannot claim it's a vault.
            Err(_) => return Ok(None),
        };

        // Not JSON, or not our shape → not a vault. A user's unrelated
        // `.nxsvault` file lands here and is correctly ignored.
        let header: VaultHeader = match serde_json::from_str(&raw) {
            Ok(h) => h,
            Err(_) => return Ok(None),
        };

        // It parses as our struct. From here on, a problem means a REAL vault
        // that is broken — we must surface it, not silently ignore the folder.
        if header.version != FORMAT_VERSION {
            return Err(VaultError::Corrupt(format!(
                "unsupported vault version {} (this nxs understands {})",
                header.version, FORMAT_VERSION
            )));
        }
        if header.kdf != KDF_ARGON2ID {
            return Err(VaultError::Corrupt(format!("unknown KDF '{}'", header.kdf)));
        }
        header.validate_field_lengths()?;
        Ok(Some(header))
    }

    /// Every binary field must decode from hex AND have exactly the length the
    /// crypto layer expects. Checking here means the crypto functions can
    /// assume well-formed input and the failure message stays specific.
    fn validate_field_lengths(&self) -> Result<(), VaultError> {
        let check_salt = |s: &str, what: &'static str| -> Result<(), VaultError> {
            let b = hex_decode(s).ok_or_else(|| VaultError::Corrupt(format!("{} is not hex", what)))?;
            if b.len() != SALT_LEN {
                return Err(VaultError::Corrupt(format!(
                    "{} has length {}, expected {}",
                    what,
                    b.len(),
                    SALT_LEN
                )));
            }
            Ok(())
        };
        // A wrapped key is nonce + 32-byte key + 16-byte Poly1305 tag.
        let wrapped_len = NONCE_LEN + KEY_LEN + 16;
        let check_wrapped = |s: &str, what: &'static str| -> Result<(), VaultError> {
            let b = hex_decode(s).ok_or_else(|| VaultError::Corrupt(format!("{} is not hex", what)))?;
            if b.len() != wrapped_len {
                return Err(VaultError::Corrupt(format!(
                    "{} has length {}, expected {}",
                    what,
                    b.len(),
                    wrapped_len
                )));
            }
            Ok(())
        };

        check_salt(&self.password_slot.salt, "password salt")?;
        check_salt(&self.recovery_slot.salt, "recovery salt")?;
        check_wrapped(&self.password_slot.wrapped_key, "wrapped password key")?;
        check_wrapped(&self.recovery_slot.wrapped_key, "wrapped recovery key")?;

        // The index is variable-length, but must at least carry a nonce + tag.
        let idx = hex_decode(&self.encrypted_index)
            .ok_or_else(|| VaultError::Corrupt("encrypted index is not hex".into()))?;
        if idx.len() < NONCE_LEN + 16 {
            return Err(VaultError::Corrupt("encrypted index is too short".into()));
        }
        Ok(())
    }

    /// Atomically write the header into `vault_dir`.
    ///
    /// Write-to-temp + rename: a crash or a power cut mid-write must never
    /// leave a truncated `.nxsvault`, because that file is the ONLY copy of the
    /// wrapped master key. A torn write here means every file in the vault
    /// becomes permanently undecryptable — the worst possible failure mode, and
    /// the reason this is not a plain `fs::write`.
    pub fn save(&self, vault_dir: &Path) -> Result<(), VaultError> {
        let final_path = Self::path_in(vault_dir);
        let tmp_path = vault_dir.join(format!("{}.tmp", VAULT_FILE));
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| VaultError::Io(format!("cannot serialize vault header: {}", e)))?;
        std::fs::write(&tmp_path, json)
            .map_err(|e| VaultError::Io(format!("cannot write vault header: {}", e)))?;
        std::fs::rename(&tmp_path, &final_path)
            .map_err(|e| VaultError::Io(format!("cannot finalize vault header: {}", e)))?;
        Ok(())
    }
}

/// Is this folder an encrypted vault? The single source of truth used by the
/// indexer, the AI panel, sharing, snapshots and automations to skip vaults.
///
/// A `Corrupt` header still counts as a vault (`true`) — the folder's contents
/// ARE encrypted blobs, so treating it as a normal folder would be wrong.
pub fn is_vault(dir: &Path) -> bool {
    matches!(
        VaultHeader::load(dir),
        Ok(Some(_)) | Err(VaultError::Corrupt(_))
    )
}

/// Is `path` a vault folder, or anywhere INSIDE one?
///
/// **This is the single predicate every other subsystem must call** to stay out
/// of vaults: the indexer, the watcher, FTS5, the AI panel's tools, sharing,
/// snapshots and automations. Getting this wrong in any one of them leaks vault
/// plaintext into `contextual.db`, which permanently defeats the feature (the
/// DB is not encrypted) — so there is exactly one implementation, not six
/// hand-rolled checks.
///
/// Walks up from `path` to the filesystem root. Cheap in the common case: the
/// per-ancestor test is one failed `read_to_string` of a file that isn't there,
/// and real folder depths are ~5-15.
///
/// Note the asymmetry with [`is_vault`]: that one asks "is THIS folder a vault
/// root?" (for the lock icon); this one asks "is this path protected?" (for the
/// exclusions). Using `is_vault` where `path_is_in_vault` is meant would index
/// every file *inside* a vault — the exact catastrophe.
pub fn path_is_in_vault(path: &Path) -> bool {
    let mut cur = Some(path);
    while let Some(p) = cur {
        if p.is_dir() && is_vault(p) {
            return true;
        }
        cur = p.parent();
    }
    false
}

/// A fresh random blob id, hex-encoded — the on-disk name of one encrypted file.
pub fn generate_blob_id() -> String {
    let mut id = [0u8; BLOB_ID_LEN];
    getrandom::getrandom(&mut id).expect("OS entropy source failed");
    hex_encode(&id)
}

/// Path of a blob inside the vault.
pub fn blob_path(vault_dir: &Path, blob_id: &str) -> PathBuf {
    vault_dir.join(format!("{}.{}", blob_id, BLOB_EXT))
}

// ── hex ──────────────────────────────────────────────────────────────────────
// Hand-rolled rather than pulling the `hex` crate for ~20 lines. Lowercase
// output; the decoder accepts either case and rejects anything else (returning
// None, which the defensive parser turns into "not a vault" / "corrupt").

pub fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

pub fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    for pair in bytes.chunks(2) {
        let hi = hex_val(pair[0])?;
        let lo = hex_val(pair[1])?;
        out.push((hi << 4) | lo);
    }
    Some(out)
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::crypto::{aead_seal, generate_master_key, generate_salt, wrap_master_key};

    fn fast_params() -> KdfParams {
        KdfParams { m_cost: 1024, t_cost: 1, p_cost: 1 }
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nxs-vault-test-{}-{}-{:?}",
            tag,
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Build a structurally valid header (used as the baseline for corruption tests).
    fn valid_header() -> VaultHeader {
        let mk = generate_master_key();
        let pw_salt = generate_salt();
        let rc_salt = generate_salt();
        let index = VaultIndex::default();
        let index_json = serde_json::to_vec(&index).unwrap();
        VaultHeader {
            version: FORMAT_VERSION,
            kdf: "argon2id".into(),
            m_cost: 1024,
            t_cost: 1,
            p_cost: 1,
            password_slot: KeySlot {
                salt: hex_encode(&pw_salt),
                wrapped_key: hex_encode(&wrap_master_key("pw", &pw_salt, fast_params(), &mk).unwrap()),
            },
            recovery_slot: KeySlot {
                salt: hex_encode(&rc_salt),
                wrapped_key: hex_encode(&wrap_master_key("rc", &rc_salt, fast_params(), &mk).unwrap()),
            },
            encrypted_index: hex_encode(&aead_seal(&mk, &index_json)),
        }
    }

    #[test]
    fn hex_round_trips_and_rejects_garbage() {
        let bytes = [0x00u8, 0x0f, 0xa5, 0xff];
        assert_eq!(hex_encode(&bytes), "000fa5ff");
        assert_eq!(hex_decode("000fa5ff").unwrap(), bytes);
        assert_eq!(hex_decode("000FA5FF").unwrap(), bytes, "uppercase must decode");
        assert!(hex_decode("abc").is_none(), "odd length must be rejected");
        assert!(hex_decode("zz").is_none(), "non-hex must be rejected");
        assert_eq!(hex_decode("").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tmp_dir("roundtrip");
        let h = valid_header();
        h.save(&dir).unwrap();
        let loaded = VaultHeader::load(&dir).unwrap().expect("must load as a vault");
        assert_eq!(loaded.version, FORMAT_VERSION);
        assert_eq!(loaded.password_slot.wrapped_key, h.password_slot.wrapped_key);
        assert!(is_vault(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_leaves_no_temp_file_behind() {
        // The atomic write must not leave `.nxsvault.tmp` littering the vault —
        // a stray temp file would show up in the user's folder listing.
        let dir = tmp_dir("notmp");
        valid_header().save(&dir).unwrap();
        assert!(!dir.join(".nxsvault.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_without_the_marker_is_not_a_vault() {
        let dir = tmp_dir("plain");
        std::fs::write(dir.join("holiday.jpg"), b"not encrypted").unwrap();
        assert!(VaultHeader::load(&dir).unwrap().is_none());
        assert!(!is_vault(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unrelated_file_named_nxsvault_is_not_a_vault() {
        // THE defensive case: a user happens to have a file called `.nxsvault`.
        // We must not prompt them to unlock a folder that isn't encrypted.
        let dir = tmp_dir("collision");
        std::fs::write(VaultHeader::path_in(&dir), b"hello, I am not a vault").unwrap();
        assert!(VaultHeader::load(&dir).unwrap().is_none(), "garbage must be 'not a vault'");
        assert!(!is_vault(&dir));

        // Valid JSON, but not our shape — also not a vault.
        std::fs::write(VaultHeader::path_in(&dir), br#"{"hello":"world"}"#).unwrap();
        assert!(VaultHeader::load(&dir).unwrap().is_none());
        assert!(!is_vault(&dir));

        // Empty file — not a vault (a crashed sync can leave this).
        std::fs::write(VaultHeader::path_in(&dir), b"").unwrap();
        assert!(VaultHeader::load(&dir).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_future_version_is_corrupt_not_ignored() {
        // A vault written by a NEWER nxs must NOT be treated as a plain folder
        // (that would show the user opaque .dat files and let tools scan them).
        // It must surface as "you need a newer nxs".
        let dir = tmp_dir("future");
        let mut h = valid_header();
        h.version = FORMAT_VERSION + 1;
        h.save(&dir).unwrap();
        let err = VaultHeader::load(&dir).unwrap_err();
        assert!(matches!(err, VaultError::Corrupt(_)));
        assert!(is_vault(&dir), "a future-version vault is still a vault");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unknown_kdf_is_corrupt() {
        let dir = tmp_dir("kdf");
        let mut h = valid_header();
        h.kdf = "scrypt".into();
        h.save(&dir).unwrap();
        assert!(matches!(VaultHeader::load(&dir).unwrap_err(), VaultError::Corrupt(_)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn truncated_binary_fields_are_corrupt_not_silently_accepted() {
        // If a sync tool or a bit-rot event shortens the wrapped key, we must
        // NOT hand a short buffer to the crypto layer.
        let dir = tmp_dir("truncated");
        let mut h = valid_header();
        h.password_slot.wrapped_key.truncate(10);
        h.save(&dir).unwrap();
        assert!(matches!(VaultHeader::load(&dir).unwrap_err(), VaultError::Corrupt(_)));

        // Wrong salt length.
        let dir2 = tmp_dir("badsalt");
        let mut h2 = valid_header();
        h2.recovery_slot.salt = hex_encode(&[0u8; 4]); // too short
        h2.save(&dir2).unwrap();
        assert!(matches!(VaultHeader::load(&dir2).unwrap_err(), VaultError::Corrupt(_)));

        // Non-hex payload.
        let dir3 = tmp_dir("nonhex");
        let mut h3 = valid_header();
        h3.encrypted_index = "not-hex-at-all".into();
        h3.save(&dir3).unwrap();
        assert!(matches!(VaultHeader::load(&dir3).unwrap_err(), VaultError::Corrupt(_)));

        for d in [dir, dir2, dir3] {
            let _ = std::fs::remove_dir_all(&d);
        }
    }

    #[test]
    fn blob_ids_are_unique_and_well_formed() {
        let a = generate_blob_id();
        let b = generate_blob_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), BLOB_ID_LEN * 2, "id must be 32 hex chars");
        assert!(hex_decode(&a).is_some());
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn blob_path_is_inside_the_vault() {
        let p = blob_path(Path::new("C:/vault"), "deadbeef");
        assert!(p.to_string_lossy().ends_with("deadbeef.dat"));
        assert_eq!(p.parent().unwrap(), Path::new("C:/vault"));
    }
}
