# nxs

[![CI](https://github.com/NicolasGounotEsiea/folda/actions/workflows/ci.yml/badge.svg)](https://github.com/NicolasGounotEsiea/folda/actions/workflows/ci.yml)
[![Release](https://github.com/NicolasGounotEsiea/folda/actions/workflows/release.yml/badge.svg)](https://github.com/NicolasGounotEsiea/folda/releases)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](#license)

A local-first file manager for Windows built with Tauri 2 + React + Rust.

## Download

Grab the latest installer from the [Releases](https://github.com/NicolasGounotEsiea/folda/releases) page.  
Two formats are available: **NSIS `.exe`** (recommended) and **MSI `.msi`**.

## Features

- **Multi-workspace** — organize folders into named workspaces with icons, tags, and pinned paths
- **File explorer** — multi-tab browsing, context menus, bulk rename, drag & drop; rubber-band multi-selection; image thumbnails in grid view; status bar; editable path bar
- **Drag & drop** — internal move/copy between folders; external drag to any Windows app (Explorer, browser, desktop) using the native OS drag API
- **Windows shell integration** — "Open with nxs" context menu entry in File Explorer (files, folders, background); installs/uninstalls from Settings with no admin rights required
- **Multi-window** — open any file or folder in an independent window via right-click → *Open in new window*
- **Trash** — Del moves files to a recoverable bin; browse, restore, or permanently delete from the sidebar; Shift+Del skips the bin
- **Archive manager** — browse ZIP, TAR, TAR.GZ contents with virtual folder navigation; extract here or to any destination via the in-app folder picker; compress files/folders to ZIP with a custom name
- **Editor** — syntax-highlighted editor (CodeMirror) for text, code, Markdown, and DOCX preview
- **Snapshots** — lightweight per-file version history stored in SQLite; auto mode (snapshot on every save) or manual mode; configurable max count (2–50); diff view for text files; restore-only for binary files (images, spreadsheets, PDFs)
- **Activity feed** — per-file history tab in the preview panel showing open, edit, rename, and delete events with timestamps
- **Quick Look** — press Space on any selected file to open an instant floating preview
- **Command palette** — Ctrl+P opens a launcher with recent files, recent searches, and fuzzy file search (parallel DB + live filesystem scan)
- **Tags** — tag files and folders, filter by tag inside a workspace; save filter combinations as views
- **Tag rules** — auto-tag files by extension, name, path, or size; rules apply automatically on every folder navigation
- **Search** — full-text SQLite search combined with a live parallel filesystem scan for instant results
- **Disk usage** — visual breakdown of folder sizes (heavy dirs excluded, runs in background thread)
- **Shared workspaces** — host your workspace over a local or remote network; guests can browse, edit, create, and delete files in real time; granular per-path permissions (list, read, create, edit, delete); supports copy/paste and drag & drop across local and remote tabs
- **Frameless window** — custom titlebar with native window controls
- **i18n** — English and French UI, switchable in Settings

## Tech stack

| Layer | Technology |
|---|---|
| UI | React 18 + TypeScript + Tailwind CSS |
| State | Zustand |
| Editor | CodeMirror 6 |
| Desktop shell | Tauri 2 |
| Backend | Rust (tokio, tokio-tungstenite, rusqlite) |
| Database | SQLite (bundled via rusqlite) |

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) stable (1.77+)
- Tauri prerequisites for Windows: [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) + MSVC build tools

### Development

```bash
npm install
npm run tauri dev
```

### Production build

```bash
npm run tauri build
```

The installer is output to `src-tauri/target/release/bundle/`.

## Project structure

```
src/                    React frontend
  components/           UI components
    ArchiveViewer.tsx   Built-in archive browser (ZIP/TAR/TAR.GZ)
    CommandPalette.tsx  Ctrl+P launcher with recent files, searches, fuzzy search
    DiskUsageModal.tsx  Folder size breakdown
    FolderPickerModal.tsx In-app destination folder picker
    TrashModal.tsx      Trash bin browser with restore
  store/useStore.ts     Zustand global state
  utils/i18n.ts         Translation system (en / fr)
  utils/settings.ts     App settings (theme, accent, editor, snapshots…)
  types/                Shared TypeScript types
  views/                Page-level views
src-tauri/
  src/
    commands/           Tauri commands exposed to the frontend
      archive.rs        ZIP/TAR listing, extraction, ZIP creation
      files.rs          Directory listing, file I/O, activity recording
      search.rs         SQLite FTS + live filesystem search (search_live)
      stats.rs          Disk usage (spawn_blocking, SKIP_DIRS)
      trash.rs          Trash CRUD (move, list, restore, delete, empty)
      snapshots.rs      Snapshot CRUD (create, list, restore, delete, diff)
      permissions.rs    Share permission CRUD
      context.rs        Workspace + activity feed commands
      winintegration.rs Windows shell extension (HKCU registry) + --path CLI arg
    sharing/            P2P workspace sharing (WebSocket server + client)
    db.rs               SQLite schema + migrations
    models.rs           Rust data models
    lib.rs              App entry point + command registration
```

## Snapshots

Open any file in the editor, then click the **clock icon** (History) in the top-right of the editor header.

| Setting | Default | Range |
|---|---|---|
| Mode | Auto (on every save) | Auto / Manual |
| Max snapshots per file | 10 | 2 – 50 |

Text files show a line-by-line diff view (removed in red, added in green, unchanged sections collapsed). Binary files (images, spreadsheets, PDFs) show a restore-only panel.

## Archive manager

Click any `.zip`, `.tar`, `.tar.gz`, or `.tgz` file to open it in the built-in viewer. Navigate into folders, view sizes and compression ratios, and extract via:

- **Extract here** — extracts to a new folder in the same directory, named after the archive
- **Extract to…** — opens the in-app folder picker to choose a destination

Right-click any file or selection in the file list to **Compress to ZIP** with a custom archive name.

## Trash

- **Del** — moves selected files/folders to the trash (recoverable)
- **Shift+Del** — permanently deletes with a confirmation dialog
- **Sidebar → Trash** — browse all trashed items, restore to original location, delete permanently, or empty the bin

## Shared workspaces

The host starts sharing from the sidebar — the app binds a WebSocket server on a random port. Guests enter the `IP:PORT` code and an 8-character password. All file operations are routed through the WebSocket with per-path access control enforced server-side.

### Guest permissions

| Permission | Covers |
|---|---|
| List | Browse directory contents |
| Read | Open and read files |
| Create | Create new files and folders |
| Edit | Save changes to existing files, rename |
| Delete | Delete files and folders |

## Roadmap

### Search & Discovery
- [x] **Command palette** — recent files, recent searches, parallel DB + live filesystem search
- [ ] **Full-text search inside files** — index file contents (text, code, PDF text layer) with instant results
- [ ] **Search operators** — `tag:Code size:>1MB modified:7d`, regex, exclude patterns
- [ ] **Global search palette** — Ctrl+Shift+F across all workspaces simultaneously

### Cloud & Sync
- [ ] **Workspace sync** — sync metadata, tags, and saved views across machines
- [x] **Guest permissions** — granular per-path permissions (list, read, create, edit, delete)
- [ ] **Export / import workspace** — portable bundle preserving folder structure, tags, pinned items, rules

### File History
- [x] **Snapshots** — lightweight file-level history; restore any tracked file to a previous state
- [x] **Snapshot diff view** — line-by-line diff for text files; restore-only for binary files
- [x] **Activity feed** — per-file timeline with timestamps
- [x] **Binary snapshots** — images, spreadsheets, and PDFs supported (restore without diff)
- [x] **Trash with restore** — soft-delete into a recoverable bin; restore to original location

### Viewer & Editor Improvements
- [x] **Multi-page PDF preview** — scrollable canvas render with page navigation and zoom
- [x] **Office file preview** — `.docx` rendered inline; `.xlsx`, `.xls`, `.ods`, `.csv` as spreadsheet table
- [x] **CSV inline editor** — edit cells in table view, Tab/Enter navigation, one-click save
- [x] **Archive manager** — browse ZIP/TAR/TAR.GZ with virtual folder navigation and extraction
- [x] **Quick Look** — Space bar instant preview panel without opening the full editor
- [ ] **Image tools** — rotation, crop, EXIF metadata panel, slideshow mode
- [ ] **Hex viewer** — for binary files instead of "cannot edit" screen
- [ ] **Diff view** — compare two selected files side-by-side

### UX & Polish
- [x] **Rubber-band selection** — click-drag on empty space to select multiple entries
- [x] **External drag-and-drop** — drag files from nxs to Explorer, browser, or any Windows app
- [x] **Windows shell integration** — "Open with nxs" in File Explorer context menu
- [x] **Tab bar scroll** — mouse-wheel scroll and chevron buttons when tabs overflow
- [x] **Image gallery navigation** — arrow keys cycle through images in the current folder tab
- [x] **Multi-window** — open any file or folder in a new independent window
- [x] **Image thumbnails in grid view** — actual previews with lazy loading
- [x] **Status bar** — item count; selection count + cumulative size when items selected
- [x] **Editable path bar** — click the breadcrumb to type a path directly
- [x] **i18n** — English and French fully covered; all UI strings go through the translation system
- [ ] **Onboarding wizard** — guided first-run creating a workspace and explaining tags
- [ ] **Keyboard shortcut panel** — `?` key opens a reference overlay
- [ ] **Customizable columns** — show/hide and reorder columns in list view

### Monetization & Distribution
- [ ] **License key system** — offline activation with server-validated license
- [ ] **Auto-updater** — in-app update prompt via Tauri updater plugin
- [ ] **Telemetry opt-in** — anonymous usage stats to guide feature prioritization

## License

Private — all rights reserved.
