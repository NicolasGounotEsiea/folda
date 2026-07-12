//! WebSocket frame chunking for Noise-encrypted application messages.
//!
//! ## Why chunking is needed
//!
//! Noise has a hard per-message limit of 65535 bytes ciphertext (16-bit length
//! field in the spec). With the 16-byte AEAD tag, that leaves 65519 bytes of
//! plaintext per Noise frame. Our application messages can be larger:
//!
//!   - A `ListDir` response on a folder with 1000+ entries serializes to
//!     ~80-200 KB of JSON.
//!   - `ReadFile` returns the file content (capped server-side at 10 MB).
//!
//! We split each application-level JSON message into multiple Noise-encrypted
//! WS Binary frames, each tagged with a 1-byte continuation flag telling the
//! receiver whether more frames are coming.
//!
//! ## Wire format (per WS Binary frame, AFTER decryption)
//!
//! ```text
//! [ flag : 1 byte | data : 1..=MAX_PLAINTEXT_CHUNK bytes ]
//! flag = 0  → last (or only) chunk of this app message
//! flag = 1  → more chunks follow on this connection
//! ```
//!
//! ## Ordering guarantees
//!
//! WebSocket preserves frame order within a single connection, and Noise's
//! transport state increments a strict nonce counter for each direction — any
//! reorder or replay causes decryption to fail and the connection to be
//! dropped. So the simple "accumulate plaintext until flag=0" model is safe
//! without explicit sequence numbers.

use snow::TransportState;
use tokio_tungstenite::tungstenite::Message;

/// Per-chunk plaintext payload size. 60 KB sits comfortably under Noise's
/// 65519-byte hard cap with margin for the 1-byte continuation flag and any
/// future per-chunk overhead we might add.
pub const MAX_PLAINTEXT_CHUNK: usize = 60 * 1024;

/// Per-chunk ciphertext buffer size. 60 KB plaintext + 1 byte flag + 16-byte
/// Noise AEAD tag, with a small safety margin.
const CIPHERTEXT_BUFFER: usize = MAX_PLAINTEXT_CHUNK + 1 + 64;

/// Hard cap on a single app message after reassembly. 32 MB — covers any
/// realistic file or directory listing in the sharing use case while bounding
/// memory pressure under a malicious peer that streams forever with `flag=1`.
const MAX_TOTAL_MESSAGE: usize = 32 * 1024 * 1024;

/// Encrypt `plaintext` into a sequence of WebSocket Binary messages ready to
/// be sent on a `Sink`. Caller iterates and forwards each in order.
///
/// All chunks share the same transport state — Noise's nonce counter is
/// incremented once per encrypted chunk, the receiver MUST consume them in
/// the same order on the corresponding ChunkReader.
pub fn encrypt_chunks(
    transport: &mut TransportState,
    plaintext: &[u8],
) -> Result<Vec<Message>, String> {
    let mut out = Vec::with_capacity(plaintext.len() / MAX_PLAINTEXT_CHUNK + 1);
    let mut offset = 0;
    // An empty plaintext should still produce one frame so the receiver gets a
    // "flag=0, empty body" message and can deserialize an empty JSON value.
    // The loop body below handles len=0 correctly because the first iteration
    // computes end=0 and more=false.
    loop {
        let end = (offset + MAX_PLAINTEXT_CHUNK).min(plaintext.len());
        let chunk = &plaintext[offset..end];
        let more = end < plaintext.len();

        // Compose the inner buffer: [flag][chunk] then Noise-encrypt it.
        // Could be done in two write_message calls but a single contiguous
        // buffer is simpler and avoids two AEAD invocations per chunk.
        let mut inner = Vec::with_capacity(1 + chunk.len());
        inner.push(if more { 1 } else { 0 });
        inner.extend_from_slice(chunk);

        let mut ciphertext = vec![0u8; CIPHERTEXT_BUFFER.max(inner.len() + 16)];
        let n = transport
            .write_message(&inner, &mut ciphertext)
            .map_err(|e| format!("Noise encrypt failed: {}", e))?;
        ciphertext.truncate(n);
        out.push(Message::Binary(ciphertext));

        offset = end;
        if !more {
            break;
        }
    }
    Ok(out)
}

/// Incremental decoder for incoming chunks. One instance per connection,
/// long-lived across the loop's lifetime. Each WebSocket Binary frame is fed
/// via `push`; when the last chunk of a message arrives, `push` returns
/// `Some(plaintext)` containing the fully reassembled application message.
#[derive(Default)]
pub struct ChunkReader {
    buffer: Vec<u8>,
}

impl ChunkReader {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one received ciphertext frame. Returns:
    /// - `Ok(None)` — chunk was a non-terminal one, keep reading.
    /// - `Ok(Some(bytes))` — the message is complete; the caller should parse
    ///   `bytes` as JSON.
    /// - `Err(msg)` — decrypt failed, frame malformed, or the accumulated
    ///   message exceeded the cap. The caller should drop the connection.
    pub fn push(
        &mut self,
        transport: &mut TransportState,
        ciphertext: &[u8],
    ) -> Result<Option<Vec<u8>>, String> {
        // Plaintext output buffer must be at least ciphertext.len() — Noise
        // never expands during decryption (only contracts by 16 bytes for the
        // AEAD tag). Sized slightly larger for safety.
        let mut plaintext = vec![0u8; ciphertext.len() + 16];
        let n = transport
            .read_message(ciphertext, &mut plaintext)
            .map_err(|e| format!("Noise decrypt failed: {}", e))?;
        if n < 1 {
            return Err("Empty Noise frame".to_string());
        }
        let more = plaintext[0] == 1;
        let data = &plaintext[1..n];

        if self.buffer.len() + data.len() > MAX_TOTAL_MESSAGE {
            return Err(format!(
                "Application message exceeds {} byte cap",
                MAX_TOTAL_MESSAGE
            ));
        }
        self.buffer.extend_from_slice(data);

        if more {
            Ok(None)
        } else {
            // Hand the accumulated buffer to the caller. `mem::take` swaps in
            // an empty Vec so we're ready for the next message immediately.
            Ok(Some(std::mem::take(&mut self.buffer)))
        }
    }
}
