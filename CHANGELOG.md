# Changelog

All notable changes to Contextual Workspace are documented here.

## [0.1.2] - 2026-05-05

### Fixed

- **Close button non-functional** — `core:window:allow-destroy` capability was missing; `Window.destroy()` was failing silently on every click. Added the permission so the titlebar × button and Alt+F4 now reliably save state and close the window.
- **Auto-tags not applied to files created in-app** — new files created via the app were not receiving extension-based auto-tags ("Text", "Images", "Code", etc.). Root cause: the path was built in the frontend with forward-slashes, then converted in Rust, producing a key that didn't match the backslash paths used by `list_directory`. Fixed by passing `dir` + `name` separately and building the full path in Rust with `Path::join`, which guarantees OS-native separators. The file watcher (`handle_fs_event`) also now applies auto-tags on `Create` events as a second layer.
- **"Created" date always showing "—"** — `ListEntry` was missing the `created_at` field; it was hard-coded to 0 everywhere. Added the field to the Rust struct and TypeScript interface, and populated it from `fs::metadata().created()` in `list_directory`, `search_folders`, and the sharing server.
- **Language change only affecting Settings modal** — the `useTranslation()` i18n hook was only wired up in `PreviewPanel`. Extended it to `Toolbar` (search placeholder, "watching" indicator) and `FileList` (Name / Size / Modified column headers).
- **Settings toggles misaligned** — the toggle thumb (absolute-positioned `<span>`) was rendering outside the pill because `<button>` elements don't establish a CSS positioning context in WebView2. Changed the outer element from `<button>` to `<div role="switch">`.

## [0.1.1] - 2026-05-05

### Added

- **Snapshots** — lightweight per-file version history stored in SQLite. Captures a snapshot automatically on every save (auto mode) or on demand via a "+ Save" button (manual mode). Configurable max count per file (2–50, default 10). Files larger than 1 MB are skipped silently.
- **Snapshot diff view** — clicking any snapshot in the History panel opens a modal showing a line-by-line diff between the snapshot and the current file content. Added lines are highlighted in green, removed lines in red; long unchanged sections are collapsed. Restore is available directly from the modal.
- **Snapshot settings** — two new options in Settings → Editor: snapshot mode (Auto / Manual) and max snapshots per file (slider, 2–50).
- **Per-file activity feed** — a "History" tab in the preview panel lists all recorded events for the selected file (open, edit, rename, delete) with timestamps.
- **Guest permissions for shared workspaces** — while hosting, a collapsible "Permissions invités" section in the Share modal lets the host configure what guests can do (List, Read, Create, Edit, Delete). A workspace-wide default applies everywhere; per-path overrides allow narrower or broader access to specific folders or files (longest-prefix match). Permissions are enforced server-side on every WebSocket command.

### Fixed

- **File/folder selection highlighting broken** — `bg-accent/10` and similar Tailwind opacity modifiers were producing invalid CSS because `--color-accent` was set as a hex value. Fixed by adding a `--color-accent-rgb` variable (space-separated RGB) and updating the Tailwind config to use `rgb(var(--color-accent-rgb) / <alpha-value>)`. The `applySettings` function now keeps both variables in sync when the accent color changes.

## [0.1.0] - initial release

First public build. Core features: multi-workspace file explorer, CodeMirror editor, tags & tag rules, full-text search, shared workspaces over WebSocket, frameless window.
