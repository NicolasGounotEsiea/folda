//! Vault cryptography — key derivation, key wrapping, content encryption.
//!
//! ## Key architecture (why a master key + wrapping, not "password encrypts files")
//!
//! A random 32-byte **master key** encrypts everything (the file-name index and
//! every file's bytes). The user's password never touches the content directly:
//! it is stretched with Argon2id into a **key-encryption key (KEK)** that
//! *wraps* (AEAD-encrypts) the master key. The recovery code derives a second,
//! independent KEK that wraps the **same** master key.
//!
//! This "key slot" design (LUKS / 1Password / Bitwarden do the same) buys three
//! properties a naive "derive the file key from the password" scheme cannot:
//!
//!   1. **Changing the password is instant** — re-wrap the 32-byte master key
//!      under a new KEK. No file is re-encrypted. A password change on a 50 GB
//!      vault costs a few hundred microseconds.
//!   2. **Password and recovery code coexist** — two slots, one master key.
//!      Neither can be derived from the other.
//!   3. **No separate "is the password right?" verifier is needed.** Unwrapping
//!      is an AEAD open: a wrong password produces a wrong KEK, the Poly1305 tag
//!      fails, and we get a clean `WrongPassword` instead of silently returning
//!      garbage bytes. The authentication tag *is* the verifier.
//!
//! ## Primitives
//!
//! - **Argon2id**, m=64 MiB, t=3, p=1 (OWASP 2024 baseline). Memory-hard, so an
//!   attacker holding a stolen `.nxsvault` header pays ~64 MiB of RAM per guess
//!   — this is what makes offline brute force of a human password expensive.
//!   The parameters are stored in the header, so we can raise them for new
//!   vaults later without breaking old ones.
//! - **XChaCha20-Poly1305** AEAD for wrapping and for content. The 24-byte nonce
//!   lets us draw nonces from the OS RNG and ignore collisions (2^-96 per pair)
//!   instead of maintaining a counter that would have to survive process
//!   restarts and file-level parallelism.
//!
//! ## What is NOT protected
//!
//! - **File sizes and file count.** Ciphertext length reveals plaintext length
//!   (+40 bytes overhead), and each vault file is one `.dat` on disk. An
//!   attacker with the disk learns "this vault has 14 files, one of them is
//!   ~3 MB". Padding to hide this is a V2 problem; it costs real disk space.
//! - **Modification times.** The OS stamps the `.dat` files.
//! - Anything at all while the vault is unlocked and the process is compromised.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};

/// Master key / KEK length. 32 bytes = XChaCha20-Poly1305's key size.
pub const KEY_LEN: usize = 32;
/// XChaCha20 nonce length.
pub const NONCE_LEN: usize = 24;
/// Salt length for Argon2id. 16 bytes is the RFC 9106 recommendation.
pub const SALT_LEN: usize = 16;

/// Argon2id cost parameters. Stored per-vault in the `.nxsvault` header so a
/// future version can raise them for NEW vaults while still opening old ones.
/// OWASP 2024 baseline for interactive use: 64 MiB, 3 passes, 1 lane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    /// Memory cost in KiB. 65536 KiB = 64 MiB.
    pub m_cost: u32,
    /// Time cost (passes).
    pub t_cost: u32,
    /// Parallelism (lanes).
    pub p_cost: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self { m_cost: 65536, t_cost: 3, p_cost: 1 }
    }
}

/// Every way vault crypto can fail. Deliberately coarse at the boundary:
/// callers (and therefore the UI) must not be able to distinguish "wrong
/// password" from "wrong recovery code" from "tampered ciphertext" by anything
/// other than the variant we choose to expose.
#[derive(Debug, PartialEq, Eq)]
pub enum CryptoError {
    /// The supplied password/recovery code did not unwrap the master key, OR
    /// the wrapped key was tampered with. Same variant on purpose — an attacker
    /// must not learn which.
    WrongSecret,
    /// Ciphertext failed authentication (tampered / corrupted / truncated).
    Tampered,
    /// A stored field had the wrong length (corrupt or hand-edited header).
    Malformed(&'static str),
    /// Argon2 refused the parameters (absurd m_cost, etc.).
    BadKdfParams,
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CryptoError::WrongSecret => write!(f, "Wrong password or recovery code"),
            CryptoError::Tampered => write!(f, "Data is corrupted or has been tampered with"),
            CryptoError::Malformed(what) => write!(f, "Malformed vault data: {}", what),
            CryptoError::BadKdfParams => write!(f, "Invalid key-derivation parameters"),
        }
    }
}

