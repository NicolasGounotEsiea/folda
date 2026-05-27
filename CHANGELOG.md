# Changelog

All notable changes to nxs are documented here.

## [0.1.5] - 2026-05-28

### Added

- **Rubber-band selection** — click and drag on the empty area of the file list to draw a selection rectangle; all entries overlapping the rect are selected on pointer release.
- **External drag-and-drop** — drag files and folders from nxs to any external Windows app (File Explorer, browser, desktop, etc.). Uses `tauri-plugin-drag` under the hood: pointer capture keeps tracking the cursor even after it leaves the window, and the native OS drag kicks in the moment the pointer crosses the window boundary.
- **Windows shell integration** — "Open with nxs" entry now appears in the File Explorer right-click context menu for files, folders, and the folder background. Install/uninstall directly from **Settings → Explorer** with a single toggle (writes to HKCU — no admin required). Launching nxs with a `--path` argument or from the context menu navigates straight to that path.
- **Command palette: recent files** — when the query is empty the palette lists the 10 most recently navigated or opened files (sourced from the activity log), so you can jump back to anything without typing.
- **Command palette: recent searches** — previous search terms are persisted in localStorage and shown below recent files; clicking one restores it in the search field.
- **Live filesystem search** — `search_live` runs a parallel walkdir scan (max depth 3, heavy dirs excluded) alongside the SQLite FTS query. Both results are merged and deduplicated in the palette for instant local results even for files not yet indexed.

### Improved

- **Disk usage modal** — computation now runs in a `spawn_blocking` thread so it never freezes the UI; skips `node_modules`, `.git`, `target`, `__pycache__`, `.cargo`, `vendor`, `dist`, `.next`, `.nuxt`, and `build` directories for speed and relevance. A note in the modal footer informs the user of excluded directories.
- **Navigation history** — back / forward now correctly update the active tab name; previously the tab label stayed stuck on the child folder after pressing Back.
- **Activity recording** — every folder navigation and every file open is logged to the SQLite activity table, feeding both the command palette recent list and the per-file activity feed.

### Removed

- **Folder size column** — the async per-row size computation caused hover transition jank. The column is removed; aggregate disk usage is still available through the dedicated Disk Usage modal.

## [0.1.4] - 2026-05-12

### Added

- **Trash / Recycle bin** — delete (Del) now moves files and folders to a soft-delete bin stored in AppData instead of permanently removing them. The bin is accessible via the "Corbeille" button at the bottom of the sidebar: browse trashed items with their original path, deletion date, and size; restore any item to its original location (with automatic conflict resolution if the path is taken); delete an item permanently; or empty the entire bin at once with a two-step confirmation. Shift+Del bypasses the bin and permanently deletes immediately (with confirmation dialog). Remote tabs still use direct deletion.
- **Archive manager** — clicking any `.zip`, `.tar`, `.tar.gz`, or `.tgz` file opens a built-in archive viewer instead of the editor. Features: virtual folder navigation with breadcrumb trail, sortable file/folder listing with sizes and compression ratios, "Extract here" (extracts to a same-level folder named after the archive), and "Extract to…" which opens the in-app folder picker. Status bar shows file count, total uncompressed and compressed size, and space savings percentage.
- **In-app folder picker** — replaces the native OS file dialog for all "pick a destination" flows. Supports breadcrumb navigation, ".." back row, subfolder creation (inline input), and a path preview. Used by "Extract to…" in both the archive viewer and the file list context menu.
- **ZIP creation with name prompt** — right-click any file, folder, or selection → *Compress to ZIP*. An inline modal lets you set the archive name before it is created (pre-filled with the file/folder name, ".zip" appended automatically). Works for single items and multi-selections.
- **Binary snapshots** — the snapshot/history panel now supports non-text files. Images (PNG, JPG, WebP…) and office documents (XLSX, ODS, PDF) can be snapshotted and restored; the panel shows a restore-only UI (no diff) for binary formats. CSV files retain the full line-by-line diff view.

### Improved

- **i18n consistency** — all UI strings in every component now go through the `useTranslation()` system. No more hardcoded French or English mixed across the codebase. New translation keys cover: common actions (cancel, close, refresh, create), file operations (rename, duplicate, copy, cut, paste), context menu labels, status bar plurals, trash strings, archive strings, and the folder picker. Both `en` and `fr` locales are fully covered.
- **Context menu** — "Delete" for local files is now labelled *Move to Trash* (Del) with a separate *Delete permanently* entry (Shift+Del); remote tabs keep a single *Delete* entry. All labels adapt to the current language.

## [0.1.3] - 2026-05-06

### Added

- **Multi-window support** — right-click any file or folder and choose *Open in new window*; same option available on folder and file tab context menus. Popup windows use native OS decorations so move, resize, and close all work out of the box.
- **Image thumbnails in grid view** — `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.avif` files render actual thumbnails in grid layout instead of a generic icon. Thumbnails load lazily via Tauri's asset protocol.
- **Status bar** — the file list now shows a persistent bottom bar with total item count (folders + files); when items are selected it switches to selection count and cumulative file size.
- **Editable path bar** — click anywhere on the breadcrumb to switch to a text input and type a path directly. Enter navigates, Escape cancels.

### Improved

- **CSV editor** — editor now stays in table view after initial load (was incorrectly falling back to a raw textarea). Virtual scrolling added for large files (up to 50 000 rows with no lag); row/column count shown in the info bar; fixed an issue where the last rows were unreachable due to the status bar sitting outside the scroll container.
- **Image gallery navigation** — arrow keys and prev/next buttons now cycle images within the current tab instead of opening a new tab for each image.
- **Tab bar overflow** — left/right chevron scroll buttons appear automatically when file or folder tabs overflow the bar width; mouse-wheel scrolling also works.
- **Navigation performance** — listing a directory no longer scans each subdirectory to count children. This eliminates multi-second hangs when navigating outside a workspace on machines with OneDrive or other virtual-filesystem providers.

### Fixed

- **PDF viewer white screen** — updated the pdfjs-dist v5 render call to pass the required `canvas` parameter; added `vite-env.d.ts` so the `?url` worker import resolves under TypeScript.
- **"Open with default app" error** — spurious `state: undefined` argument removed from the `open_with_default` invoke call in DocumentViewer.
- **Popup window snap-back to folder** — React Strict Mode causes the restore effect to run twice; the second run was consuming the (now-absent) init data and falling through to normal workspace restore, which called `setContexts` and wiped `openedFile`. Fixed by: (1) making `get_window_init_data` non-destructive (clones the entry instead of removing it); (2) always returning early in non-main windows regardless of whether init data is present; (3) guarding the init block with `!popupInit` so it runs at most once.

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
