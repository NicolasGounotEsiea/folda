# Contextual Workspace

A local-first file manager for Windows built with Tauri 2 + React + Rust.

## Features

- **Multi-workspace** — organize folders into named workspaces with icons, tags, and pinned paths
- **File explorer** — multi-tab browsing, context menus, bulk rename, drag & drop
- **Editor** — syntax-highlighted editor (CodeMirror) for text, code, Markdown, and DOCX preview
- **Tags** — tag files and folders, filter by tag inside a workspace
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

## License

Private — all rights reserved.