impl std::error::Error for CryptoError {}

/// Fill a buffer from the OS CSPRNG. Panics only if the OS entropy source is
/// broken, in which case every other security primitive is already void.
fn random_bytes(buf: &mut [u8]) {
    getrandom::getrandom(buf).expect("OS entropy source failed");
}

/// A fresh random 32-byte master key.
pub fn generate_master_key() -> [u8; KEY_LEN] {
    let mut k = [0u8; KEY_LEN];
    random_bytes(&mut k);
    k
}

/// A fresh random Argon2id salt.
pub fn generate_salt() -> [u8; SALT_LEN] {
    let mut s = [0u8; SALT_LEN];
    random_bytes(&mut s);
    s
}

/// Stretch a secret (password or recovery code) into a 32-byte key-encryption
/// key with Argon2id.
///
/// This is the ONLY expensive operation in the module (~100 ms at the default
/// parameters) and the only thing standing between a stolen `.nxsvault` file
/// and an offline brute force. Never cache the result to disk.
pub fn derive_kek(
    secret: &str,
    salt: &[u8],
    params: KdfParams,
) -> Result<[u8; KEY_LEN], CryptoError> {
    let p = Params::new(params.m_cost, params.t_cost, params.p_cost, Some(KEY_LEN))
        .map_err(|_| CryptoError::BadKdfParams)?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, p);
    let mut kek = [0u8; KEY_LEN];
    argon
        .hash_password_into(secret.as_bytes(), salt, &mut kek)
        .map_err(|_| CryptoError::BadKdfParams)?;
    Ok(kek)
}

/// AEAD-encrypt `plaintext` under `key`, returning `nonce || ciphertext||tag`.
///
/// The nonce is random and prepended, so the output is self-contained: callers
/// store it verbatim and hand it back to `aead_open` without tracking nonces.
pub fn aead_seal(key: &[u8; KEY_LEN], plaintext: &[u8]) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let mut nonce_bytes = [0u8; NONCE_LEN];
    random_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);
    // Encryption only fails on absurd input sizes (>256 GiB), which we can't
    // reach: file writes are bounded far below that by the caller.
    let ct = cipher
        .encrypt(nonce, plaintext)
        .expect("XChaCha20-Poly1305 encryption cannot fail for realistic sizes");
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    out
}

/// Inverse of [`aead_seal`]. Expects `nonce || ciphertext||tag`.
///
/// Returns [`CryptoError::Tampered`] when the Poly1305 tag does not verify —
/// which covers a corrupted file, a truncated file, a bit-flipped byte, AND a
/// deliberate modification by someone without the key. There is no way to get
/// plaintext out of this function without the right key: that is the whole
/// point of using an AEAD rather than raw ChaCha20.
pub fn aead_open(key: &[u8; KEY_LEN], sealed: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if sealed.len() < NONCE_LEN {
        return Err(CryptoError::Malformed("sealed blob shorter than its nonce"));
    }
    let (nonce_bytes, ct) = sealed.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce = XNonce::from_slice(nonce_bytes);
    cipher.decrypt(nonce, ct).map_err(|_| CryptoError::Tampered)
}

/// Wrap (encrypt) the master key under a secret-derived KEK. The result goes in
/// a key slot of the `.nxsvault` header.
pub fn wrap_master_key(
    secret: &str,
    salt: &[u8],
    params: KdfParams,
    master_key: &[u8; KEY_LEN],
) -> Result<Vec<u8>, CryptoError> {
    let kek = derive_kek(secret, salt, params)?;
    Ok(aead_seal(&kek, master_key))
}

