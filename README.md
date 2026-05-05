# Contextual Workspace

[![CI](https://github.com/NicolasGounotEsiea/folda/actions/workflows/ci.yml/badge.svg)](https://github.com/NicolasGounotEsiea/folda/actions/workflows/ci.yml)
[![Release](https://github.com/NicolasGounotEsiea/folda/actions/workflows/release.yml/badge.svg)](https://github.com/NicolasGounotEsiea/folda/releases)
[![License: Proprietary](https://img.shields.io/badge/license-proprietary-red.svg)](#license)

A local-first file manager for Windows built with Tauri 2 + React + Rust.

## Download

Grab the latest installer from the [Releases](https://github.com/NicolasGounotEsiea/folda/releases) page.  
Two formats are available: **NSIS `.exe`** (recommended) and **MSI `.msi`**.

## Features

- **Multi-workspace** — organize folders into named workspaces with icons, tags, and pinned paths
- **File explorer** — multi-tab browsing, context menus, bulk rename, drag & drop
- **Editor** — syntax-highlighted editor (CodeMirror) for text, code, Markdown, and DOCX preview
- **Snapshots** — lightweight per-file version history stored in SQLite; auto mode (snapshot on every save) or manual mode; configurable max count (2–50); click any snapshot to open a diff view showing exactly what changed (added/removed lines highlighted), with one-click restore
- **Activity feed** — per-file history tab in the preview panel showing open, edit, rename, and delete events with timestamps
- **Tags** — tag files and folders, filter by tag inside a workspace; save filter combinations as views
- **Tag rules** — auto-tag files by extension, name, path, or size; rules apply automatically on every folder navigation
- **Search** — full-text search across workspace paths
- **Shared workspaces** — host your workspace over a local or remote network; guests can browse, edit, create, and delete files in real time; granular per-path permissions (list, read, create, edit, delete) configurable per workspace; supports copy/paste and drag & drop across local and remote tabs
- **Frameless window** — custom titlebar with native window controls

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
src/                  React frontend
  components/         UI components
  store/useStore.ts   Zustand global state
  utils/settings.ts   App settings (theme, accent, editor, snapshots…)
  types/              Shared TypeScript types
  views/              Page-level views
src-tauri/
  src/
    commands/         Tauri commands exposed to the frontend
      snapshots.rs    Snapshot CRUD (create, list, restore, delete, diff)
      permissions.rs  Share permission CRUD (per-workspace, per-path)
      context.rs      Workspace + activity feed commands
    sharing/          P2P workspace sharing (WebSocket server + client)
    db.rs             SQLite schema + migrations
    models.rs         Rust data models
    lib.rs            App entry point + command registration
```

## Snapshots

Open any file in the editor, then click the **clock icon** (History) in the top-right of the editor header.

| Setting | Default | Range |
|---|---|---|
| Mode | Auto (on every save) | Auto / Manual |
| Max snapshots per file | 10 | 2 – 50 |
| Max file size tracked | 1 MB | — |

Clicking a snapshot in the panel opens a **diff modal**: removed lines (present in snapshot, gone today) are shown in red; added lines (new since that snapshot) in green. Unchanged sections are collapsed. Restore is available directly from the modal.

## Shared workspaces

The host starts sharing from the sidebar — the app binds a WebSocket server on a random port and discovers its public IP via STUN (no relay server needed). Guests enter the `IP:PORT` code and an 8-character password. All file operations are routed through the WebSocket with per-path access control enforced server-side.

### Guest permissions

While hosting, expand **Permissions invités** in the Share modal to configure what guests can do:

| Permission | Covers |
|---|---|
| List | Browse directory contents |
| Read | Open and read files |
| Create | Create new files and folders |
| Edit | Save changes to existing files, rename |
| Delete | Delete files and folders |

A workspace-wide default applies everywhere. Add path overrides to grant narrower or broader access to specific folders or files (longest-prefix match wins).

## Roadmap

Features planned to increase product value and justify purchase pricing.

### Search & Discovery
- [ ] **Full-text search inside files** — index file contents (text, code, PDF text layer) with instant results, like Everything + content search. The biggest gap vs. free alternatives.
- [ ] **Search operators** — `tag:Code size:>1MB modified:7d`, regex, exclude patterns
- [ ] **Global search palette** — Ctrl+Shift+F opens a full-screen search across all workspaces simultaneously

### Cloud & Sync
- [ ] **Workspace sync** — sync metadata, tags, and saved views across machines via an optional cloud backend (tags follow files across devices)
- [ ] **Owners rules / permissions** — possibility to choose for the owner if other users can see/update/create/delete files
- [ ] **Export / import workspace** — portable `.cwsp` bundle that preserves folder structure, tags, pinned items, and rules
- [ ] **Conflict resolution UI** — when the same file is edited on two machines, show a diff and let the user pick

### File History
- [x] **Snapshots** — lightweight file-level history without Git; restore any tracked file to a previous state
- [x] **Snapshot diff view** — click any snapshot to see a line-by-line diff against the current file
- [x] **Activity feed** — per-file timeline showing open, edit, delete, rename events with timestamps
- [ ] **Snapshots for binary formats** — extend snapshot support to images, spreadsheets, and office documents (restore without diff)
- [ ] **Trash with restore** — soft-delete files into a workspace trash before permanent deletion

### Viewer & Editor Improvements
- [x] **Multi-page PDF preview** — scrollable canvas render with page navigation and zoom, no external app needed
- [x] **Office file preview** — `.docx` rendered inline; `.xlsx`, `.xls`, `.ods`, `.csv` rendered as a spreadsheet table
- [x] **CSV inline editor** — edit cells directly in the table view (no raw text), Tab/Enter navigation, one-click save
- [x] **Virtual scrolling for large files** — spreadsheet viewer renders only visible rows; supports up to 50 000 rows without lag
- [ ] **Spreadsheet / CSV snapshots** — extend the snapshot panel to CSV and Excel files
- [ ] **Image tools** — rotation, crop, EXIF metadata panel, slideshow mode
- [ ] **Hex viewer** — for binary files (`.exe`, `.dll`, etc.) instead of "cannot edit" screen
- [ ] **Diff view** — compare two selected files side-by-side

### UX & Polish
- [x] **Tab bar scroll** — mouse-wheel scroll and chevron buttons when tabs overflow the bar
- [x] **Image gallery navigation** — arrow keys cycle through images in the current tab without opening new tabs
- [ ] **Onboarding wizard** — guided first-run that creates a workspace, explains tags, shows keyboard shortcuts
- [ ] **Keyboard shortcut panel** — `?` key opens a reference overlay
- [ ] **Command palette improvements** — tag assignment, workspace switch, open recent files via Ctrl+K
- [ ] **Customizable columns** — show/hide and reorder columns in list view (owner, permissions, custom metadata)
- [ ] **Tab groups** — color-coded groups for folder tabs, saved as part of workspace state

### Monetization & Distribution
- [ ] **License key system** — offline activation with a server-validated license
- [ ] **Auto-updater** — in-app update prompt via Tauri updater plugin
- [ ] **Telemetry opt-in** — anonymous usage stats to guide feature prioritization

## License

Private — all rights reserved.
