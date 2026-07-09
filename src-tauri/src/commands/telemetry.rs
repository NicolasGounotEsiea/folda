//! Self-owned crash telemetry — sends crash reports to an endpoint the project
//! owner controls (a Google Apps Script that writes to their own Google Sheet;
//! see docs/crash-telemetry-setup.md). NO third-party telemetry service.
//!
//! ## Flow
//!
//! - Frontend catches JS errors / unhandled rejections and calls
//!   `submit_crash_report` (only when the user opted in).
//! - Rust panics are appended to a local buffer file by the panic hook in
//!   `lib.rs` (see `buffer_panic`).
//! - `submit_crash_report` POSTs immediately; on network failure it appends to
//!   the buffer. `flush_pending_crash_reports` (called at startup and on opt-in)
//!   drains the buffer.
//!
//! ## Privacy
//!
//! We send: error kind, message, stack, minified bundle location, an anonymous
//! random install id, app version, OS, arch, timestamp. We NEVER send file
//! paths (beyond minified JS locations like `index-abc.js:102`), file contents,
//! tags, AI conversations, or the DB. Nothing is sent unless the user turned
//! crash reporting on (default off).

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

// ── Configuration (fill these in before crash reporting works) ───────────────
//
// ENDPOINT: the Apps Script Web App URL (…/exec) from your deployment.
// SHARED_SECRET: a random string you also paste into the Apps Script. It's not
// a true secret (it ships in the binary and can be extracted), but it stops
// casual spam POSTs to your endpoint. Rotate it in both places if abused.
//
// While ENDPOINT is left at the placeholder, submit/flush are silent no-ops —
// the app behaves exactly as if crash reporting were off, so shipping without
// configuring the endpoint is safe.
const ENDPOINT: &str = "https://script.google.com/macros/s/AKfycbyVd2NWtlJJ9mDELNLZSLz-cW35pErq_kS9vgZc50ccvlZP94f0K5rSrGD_2C91d1b-Kw/exec";
const SHARED_SECRET: &str = "ioehfboibdsofvkkjb54154!";

/// Keep at most this many buffered reports on disk. Bounds the file if the
/// endpoint is unreachable for a long time; oldest are dropped first.
const MAX_BUFFERED: usize = 50;

/// Process-wide opt-in flag. Mirrors the `telemetryEnabled` setting. Read by
/// the panic hook (which can't touch the DB while the app is dying) so panics
/// are only buffered when the user consented.
static ENABLED: AtomicBool = AtomicBool::new(false);

pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// The crash report as sent by the frontend + enriched server-side.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrashReport {
    pub kind: String,
    pub message: String,
    pub stack: String,
    pub url: String,
    pub install_id: String,
    pub app_version: String,
    // Enriched in `enrich` before sending; frontend leaves these empty.
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub arch: String,
    #[serde(default)]
    pub ts: i64,
}

fn enrich(mut r: CrashReport) -> CrashReport {
    if r.os.is_empty() {
        r.os = std::env::consts::OS.to_string();
    }
    if r.arch.is_empty() {
        r.arch = std::env::consts::ARCH.to_string();
    }
    if r.ts == 0 {
        r.ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
    }
    r
}

/// Local buffer path: `%LOCALAPPDATA%\com.nxs.app\pending-crashes.jsonl`.
/// Computed from the env (not a Tauri AppHandle) so the panic hook — which
/// runs without easy handle access while the app is dying — can reach it too.
/// One JSON object per line (JSONL) for append-only, partial-read safety.
pub fn buffer_path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(base).join("com.nxs.app").join("pending-crashes.jsonl"))
}

fn append_to_buffer(report: &CrashReport) {
    let Some(path) = buffer_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(line) = serde_json::to_string(report) else { return };
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{}", line);
    }
    trim_buffer(&path);
}

/// Keep only the last MAX_BUFFERED lines so a long offline stretch can't grow
/// the file without bound.
fn trim_buffer(path: &PathBuf) {
    let Ok(content) = std::fs::read_to_string(path) else { return };
    let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.len() <= MAX_BUFFERED {
        return;
    }
    let kept = &lines[lines.len() - MAX_BUFFERED..];
    let _ = std::fs::write(path, kept.join("\n") + "\n");
}

