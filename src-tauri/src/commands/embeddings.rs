//! Semantic search — embedding generation and vector similarity.
//!
//! Complements the FTS5 keyword search in `search.rs`: FTS finds files that
//! contain the words you typed, this finds files that are *about* what you
//! typed. See CLAUDE.md §45.
//!
//! ## Design constraints this file inherits
//!
//! - **Opt-in and non-fatal.** Everything here is gated on `semanticSearch`.
//!   If Ollama is down or the model is missing, indexing proceeds exactly as it
//!   did before and files simply stay unembedded. Content indexing must never
//!   fail *because* semantic search is misconfigured.
//! - **Vault exclusion is inherited.** We only ever embed text already stored in
//!   `file_content`, and vault files never reach that table (§43). Any future
//!   path that embeds text from somewhere else MUST re-check `path_is_in_vault`
//!   first — an embedding of vault content sitting in the unencrypted DB would
//!   survive locking the vault.

use rusqlite::Connection;

/// Ollama's batch embedding endpoint. The older `/api/embeddings` takes a
/// single `prompt`, which would mean one HTTP round-trip per file.
const EMBED_PATH: &str = "/api/embed";

/// Ollama can be slow on a cold model load; generous but bounded so a hung
/// server can't stall the whole indexing run.
const EMBED_TIMEOUT_SECS: u64 = 60;

/// Resolved configuration for one indexing run. `None` = feature off or
/// unconfigured, in which case the caller skips embedding entirely.
#[derive(Clone, Debug)]
pub struct EmbedConfig {
    pub base_url: String,
    pub model: String,
}

/// Read the semantic-search settings once per run (never per file).
pub fn load_config(db: &Connection) -> Option<EmbedConfig> {
    let get = |key: &str| -> Option<String> {
        db.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get::<_, String>(0),
        )
        .ok()
    };

    if get("semanticSearch").as_deref() != Some("true") {
        return None;
    }
    let base_url = get("ollamaUrl").unwrap_or_else(|| "http://localhost:11434".to_string());
    let model = get("embeddingModel").unwrap_or_else(|| "nomic-embed-text".to_string());
    if base_url.trim().is_empty() || model.trim().is_empty() {
        return None;
    }
    Some(EmbedConfig {
        base_url: base_url.trim_end_matches('/').to_string(),
        model: model.trim().to_string(),
    })
}

/// Embed a batch of texts. Returns one unit-length vector per input, in order.
///
/// Errors are returned rather than logged-and-swallowed so the *caller* decides
/// what a failure means — during indexing it's "skip these files this round",
/// during a search it's a message the user should see.
pub async fn embed_batch(cfg: &EmbedConfig, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(EMBED_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(format!("{}{}", cfg.base_url, EMBED_PATH))
        .json(&serde_json::json!({ "model": cfg.model, "input": texts }))
        .send()
        .await
        .map_err(|e| format!("Cannot reach Ollama at {}: {}", cfg.base_url, e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        // Two very different things return 404 here, and telling the user to
        // download a model they already have is worse than saying nothing:
        //   - the MODEL is missing  → Ollama answers with an error body naming it
        //   - the ENDPOINT is missing → /api/embed only exists on Ollama 0.3+,
        //     and an older server 404s the path itself with no such body.
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(if body.contains("not found") || body.contains(&cfg.model) {
                format!(
                    "Ollama does not have the embedding model '{}'. Pull it first, or pick another one in Settings.",
                    cfg.model
                )
            } else {
                format!(
                    "This Ollama version has no {} endpoint (it needs Ollama 0.3 or newer). Update Ollama to use semantic search.",
                    EMBED_PATH
                )
            });
        }
        return Err(format!("Ollama embedding failed (HTTP {}): {}", status, body));
    }

    #[derive(serde::Deserialize)]
    struct EmbedResp {
        #[serde(default)]
        embeddings: Vec<Vec<f32>>,
    }
    let parsed: EmbedResp = resp.json().await.map_err(|e| e.to_string())?;
    if parsed.embeddings.len() != texts.len() {
        return Err(format!(
            "Ollama returned {} embeddings for {} inputs",
            parsed.embeddings.len(),
            texts.len()
        ));
    }
    Ok(parsed.embeddings.into_iter().map(normalize).collect())
}

/// Scale a vector to unit length so cosine similarity is a plain dot product.
/// A zero vector (degenerate model output) is returned as-is; `dot` then scores
/// it 0 against everything, which is the right "no signal" behaviour.
fn normalize(mut v: Vec<f32>) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
    v
}

/// Cosine similarity of two unit-length vectors. Mismatched lengths score 0
/// rather than panicking — that happens when the embedding model changed and a
/// stale row survived, and a wrong-but-safe 0 beats a crash.
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Pack a vector for the `vec` BLOB column: little-endian f32, no header.
/// `dim` lives in its own column, so the blob stays a bare array.
pub fn pack(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

/// Inverse of [`pack`]. A blob whose length isn't a multiple of 4 is corrupt;
/// return an empty vector so it scores 0 instead of producing garbage.
pub fn unpack(bytes: &[u8]) -> Vec<f32> {
    if !bytes.len().is_multiple_of(4) {
        return Vec::new();
    }
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Store one file's vector.
///
/// Called ONLY on success. Unlike `file_content`, a failed embedding gets no
/// sentinel row: an embedding failure almost always means Ollama was not
/// running, and recording it as attempted would permanently skip the file after
/// a single transient outage. No row simply means "try again next run".
pub fn store(db: &Connection, file_id: i64, vec: &[f32], model: &str) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO file_embeddings (file_id, vec, model, dim, indexed_at)
         VALUES (?1, ?2, ?3, ?4, unixepoch())
         ON CONFLICT(file_id) DO UPDATE SET
             vec = excluded.vec, model = excluded.model,
             dim = excluded.dim, indexed_at = excluded.indexed_at",
        rusqlite::params![file_id, pack(vec), model, vec.len() as i64],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_unpack_round_trips() {
        let v = vec![0.5f32, -0.25, 0.0, 1.0];
        assert_eq!(unpack(&pack(&v)), v);
    }

    #[test]
    fn unpack_rejects_corrupt_blob() {
        // Not a multiple of 4 bytes — a truncated or hand-edited row.
        assert!(unpack(&[1, 2, 3]).is_empty());
    }

    #[test]
    fn normalize_gives_unit_length() {
        let v = normalize(vec![3.0, 4.0]);
        let len = (v[0] * v[0] + v[1] * v[1]).sqrt();
        assert!((len - 1.0).abs() < 1e-6, "len was {}", len);
    }

    #[test]
    fn normalize_leaves_zero_vector_alone() {
        // Must not divide by zero or produce NaN — a NaN would poison every
        // later comparison instead of simply scoring 0.
        let v = normalize(vec![0.0, 0.0]);
        assert!(v.iter().all(|x| *x == 0.0));
    }

    #[test]
    fn dot_scores_identical_vectors_highest() {
        let a = normalize(vec![1.0, 2.0, 3.0]);
        let b = normalize(vec![1.0, 2.0, 3.0]);
        let c = normalize(vec![-1.0, -2.0, -3.0]);
        assert!((dot(&a, &b) - 1.0).abs() < 1e-6);
        assert!(dot(&a, &c) < 0.0, "opposite vectors must score negative");
    }

    #[test]
    fn dot_of_mismatched_dims_is_zero_not_panic() {
        // Happens when the embedding model changed under a stale row.
        assert_eq!(dot(&[1.0, 0.0], &[1.0, 0.0, 0.0]), 0.0);
    }
}
