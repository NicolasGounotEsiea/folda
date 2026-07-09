# Crash telemetry — one-time setup

nxs can send **opt-in, anonymous crash reports** to a backend **you own**. No
third-party service (no Sentry, no PostHog). The pipeline is:

```
[user's app] --crash--> POST --> Google Apps Script (doPost) --> your Google Sheet
[you] --browser--> GET  -------> Google Apps Script (doGet)  --> admin dashboard
```

- The **Google Sheet** is the datastore (yours, in your Drive).
- The **Apps Script** is the endpoint + the admin page (yours, in your account).
- The **admin dashboard** is gated by **your Google login** (deploy "Only
  myself"), so nobody but you can read the crashes.

Everything stays in your Google account. Users only send data when they turn
the setting on (it is **off by default**).

---

## What gets sent (and what never does)

**Sent:** error kind, error message, technical stack trace, minified bundle
location (e.g. `index-abc.js:102`), app version, OS, CPU arch, an anonymous
random install id, timestamp.

**Never sent:** file paths, file contents, tags, workspace names, AI
conversations, or the database. See the exact payload in
`src-tauri/src/commands/telemetry.rs` (`CrashReport` struct) and the frontend
capture in `src/utils/telemetry.ts`.

---

## Step 1 — Create the Sheet

1. Go to <https://sheets.google.com> and create a blank spreadsheet. Name it
   e.g. "nxs crashes".
2. Copy its **ID** from the URL: `https://docs.google.com/spreadsheets/d/`**`THIS_LONG_ID`**`/edit`.

You don't need to add headers — the script creates a `crashes` tab with headers
on first write.

## Step 2 — Create the Apps Script

1. In the Sheet: **Extensions → Apps Script**.
2. Delete the default `function myFunction() {}`.
3. Open `admin/crash-telemetry.gs` from this repo, copy the whole file, paste it
   into the editor.
4. At the top, set:
   - `SHEET_ID` → the ID from Step 1.
   - `SHARED_SECRET` → a random string (e.g. run `openssl rand -hex 16`). **Use
     the exact same string** in `src-tauri/src/commands/telemetry.rs`
     (`SHARED_SECRET` constant).
5. Save (Ctrl+S).

## Step 3 — Deploy as a Web App

1. **Deploy → New deployment**.
2. Click the gear → **Web app**.
3. Settings:
   - **Execute as:** Me
   - **Who has access:** *Only myself* (recommended — this makes the dashboard
     require your Google login).
4. **Deploy**. Authorize the script when prompted (it's your own script).
5. Copy the **Web app URL** — it ends in `/exec`.

### If the app's POSTs fail with a login redirect

"Only myself" can, on some accounts, make the anonymous `doPost` from the app
get bounced to a Google login page (the app can't log in as you). If you see
crash reports never arriving:

1. Redeploy with **Who has access: Anyone**.
2. In the script, set `ADMIN_KEY` to another random string.
3. Open the dashboard as `…/exec?key=YOUR_ADMIN_KEY` (the key gates the
   dashboard now, since Google login no longer does).

The `SHARED_SECRET` still protects the write endpoint in this mode.

## Step 4 — Point the app at your endpoint

In `src-tauri/src/commands/telemetry.rs`:

```rust
const ENDPOINT: &str = "https://script.google.com/macros/s/DEPLOY_ID/exec";
const SHARED_SECRET: &str = "the-same-secret-as-in-the-script";
```

Rebuild the app (`npm run tauri build`). Until `ENDPOINT` is set, crash
reporting is a silent no-op — the app behaves exactly as if the feature were
off, so it's safe to ship unconfigured and wire it up later.

## Step 5 — View crashes

Open the `/exec` URL in your browser (with `?key=…` if you used ADMIN_KEY
mode). You get the dashboard: newest-first crash cards, filters by version / OS
/ kind, free-text search across message + stack, expandable stack traces. The
raw Sheet is always there too as a backup / for CSV export.

---

## How it behaves in the app

- **Off by default.** Settings → About → "Automatic crash reports" toggle, with
  a clear description of exactly what's sent and where.
- **Frontend crashes** (uncaught JS errors, unhandled promise rejections) are
  caught by `src/utils/telemetry.ts` and sent immediately when enabled.
- **Rust panics** are buffered to `%LOCALAPPDATA%\com.nxs.app\pending-crashes.jsonl`
  by the panic hook and flushed on the next launch.
- **Offline?** Failed sends are buffered to the same file and retried at next
  launch (capped at 50 to bound the file).
- The process-wide gate (`set_crash_reporting_enabled`) means a user who never
  opted in buffers nothing and sends nothing — including panics.

## Rotating the secret

Change `SHARED_SECRET` in **both** the script and `telemetry.rs`, redeploy the
script, rebuild the app. Old app builds using the previous secret will get
`bad secret` rejections (their reports are dropped, not stored).

## Scaling note

Apps Script free quotas (~20k executions/day) are ample for a testing / early
commercial user base. If you outgrow them, only the endpoint changes: keep the
same client (`telemetry.rs` just POSTs JSON to a URL), swap the Apps Script for
a Cloudflare Worker + D1/KV or a small VPS endpoint, and repoint `ENDPOINT`.