/// Unwrap (decrypt) the master key from a key slot.
///
/// A wrong secret derives a wrong KEK, the AEAD tag fails, and we return
/// [`CryptoError::WrongSecret`] — NOT `Tampered`. The distinction matters for
/// the caller's UX ("wrong password" vs "your vault is corrupted") but both are
/// indistinguishable to an attacker probing the file, because reaching either
/// requires already having the file.
pub fn unwrap_master_key(
    secret: &str,
    salt: &[u8],
    params: KdfParams,
    wrapped: &[u8],
) -> Result<[u8; KEY_LEN], CryptoError> {
    let kek = derive_kek(secret, salt, params)?;
    let opened = aead_open(&kek, wrapped).map_err(|_| CryptoError::WrongSecret)?;
    if opened.len() != KEY_LEN {
        // The AEAD verified, so this can only happen if a correctly-keyed but
        // structurally wrong blob was stored — i.e. a bug in a past version,
        // not an attack.
        return Err(CryptoError::Malformed("unwrapped master key has wrong length"));
    }
    let mut key = [0u8; KEY_LEN];
    key.copy_from_slice(&opened);
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Argon2id at 64 MiB is deliberately slow (~100 ms). Tests that only need
    /// *a* KDF, not the production cost, use these to stay fast.
    fn fast_params() -> KdfParams {
        KdfParams { m_cost: 1024, t_cost: 1, p_cost: 1 }
    }

    #[test]
    fn aead_round_trips() {
        let key = generate_master_key();
        let msg = b"the vault contains my tax returns";
        let sealed = aead_seal(&key, msg);
        assert_ne!(&sealed[NONCE_LEN..], msg, "ciphertext must not equal plaintext");
        assert_eq!(aead_open(&key, &sealed).unwrap(), msg);
    }

    #[test]
    fn aead_rejects_wrong_key() {
        let key = generate_master_key();
        let other = generate_master_key();
        let sealed = aead_seal(&key, b"secret");
        assert_eq!(aead_open(&other, &sealed), Err(CryptoError::Tampered));
    }

    #[test]
    fn aead_detects_tampering() {
        let key = generate_master_key();
        let mut sealed = aead_seal(&key, b"transfer 100 EUR");
        // Flip one bit in the ciphertext body (past the nonce).
        let last = sealed.len() - 1;
        sealed[last] ^= 0x01;
        assert_eq!(aead_open(&key, &sealed), Err(CryptoError::Tampered));

        // Flip a bit in the NONCE — must also fail (it changes the keystream).
        let mut sealed2 = aead_seal(&key, b"transfer 100 EUR");
        sealed2[0] ^= 0x01;
        assert_eq!(aead_open(&key, &sealed2), Err(CryptoError::Tampered));
    }

    #[test]
    fn aead_rejects_truncated_blob() {
        let key = generate_master_key();
        let sealed = aead_seal(&key, b"x");
        // Shorter than the nonce → Malformed, not a panic.
        assert!(matches!(
            aead_open(&key, &sealed[..NONCE_LEN - 1]),
            Err(CryptoError::Malformed(_))
        ));
        // Nonce present but no tag → Tampered.
        assert_eq!(aead_open(&key, &sealed[..NONCE_LEN]), Err(CryptoError::Tampered));
    }

    #[test]
    fn aead_nonces_are_unique_per_call() {
        // Same key, same plaintext, twice → different ciphertexts. If this ever
        // fails, we are reusing a nonce, which for a stream cipher leaks the
        // XOR of the two plaintexts.
        let key = generate_master_key();
        let a = aead_seal(&key, b"identical");
        let b = aead_seal(&key, b"identical");
        assert_ne!(a, b, "nonce reuse: identical plaintexts produced identical ciphertext");
        assert_ne!(a[..NONCE_LEN], b[..NONCE_LEN], "nonces must differ");
    }

    #[test]
    fn aead_handles_empty_plaintext() {
        // An empty file must still round-trip (and still be authenticated).
        let key = generate_master_key();
        let sealed = aead_seal(&key, b"");
        assert_eq!(aead_open(&key, &sealed).unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn master_key_wrap_round_trips() {
        let mk = generate_master_key();
        let salt = generate_salt();
        let wrapped = wrap_master_key("correct horse battery staple", &salt, fast_params(), &mk).unwrap();
        let out = unwrap_master_key("correct horse battery staple", &salt, fast_params(), &wrapped).unwrap();
        assert_eq!(out, mk);
    }

    #[test]
    fn wrong_password_is_rejected_as_wrong_secret() {
        let mk = generate_master_key();
        let salt = generate_salt();
        let wrapped = wrap_master_key("right", &salt, fast_params(), &mk).unwrap();
        assert_eq!(
            unwrap_master_key("wrong", &salt, fast_params(), &wrapped),
            Err(CryptoError::WrongSecret)
        );
    }

    #[test]
    fn wrong_salt_is_rejected() {
        // The salt is stored in the header; swapping it (corruption, or a header
        // from a different vault) must not silently yield a bogus key.
        let mk = generate_master_key();
        let salt = generate_salt();
        let other_salt = generate_salt();
        let wrapped = wrap_master_key("pw", &salt, fast_params(), &mk).unwrap();
        assert_eq!(
            unwrap_master_key("pw", &other_salt, fast_params(), &wrapped),
            Err(CryptoError::WrongSecret)
        );
    }

    #[test]
    fn wrong_kdf_params_are_rejected() {
        // Cost parameters are part of the derivation. If a corrupted header
        // claims different costs, the KEK differs and unwrap fails cleanly.
        let mk = generate_master_key();
        let salt = generate_salt();
        let wrapped = wrap_master_key("pw", &salt, fast_params(), &mk).unwrap();
        let tweaked = KdfParams { m_cost: 2048, t_cost: 1, p_cost: 1 };
        assert_eq!(
            unwrap_master_key("pw", &salt, tweaked, &wrapped),
            Err(CryptoError::WrongSecret)
        );
    }

    #[test]
    fn two_slots_unwrap_the_same_master_key() {
        // The whole point of the key-slot design: a password and a recovery code
        // are independent doors to ONE master key.
        let mk = generate_master_key();
        let pw_salt = generate_salt();
        let rc_salt = generate_salt();

        let pw_slot = wrap_master_key("my-password", &pw_salt, fast_params(), &mk).unwrap();
        let rc_slot = wrap_master_key("ABCD-EFGH-JKLM-NPQR", &rc_salt, fast_params(), &mk).unwrap();

        assert_eq!(unwrap_master_key("my-password", &pw_salt, fast_params(), &pw_slot).unwrap(), mk);
        assert_eq!(unwrap_master_key("ABCD-EFGH-JKLM-NPQR", &rc_salt, fast_params(), &rc_slot).unwrap(), mk);
        // And the slots are NOT interchangeable.
        assert_eq!(
            unwrap_master_key("my-password", &rc_salt, fast_params(), &rc_slot),
            Err(CryptoError::WrongSecret)
        );
    }

    #[test]
    fn changing_password_preserves_the_master_key() {
        // Re-wrapping must not disturb the master key — otherwise every file in
        // the vault would become undecryptable after a password change. This is
        // the single most catastrophic bug this module could have.
        let mk = generate_master_key();
        let salt_v1 = generate_salt();
        let old_slot = wrap_master_key("old-pw", &salt_v1, fast_params(), &mk).unwrap();

        // Unwrap with the old password, re-wrap with a new one + a fresh salt.
        let recovered = unwrap_master_key("old-pw", &salt_v1, fast_params(), &old_slot).unwrap();
        let salt_v2 = generate_salt();
        let new_slot = wrap_master_key("new-pw", &salt_v2, fast_params(), &recovered).unwrap();

        // Content sealed BEFORE the password change must still open AFTER it.
        let sealed_before = aead_seal(&mk, b"pre-existing file content");
        let mk_after = unwrap_master_key("new-pw", &salt_v2, fast_params(), &new_slot).unwrap();
        assert_eq!(mk_after, mk);
        assert_eq!(aead_open(&mk_after, &sealed_before).unwrap(), b"pre-existing file content");

        // The old password must no longer open the NEW slot.
        assert_eq!(
            unwrap_master_key("old-pw", &salt_v2, fast_params(), &new_slot),
            Err(CryptoError::WrongSecret)
        );
    }

    #[test]
    fn salts_and_keys_are_not_constant() {
        // Guards against a catastrophic "random_bytes returns zeros" regression.
        assert_ne!(generate_salt(), generate_salt());
        assert_ne!(generate_master_key(), generate_master_key());
        assert_ne!(generate_master_key(), [0u8; KEY_LEN]);
    }

    #[test]
    fn default_kdf_params_are_the_owasp_baseline() {
        // A silent downgrade of these constants would gut the vault's resistance
        // to offline brute force without any test failing elsewhere.
        let p = KdfParams::default();
        assert_eq!(p.m_cost, 65536, "memory cost must be 64 MiB");
        assert_eq!(p.t_cost, 3);
        assert_eq!(p.p_cost, 1);
    }

    #[test]
    fn production_kdf_params_actually_work() {
        // The fast_params() used everywhere else would hide a failure at the
        // real 64 MiB setting (e.g. an allocation refusal). Run the real thing
        // once. Costs ~100 ms.
        let mk = generate_master_key();
        let salt = generate_salt();
        let params = KdfParams::default();
        let wrapped = wrap_master_key("real-params", &salt, params, &mk).unwrap();
        assert_eq!(unwrap_master_key("real-params", &salt, params, &wrapped).unwrap(), mk);
    }
}