/// POST a single report. Returns Ok(()) on 2xx, Err otherwise. Placeholder
/// endpoint → treated as success no-op (nothing to send to).
async fn post_report(client: &reqwest::Client, report: &CrashReport) -> Result<(), String> {
    if ENDPOINT.starts_with("REPLACE_WITH_") {
        return Ok(());
    }
    let body = serde_json::json!({
        "type": "crash",
        "secret": SHARED_SECRET,
        "report": report,
    });
    let resp = client
        .post(ENDPOINT)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("HTTP {}", resp.status()))
    }
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("nxs-crash-reporter")
        .build()
        .unwrap_or_default()
}

// ── Tauri commands ───────────────────────────────────────────────────────────

/// Called by the frontend at startup and when the user toggles the setting.
/// Syncs the process-wide flag the panic hook reads.
#[tauri::command]
pub fn set_crash_reporting_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

/// Submit one crash report. Sends immediately; on failure, buffers to disk for
/// a later flush. Silently no-ops when disabled or endpoint unconfigured, so
/// the frontend never has to care about either condition.
#[tauri::command]
pub async fn submit_crash_report(report: CrashReport) -> Result<(), String> {
    if !is_enabled() {
        return Ok(());
    }
    let report = enrich(report);
    let client = http_client();
    if post_report(&client, &report).await.is_err() {
        append_to_buffer(&report);
    }
    Ok(())
}

/// Drain the on-disk buffer. Reports that still fail to send are kept for the
/// next attempt. No-op when disabled.
#[tauri::command]
pub async fn flush_pending_crash_reports() -> Result<(), String> {
    if !is_enabled() {
        return Ok(());
    }
    let Some(path) = buffer_path() else { return Ok(()) };
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Ok(()), // no buffer file = nothing to flush
    };
    let reports: Vec<CrashReport> = content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<CrashReport>(l).ok())
        .collect();
    if reports.is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }

    let client = http_client();
    let mut still_failing: Vec<CrashReport> = Vec::new();
    for report in reports {
        if post_report(&client, &report).await.is_err() {
            still_failing.push(report);
        }
    }

    if still_failing.is_empty() {
        let _ = std::fs::remove_file(&path);
    } else {
        // Rewrite with only the ones that still didn't make it.
        let lines: Vec<String> = still_failing
            .iter()
            .filter_map(|r| serde_json::to_string(r).ok())
            .collect();
        let _ = std::fs::write(&path, lines.join("\n") + "\n");
    }
    Ok(())
}

/// Called by the panic hook in lib.rs. Best-effort, synchronous, no HTTP (the
/// app may be dying) — just append to the buffer for the next launch to flush.
/// Gated on the process-wide flag so a user who never opted in accumulates
/// nothing.
pub fn buffer_panic(message: &str, location: &str) {
    if !is_enabled() {
        return;
    }
    let report = enrich(CrashReport {
        kind: "rust-panic".to_string(),
        message: message.chars().take(2000).collect(),
        stack: String::new(),
        url: location.chars().take(500).collect(),
        // No frontend install id available in the panic hook. The flush still
        // sends it; the admin view shows an empty install id for panics, which
        // is acceptable (they're rarer and the message+location identify them).
        install_id: String::new(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: String::new(),
        arch: String::new(),
        ts: 0,
    });
    append_to_buffer(&report);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enrich_fills_missing_fields() {
        let r = enrich(CrashReport {
            kind: "js-error".into(),
            message: "boom".into(),
            stack: "".into(),
            url: "".into(),
            install_id: "abc".into(),
            app_version: "0.1.0".into(),
            os: "".into(),
            arch: "".into(),
            ts: 0,
        });
        assert!(!r.os.is_empty());
        assert!(!r.arch.is_empty());
        assert!(r.ts > 0);
    }

    #[test]
    fn enrich_preserves_provided_fields() {
        let r = enrich(CrashReport {
            kind: "js-error".into(),
            message: "boom".into(),
            stack: "".into(),
            url: "".into(),
            install_id: "abc".into(),
            app_version: "0.1.0".into(),
            os: "customos".into(),
            arch: "customarch".into(),
            ts: 12345,
        });
        assert_eq!(r.os, "customos");
        assert_eq!(r.arch, "customarch");
        assert_eq!(r.ts, 12345);
    }

    #[test]
    fn disabled_by_default() {
        // A fresh process must not have crash reporting on.
        assert!(!is_enabled());
    }
}
