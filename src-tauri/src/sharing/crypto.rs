//! Cryptographic primitives for workspace sharing.
//!
//! ## Threat model
//!
//! The previous sharing implementation used `ws://` (unencrypted) and sent the
//! share password as the first JSON message. Three concrete problems:
//!
//!   1. **Passive sniffing.** Any device on the same LAN (Wi-Fi café,
//!      coworking space, university network) could trivially read both the
//!      password AND every file transferred over the share.
//!   2. **Cleartext password.** Even on a "trusted" LAN, any intermediate
//!      proxy / equipment / IDS sees the password.
//!   3. **No host authentication.** An attacker on the LAN could impersonate
//!      the host (ARP spoof, rogue AP) and harvest the password from the
//!      victim guest, then connect to the real host as that guest.
//!
//! ## Solution
//!
//! Wrap every WebSocket frame inside a [Noise Protocol Framework] handshake
//! and transport. The pattern is
//! `Noise_NNpsk0_25519_ChaChaPoly_BLAKE2s`:
//!
//!   - **NN**: neither side has a long-term static key (no PKI, no certs)
//!   - **psk0**: the share password is mixed into the very first handshake
//!     hash, so an attacker who doesn't know the password CANNOT complete the
//!     handshake (no valid plaintext can be produced for the responder to
//!     decrypt). Defeats MITM without certs.
//!   - **25519**: ephemeral X25519 ECDH on both sides. Each session derives
//!     fresh keys, giving **Perfect Forward Secrecy** — leaking the password
//!     later doesn't decrypt past sessions.
//!   - **ChaChaPoly**: ChaCha20-Poly1305 AEAD for the transport. Fast on every
//!     CPU we care about (no AES-NI dependency), constant-time, authenticated.
//!   - **BLAKE2s**: hash for key derivation. Snow's choice for NNpsk0.
//!
//! ## What this does NOT protect against
//!
//!   - **Online brute-force of weak passwords.** The handshake itself is the
//!     password oracle: each failed handshake = one tried password. We
//!     rate-limit on the server side (per-IP lockout after 3 failures, see
//!     `server.rs::FailureTracker`) and the auto-generated password is 20
//!     chars from a 32-char alphabet (~100 bits of entropy), so this is
//!     practically impossible for any realistic attacker.
//!   - **Compromised endpoint.** If the host or guest machine itself is
//!     compromised, the attacker reads everything anyway. Out of scope.
//!   - **Traffic analysis.** An attacker on the LAN sees encrypted frames
//!     coming and going (size, timing). They can't read content but can
//!     infer "the guest is currently downloading something large".
//!
//! [Noise Protocol Framework]: https://noiseprotocol.org/

use sha2::{Digest, Sha256};
use snow::params::NoiseParams;

/// Noise PSK length in bytes (32 — matches the symmetric key size for this
/// pattern).
pub const PSK_LEN: usize = 32;

/// Parse the Noise pattern. Panics if the pattern string is wrong — it's a
/// compile-time string, panic at startup is acceptable (means dev typo).
pub fn noise_params() -> NoiseParams {
    "Noise_NNpsk0_25519_ChaChaPoly_BLAKE2s"
        .parse()
        .expect("Noise pattern is a fixed literal — should always parse")
}

/// Derive a 32-byte PSK from the share password. Uses SHA-256 with a fixed
/// domain-separation prefix so the same password used in any other context
/// (an unrelated feature, a future protocol) can't be confused with a share
/// PSK and accidentally accept handshakes from there.
///
/// The prefix is versioned (`v1`) so we can rotate the derivation later
/// without breaking backwards compatibility — a future v2 would derive a
/// different PSK from the same password.
pub fn derive_psk(password: &str) -> [u8; PSK_LEN] {
    let mut hasher = Sha256::new();
    hasher.update(b"nxs-share-psk-v1:");
    hasher.update(password.as_bytes());
    let digest = hasher.finalize();
    let mut out = [0u8; PSK_LEN];
    out.copy_from_slice(&digest);
    out
}
