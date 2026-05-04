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
- **Tags** — tag files and folders, filter by tag inside a workspace; save filter combinations as views
- **Tag rules** — auto-tag files by extension, name, path, or size; rules apply automatically on every folder navigation
- **Search** — full-text search across workspace paths
- **Shared workspaces** — host your workspace over a local or remote network; guests can browse, edit, create, and delete files in real time. Supports copy/paste and drag & drop across local and remote tabs.
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
  types/              Shared TypeScript types
  views/              Page-level views
src-tauri/
  src/
    commands/         Tauri commands exposed to the frontend
    sharing/          P2P workspace sharing (WebSocket server + client)
    db.rs             SQLite schema + migrations
    models.rs         Rust data models
    lib.rs            App entry point + command registration
```

## Shared workspaces

The host starts sharing from the sidebar — the app binds a WebSocket server on a random port and discovers its public IP via STUN (no relay server needed). Guests enter the `IP:PORT` code and an 8-character password. All file operations are routed through the WebSocket with per-path access control enforced server-side.

## Roadmap

Features planned to increase product value and justify purchase pricing.

### Search & Discovery
- [ ] **Full-text search inside files** — index file contents (text, code, PDF text layer) with instant results, like Everything + content search. The biggest gap vs. free alternatives.
- [ ] **Search operators** — `tag:Code size:>1MB modified:7d`, regex, exclude patterns
- [ ] **Global search palette** — Ctrl+Shift+F opens a full-screen search across all workspaces simultaneously

### Cloud & Sync
- [ ] **Workspace sync** — sync metadata, tags, and saved views across machines via an optional cloud backend (tags follow files across devices)
- [ ] **Owners rules** - possibility to choose for the owner if other users can see/update/create/delete files 
- [ ] **Export / import workspace** — portable `.cwsp` bundle that preserves folder structure, tags, pinned items, and rules
- [ ] **Conflict resolution UI** — when the same file is edited on two machines, show a diff and let the user pick

### File History
- [ ] **Snapshots** — lightweight file-level history without Git; restore any tracked file to a previous state
- [ ] **Activity feed** — per-file timeline showing open, edit, delete, rename events with timestamps
- [ ] **Trash with restore** — soft-delete files into a workspace trash before permanent deletion

### Viewer & Editor Improvements
- [ ] **Multi-page PDF preview** — scrollable render with page navigation, no external app needed
- [ ] **Office file preview** — `.docx`, `.xlsx`, `.pptx` rendered without Microsoft Office
- [ ] **Image tools** — rotation, crop, EXIF metadata panel, slideshow mode
- [ ] **Hex viewer** — for binary files (`.exe`, `.dll`, etc.) instead of "cannot edit" screen
- [ ] **Diff view** — compare two selected files side-by-side

### UX & Polish
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
