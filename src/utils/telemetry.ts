// Self-owned crash telemetry — NO third-party service.
//
// Replaces the previous PostHog analytics + Sentry error tracking (both were
// third-party systems that sent data to infrastructure we don't control). Per
// the project owner's requirement, everything now flows to an endpoint THEY
// own (a Google Apps Script that writes to their own Google Sheet — see
// docs/crash-telemetry-setup.md). The actual HTTP POST happens in the Rust
// backend (commands/telemetry.rs) so the endpoint URL never lives in the DOM
// and there are no CORS constraints.
//
// This module is only the frontend capture layer: it installs global error
// handlers and forwards crashes to the backend WHEN the user has opted in.
// Nothing is ever sent while `_enabled` is false — the default.

import { invoke } from "@tauri-apps/api/core";

let _enabled = false;
let _installed = false;

// Anonymous, random, generated once and kept in localStorage. NOT tied to any
// identity — its only purpose is to let us tell "one machine crashed 20 times"
// apart from "20 machines crashed once", which changes how we triage. It can
// be wiped by clearing app data and never leaves the user's control.
const _installId = (() => {
  const KEY = "nxs_install_id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
})();

interface CrashPayload {
  kind: string;        // "js-error" | "unhandled-rejection"
  message: string;
  stack: string;
  url: string;         // minified bundle location, e.g. "index-abc.js:102" — not sensitive
}

// Strip OS filesystem paths out of anything we send. Backend errors reaching the
// frontend as rejected `invoke` promises routinely interpolate real paths — and
// even vault file NAMES ("'budget.xlsx' is not in this vault") — so an unhandled
// rejection could otherwise ship a user's private path/filename to the crash
// sheet, breaking the "we never send file paths" promise (and the vault's).
// We target Windows drive paths (`C:\…`) and UNC paths (`\\server\…`); minified
// bundle locations use forward-slash URLs (`…/index-abc.js:102`) and are left
// intact so stacks stay useful.
function scrubPaths(s: string): string {
  return s
    .replace(/[A-Za-z]:\\[^\s"'<>|]*/g, "<path>")
    .replace(/\\\\[^\s"'<>|]+/g, "<path>");
}

function send(p: CrashPayload) {
  if (!_enabled) return;
  // Fire-and-forget. The backend buffers to disk on network failure and
  // retries at next launch, so a dropped promise here is not a lost report.
  invoke("submit_crash_report", {
    report: {
      kind: p.kind,
      message: scrubPaths(p.message).slice(0, 2000),
      stack: scrubPaths(p.stack).slice(0, 8000),
      url: p.url.slice(0, 500),
      install_id: _installId,
      app_version: __APP_VERSION__,
    },
  }).catch(() => {});
}

// Installed exactly once, regardless of how many times telemetryInit runs
// (React strict mode, settings reloads). The handlers themselves always
// check `_enabled` at fire time, so toggling the setting live takes effect
// without re-registering.
function installHandlers() {
  if (_installed) return;
  _installed = true;

  window.addEventListener("error", (e) => {
    // Filter noise that isn't actionable and floods reports.
    const msg = e.message ?? "";
    if (msg.includes("ResizeObserver loop")) return;
    send({
      kind: "js-error",
      message: msg || String(e.error ?? "unknown"),
      stack: e.error?.stack ?? "",
      url: `${e.filename ?? ""}:${e.lineno ?? 0}:${e.colno ?? 0}`,
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    send({
      kind: "unhandled-rejection",
      message: reason?.message ?? String(reason ?? "unknown"),
      stack: reason?.stack ?? "",
      url: "",
    });
  });
}

/// Called once at startup with the persisted opt-in value. Installs the global
/// handlers (they're cheap and always gated) and, when enabled, asks the
/// backend to flush any crash reports buffered while offline / from a previous
/// Rust panic.
export function telemetryInit(enabled: boolean) {
  _enabled = enabled;
  installHandlers();
  // Sync the backend gate (the Rust panic hook reads it) BEFORE flushing.
  invoke("set_crash_reporting_enabled", { enabled }).catch(() => {});
  if (enabled) {
    invoke("flush_pending_crash_reports").catch(() => {});
  }
}

/// Called when the user toggles the setting so the change takes effect live —
/// both the JS-side gate and the Rust-side gate move together.
export function telemetrySetEnabled(enabled: boolean) {
  _enabled = enabled;
  invoke("set_crash_reporting_enabled", { enabled }).catch(() => {});
  if (enabled) invoke("flush_pending_crash_reports").catch(() => {});
}
