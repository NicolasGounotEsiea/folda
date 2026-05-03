# Changelog

## [0.1.0] — 2026-05-04

Initial public release.

### Features

**File explorer**
- Multi-tab folder browsing with persistent tab state per workspace
- List view with name, size, date, and extension columns
- Status bar showing item count, folder/file breakdown, and selection count
- Context menu: open, rename, duplicate, copy/paste, delete, pin
- Bulk rename
- Drag & drop between tabs (local and remote)
- Image viewer with keyboard navigation (← → between images in folder)

**Editor**
- Syntax-highlighted editor (CodeMirror 6) for text, code, and Markdown
- DOCX preview
- Hex viewer fallback for binary files

**Workspaces**
- Multiple named workspaces with custom icons
- Per-workspace folder roots, pinned paths, tag filters, and open tabs restored on switch
- Global mode (no workspace) for quick browsing

**Tags**
- Tag files and folders with custom name and color
- Filter file list by one or more tags
- Saved filter views (bookmark a tag combination)
- **Tag rules** — automatically tag files by extension, name, path substring, or file size; rules run on every folder navigation with no manual step

**Search**
- Full-text filename search across workspace paths

**Shared workspaces**
- Host a workspace over LAN or internet via WebSocket; guests browse, edit, create, and delete files in real time
- Per-path access control enforced server-side
- Copy/paste and drag & drop across local and remote tabs
- Guest discovery via `IP:PORT` + 8-character password (no relay server needed)

**Shell**
- Frameless window with custom titlebar and native window controls (minimize, maximize, close)
- Workspace state (last path, open tabs, active filters) saved on close and restored on next launch
