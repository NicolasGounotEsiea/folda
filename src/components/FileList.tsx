import { invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import {
  ArrowDown, ArrowUp, ChevronUp,
  Code, File, FileImage, FileText, Film, Folder, FolderPlus, Music, Package,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { useStore } from "../store/useStore";
import type { FileEntry, ListEntry } from "../types";
import { useTranslation } from "../utils/i18n";

// ─── Cross-transfer helpers ───────────────────────────────────────────────────

type TransferEntry = { path: string; name: string; is_dir: boolean };

async function downloadEntry(entry: TransferEntry, localDestDir: string): Promise<void> {
  const sep = localDestDir.includes("\\") ? "\\" : "/";
  const dest = localDestDir.replace(/[/\\]$/, "") + sep + entry.name;
  if (entry.is_dir) {
    await invoke("create_directory", { path: dest });
    const children = await invoke<ListEntry[]>("list_remote_dir", { path: entry.path });
    for (const child of children) {
      await downloadEntry({ path: child.path, name: child.name, is_dir: child.is_dir }, dest);
    }
  } else {
    const content = await invoke<string>("read_remote_file", { path: entry.path });
    await invoke("write_file", { path: dest, content });
  }
}

async function uploadEntry(entry: TransferEntry, remoteDestDir: string): Promise<void> {
  const dest = remoteDestDir.replace(/[/\\]$/, "") + "/" + entry.name;
  if (entry.is_dir) {
    await invoke("create_remote_dir", { path: dest });
    const children = await invoke<ListEntry[]>("list_directory", { path: entry.path });
    for (const child of children) {
      await uploadEntry({ path: child.path, name: child.name, is_dir: child.is_dir }, dest);
    }
  } else {
    const content = await invoke<string>("read_file_full", { path: entry.path });
    await invoke("write_remote_file", { path: dest, content });
  }
}

// Remote→remote copy (read content and write to new path)
async function uploadRemoteEntry(entry: TransferEntry, remoteDestDir: string): Promise<void> {
  const dest = remoteDestDir.replace(/[/\\]$/, "") + "/" + entry.name;
  if (entry.is_dir) {
    await invoke("create_remote_dir", { path: dest });
    const children = await invoke<ListEntry[]>("list_remote_dir", { path: entry.path });
    for (const child of children) {
      await uploadRemoteEntry({ path: child.path, name: child.name, is_dir: child.is_dir }, dest);
    }
  } else {
    const content = await invoke<string>("read_remote_file", { path: entry.path });
    await invoke("write_remote_file", { path: dest, content });
  }
}

function toFileEntry(e: ListEntry): FileEntry {
  return {
    id: e.id ?? -1, path: e.path, name: e.name, extension: e.extension,
    size: e.size, created_at: e.created_at, modified_at: e.modified_at, accessed_at: 0, tags: e.tags,
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDate(unixSecs: number): string {
  if (!unixSecs) return "—";
  return new Date(unixSecs * 1000).toLocaleDateString(undefined, {
    day: "numeric", month: "short", year: "numeric",
  });
}

function FileIcon({ entry }: { entry: ListEntry }) {
  if (entry.is_dir) return <Folder size={15} className="shrink-0 text-yellow-400" />;
  const e = entry.extension.toLowerCase();
  if (["png","jpg","jpeg","gif","webp","svg","ico","bmp","avif"].includes(e)) return <FileImage size={15} className="shrink-0 text-pink-400" />;
  if (["mp4","mkv","avi","mov","webm"].includes(e)) return <Film size={15} className="shrink-0 text-purple-400" />;
  if (["mp3","wav","flac","ogg","m4a"].includes(e)) return <Music size={15} className="shrink-0 text-cyan-400" />;
  if (["ts","tsx","js","jsx","rs","py","go","java","c","cpp","h","css","html","json","toml","yaml","sh"].includes(e)) return <Code size={15} className="shrink-0 text-green-400" />;
  if (["pdf","doc","docx","txt","md","rtf"].includes(e)) return <FileText size={15} className="shrink-0 text-blue-400" />;
  if (["zip","tar","gz","7z","rar"].includes(e)) return <Package size={15} className="shrink-0 text-orange-400" />;
  return <File size={15} className="shrink-0 text-text-muted" />;
}

// ─── Sort header ───────────────────────────────────────────────────────────────
function SortHeader({ col, label, width, sortBy, sortDir, onSort }: {
  col: "name" | "size" | "modified" | "type";
  label: string;
  width?: string;
  sortBy: string;
  sortDir: "asc" | "desc";
  onSort: (col: "name" | "size" | "modified" | "type") => void;
}) {
  const active = sortBy === col;
  return (
    <button
      onClick={() => onSort(col)}
      className={clsx(
        "flex items-center gap-1 text-[10px] uppercase tracking-wide transition-colors",
        width,
        active ? "text-accent" : "text-text-muted hover:text-text-secondary"
      )}
    >
      {label}
      {active && (sortDir === "asc" ? <ArrowUp size={9} /> : <ArrowDown size={9} />)}
    </button>
  );
}

// Shared grid template: icon | name | size | modified | actions
const ROW_GRID = "grid items-center gap-x-3 px-4" as const;
const ROW_COLS = { gridTemplateColumns: "15px 1fr 64px 96px 42px" } as const;

// ─── Entry row ────────────────────────────────────────────────────────────────
function EntryRow({
  entry, selected, cut,
  onClick, onDoubleClick, onNavigate, onContextMenu,
  renaming, onRenameSubmit, onRenameCancel,
  isDragTarget, onMouseDown, onMouseEnter, onMouseLeave,
}: {
  entry: ListEntry;
  selected: boolean;
  cut: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onNavigate: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: ListEntry) => void;
  renaming: boolean;
  onRenameSubmit: (name: string) => void;
  onRenameCancel: () => void;
  isDragTarget?: boolean;
  onMouseDown?: (e: React.MouseEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const [renameVal, setRenameVal] = useState(entry.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) {
      setRenameVal(entry.name);
      setTimeout(() => {
        inputRef.current?.focus();
        const dot = entry.name.lastIndexOf(".");
        inputRef.current?.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
      }, 10);
    }
  }, [renaming, entry.name]);

  return (
    <div
      data-is-entry="true"
      style={ROW_COLS}
      onContextMenu={(e) => onContextMenu(e, entry)}
      onClick={renaming ? undefined : onClick}
      onDoubleClick={renaming ? undefined : () => entry.is_dir ? onNavigate(entry.path) : onDoubleClick()}
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={clsx(
        ROW_GRID,
        "w-full h-9 transition-colors group cursor-pointer select-none",
        isDragTarget
          ? "ring-1 ring-inset ring-accent bg-accent/15 text-text-primary"
          : selected
          ? "bg-accent/10 text-text-primary"
          : "hover:bg-surface-2 text-text-secondary hover:text-text-primary",
        cut && "opacity-40"
      )}
    >
      {/* col 1: icon */}
      <FileIcon entry={entry} />

      {/* col 2: name (spans remaining cols when renaming) */}
      {renaming ? (
        <input
          ref={inputRef}
          value={renameVal}
          onChange={(e) => setRenameVal(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") onRenameSubmit(renameVal);
            if (e.key === "Escape") onRenameCancel();
          }}
          onBlur={() => onRenameSubmit(renameVal)}
          onClick={(e) => e.stopPropagation()}
          style={{ gridColumn: "2 / -1" }}
          className="bg-surface-3 border border-accent rounded px-1 text-[12px] text-text-primary outline-none"
        />
      ) : (
        <>
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="truncate text-[12px]">{entry.name}</span>
            {entry.tags.length > 0 && (
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                {entry.tags.slice(0, 2).map((t) => (
                  <span key={t.id} className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                    style={{ background: t.color + "33", color: t.color }}>{t.name}</span>
                ))}
              </div>
            )}
          </div>
          {/* col 3: size */}
          <span className="text-[11px] text-text-muted text-right">
            {entry.is_dir
              ? `${entry.size} item${entry.size !== 1 ? "s" : ""}`
              : formatSize(entry.size)}
          </span>
          {/* col 4: modified */}
          <span className="text-[11px] text-text-muted text-right">
            {formatDate(entry.modified_at)}
          </span>
          {/* col 5: empty (mirrors header actions column) */}
          <span />
        </>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export function FileList() {
  const {
    listEntries, selectEntry, layoutMode,
    pinnedItems, addPinnedItem, removePinnedItem,
    setBulkRenameOpen,
    selectedTagIds, isScanning, setCurrentPath, setListEntries, rootPaths,
    openFile, openFolderTab, currentPath, pushNav,
    selectedPaths, setSelectedPaths,
    clipboard, setClipboard,
    sortBy, sortDir, setSortBy,
    showHidden,
    folderTabs, activeFolderTabId,
    activeContextId,
  } = useStore();

  const t = useTranslation();

  // Per-tab remote: check the ACTIVE folder tab, not global sharing mode
  const activeTab = folderTabs.find((t) => t.id === activeFolderTabId);
  const isCurrentTabRemote = activeTab?.isRemote ?? false;

  // Refs so global handlers (inside empty-dep useEffect) always see fresh values
  const isRemoteRef = useRef(isCurrentTabRemote);
  useEffect(() => { isRemoteRef.current = isCurrentTabRemote; });
  const listEntriesRef = useRef(listEntries);
  useEffect(() => { listEntriesRef.current = listEntries; });

  // Always-current list helper (used in callbacks and effects)
  const listDirRef = useRef((_path: string): Promise<ListEntry[]> => Promise.resolve([]));
  useEffect(() => {
    listDirRef.current = (path: string) =>
      isCurrentTabRemote
        ? invoke<ListEntry[]>("list_remote_dir", { path })
        : invoke<ListEntry[]>("list_directory", { path, contextId: activeContextId ?? 0 });
  });
  const listDir = (path: string) => listDirRef.current(path);

  // ─── Drag state (mouse-event based, avoids WebView2 HTML5 DnD issues) ───────
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number; label: string } | null>(null);
  const dragRef = useRef<{
    pending: { startX: number; startY: number; paths: string[]; label: string } | null;
    active: boolean;
    paths: string[];
    dropTarget: string | null;
    sourceIsRemote: boolean;
    dropTargetIsRemote: boolean;
  }>({ pending: null, active: false, paths: [], dropTarget: null, sourceIsRemote: false, dropTargetIsRemote: false });
  const didDragRef = useRef(false);

  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [showNewFile, setShowNewFile] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const newFolderRef = useRef<HTMLInputElement>(null);
  const newFileRef = useRef<HTMLInputElement>(null);

  // Context menu
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entry: ListEntry } | null>(null);
  const [emptyCtxMenu, setEmptyCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // Delete confirmation
  const [deleteTargets, setDeleteTargets] = useState<ListEntry[] | null>(null);
  // Inline rename
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  // ─── Derived: parent path for ".." row ─────────────────────────────────────
  const parentPath = useMemo(() => {
    if (!currentPath) return null;
    const norm = currentPath.replace(/\\/g, "/");
    if (rootPaths.some((r) => r.replace(/\\/g, "/") === norm)) return null;
    const parts = norm.split("/");
    return parts.length <= 1 ? null : parts.slice(0, -1).join("/");
  }, [currentPath, rootPaths]);

  // ─── Filtered + sorted entries ─────────────────────────────────────────────
  const visibleEntries = useMemo(() => {
    let entries = listEntries;
    if (!showHidden) entries = entries.filter((e) => !e.name.startsWith("."));
    if (selectedTagIds.length > 0)
      entries = entries.filter((e) => e.is_dir || selectedTagIds.every((tid) => e.tags.some((t) => t.id === tid)));

    return [...entries].sort((a, b) => {
      // Dirs always first
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      let cmp = 0;
      if (sortBy === "name") cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      else if (sortBy === "size") cmp = a.size - b.size;
      else if (sortBy === "modified") cmp = a.modified_at - b.modified_at;
      else if (sortBy === "type") cmp = a.extension.localeCompare(b.extension);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [listEntries, showHidden, selectedTagIds, sortBy, sortDir]);

  // ─── Helpers ───────────────────────────────────────────────────────────────
  const refreshList = useCallback(async (path?: string) => {
    const target = path ?? currentPath;
    if (!target) return;
    try {
      const entries = await listDirRef.current(target);
      setListEntries(entries);
    } catch (e) { console.error(e); }
  }, [currentPath, setListEntries]);

  // Stable ref so the drag mouseup handler (empty-dep useEffect) can call it
  const refreshListRef = useRef(refreshList);
  useEffect(() => { refreshListRef.current = refreshList; }, [refreshList]);

  const navigate = async (path: string) => {
    setCurrentPath(path);
    pushNav(path);
    try {
      const entries = await listDir(path);
      setListEntries(entries);
      selectEntry(null);
      setSelectedPaths([]);
    } catch (e) { console.error("navigate error:", e); }
  };

  // Global mouse handlers for drag-and-drop (run once — all state via refs)
  useEffect(() => {
    const THRESHOLD = 6;
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (d.pending && !d.active) {
        const dx = ev.clientX - d.pending.startX;
        const dy = ev.clientY - d.pending.startY;
        if (Math.sqrt(dx * dx + dy * dy) > THRESHOLD) {
          d.active = true;
          const { paths, label } = d.pending;
          d.paths = paths;
          d.pending = null;
          setGhostPos({ x: ev.clientX, y: ev.clientY, label });
        }
      } else if (d.active) {
        setGhostPos((p) => p ? { ...p, x: ev.clientX, y: ev.clientY } : null);
      }
    };
    const onUp = async () => {
      const d = dragRef.current;
      d.pending = null;
      if (d.active) {
        d.active = false;
        didDragRef.current = true;
        setGhostPos(null);
        const target = d.dropTarget;
        const paths = [...d.paths];
        const srcRemote = d.sourceIsRemote;
        const dstRemote = d.dropTargetIsRemote;
        d.dropTarget = null;
        d.paths = [];
        d.sourceIsRemote = false;
        d.dropTargetIsRemote = false;
        setDropTarget(null);

        if (target && paths.length > 0) {
          const entries = listEntriesRef.current;
          if (srcRemote === dstRemote) {
            // Same-side move
            for (const src of paths) {
              if (src === target) continue;
              try {
                if (srcRemote) {
                  const name = src.replace(/\\/g, "/").split("/").pop()!;
                  await invoke("rename_remote_path", { fromPath: src, toPath: target.replace(/\\/g, "/") + "/" + name });
                } else {
                  await invoke("move_path", { src, dstDir: target });
                }
              } catch (err) { console.error(err); }
            }
          } else {
            // Cross-transfer (always copy — don't delete source during DnD)
            for (const src of paths) {
              const entry = entries.find((e) => e.path === src)
                ?? { path: src, name: src.replace(/\\/g, "/").split("/").pop()!, is_dir: false };
              try {
                if (srcRemote) {
                  await downloadEntry({ path: entry.path, name: entry.name, is_dir: entry.is_dir }, target);
                } else {
                  await uploadEntry({ path: entry.path, name: entry.name, is_dir: entry.is_dir }, target);
                }
              } catch (err) { console.error(err); }
            }
          }
          setSelectedPaths([]);
          await refreshListRef.current();
        }
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startDrag = (ev: React.MouseEvent, entry: ListEntry) => {
    if (ev.button !== 0 || renamingPath === entry.path) return;
    const paths = selectedPaths.includes(entry.path) ? [...selectedPaths] : [entry.path];
    const label = paths.length === 1 ? entry.name : `${paths.length} éléments`;
    dragRef.current.pending = { startX: ev.clientX, startY: ev.clientY, paths, label };
    dragRef.current.sourceIsRemote = isCurrentTabRemote; // capture source tab remoteness
  };

  const handleDragEnter = (entry: ListEntry) => {
    const d = dragRef.current;
    if (!d.active || !entry.is_dir || d.paths.includes(entry.path)) return;
    d.dropTarget = entry.path;
    d.dropTargetIsRemote = isCurrentTabRemote; // capture target tab remoteness
    setDropTarget(entry.path);
  };

  const handleDragLeave = (entry: ListEntry) => {
    if (dragRef.current.dropTarget === entry.path) {
      dragRef.current.dropTarget = null;
      setDropTarget(null);
    }
  };

  const handleOpen = (e: ListEntry) => openFile(toFileEntry(e));

  const handleOpenFolderInNewTab = async (path: string) => {
    openFolderTab(path);
    try {
      const entries = await listDir(path);
      setListEntries(entries);
      selectEntry(null);
      setSelectedPaths([]);
    } catch (e) { console.error(e); }
  };

  // ─── Click handlers ─────────────────────────────────────────────────────────
  const handleClick = (e: React.MouseEvent, entry: ListEntry) => {
    if (didDragRef.current) { didDragRef.current = false; return; }
    const path = entry.path;
    if (e.ctrlKey || e.metaKey) {
      setSelectedPaths(
        selectedPaths.includes(path)
          ? selectedPaths.filter((p) => p !== path)
          : [...selectedPaths, path]
      );
    } else if (e.shiftKey && selectedPaths.length > 0) {
      const lastPath = selectedPaths[selectedPaths.length - 1];
      const lastIdx = visibleEntries.findIndex((x) => x.path === lastPath);
      const curIdx = visibleEntries.findIndex((x) => x.path === path);
      if (lastIdx >= 0 && curIdx >= 0) {
        const [from, to] = lastIdx < curIdx ? [lastIdx, curIdx] : [curIdx, lastIdx];
        setSelectedPaths(visibleEntries.slice(from, to + 1).map((x) => x.path));
      }
    } else {
      setSelectedPaths([path]);
      if (entry.is_dir) selectEntry({ kind: "folder", entry });
      else selectEntry({ kind: "file", entry: toFileEntry(entry) });
    }
  };

  // ─── Context menu builder ───────────────────────────────────────────────────
  const handleContextMenu = (e: React.MouseEvent, entry: ListEntry) => {
    e.preventDefault();
    if (!selectedPaths.includes(entry.path)) {
      setSelectedPaths([entry.path]);
      if (entry.is_dir) selectEntry({ kind: "folder", entry });
      else selectEntry({ kind: "file", entry: toFileEntry(entry) });
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, entry });
  };

  const buildMenuItems = (entry: ListEntry): ContextMenuEntry[] => {
    const isMulti = selectedPaths.length > 1;
    const targets = isMulti
      ? visibleEntries.filter((x) => selectedPaths.includes(x.path))
      : [entry];

    const items: ContextMenuEntry[] = [];

    if (!isMulti) {
      if (!entry.is_dir) {
        items.push({ label: "Open with system", onClick: () => invoke("open_with_default", { path: entry.path }) });
        items.push({ label: "Open in editor", onClick: () => handleOpen(entry) });
      } else {
        items.push({ label: "Open folder", onClick: () => navigate(entry.path) });
        items.push({ label: "Open in new tab", onClick: () => handleOpenFolderInNewTab(entry.path) });
      }
      items.push({ separator: true });
      items.push({ label: "Rename", shortcut: "F2", onClick: () => setRenamingPath(entry.path) });
      if (!entry.is_dir)
        items.push({ label: "Duplicate", onClick: () => handleDuplicate(entry) });
      items.push({ separator: true });
    }

    const clipEntries = targets.map((t) => ({ path: t.path, name: t.name, is_dir: t.is_dir }));
    items.push({ label: isMulti ? `Copy (${targets.length})` : "Copy", shortcut: "Ctrl+C", onClick: () => setClipboard({ action: "copy", paths: targets.map((t) => t.path), isRemote: isCurrentTabRemote, entries: clipEntries }) });
    items.push({ label: isMulti ? `Cut (${targets.length})` : "Cut", shortcut: "Ctrl+X", onClick: () => setClipboard({ action: "cut", paths: targets.map((t) => t.path), isRemote: isCurrentTabRemote, entries: clipEntries }) });
    if (clipboard) items.push({ label: "Paste", shortcut: "Ctrl+V", onClick: handlePaste });
    items.push({ separator: true });

    if (!isMulti) {
      items.push({ label: "Copy path", onClick: () => navigator.clipboard.writeText(entry.path) });
      items.push({ label: "Reveal in Explorer", onClick: () => invoke("reveal_in_explorer", { path: entry.path }) });
      const ctxId = activeContextId ?? 0;
      const isPinned = pinnedItems.some((p) => p.path === entry.path && p.context_id === ctxId);
      items.push({
        label: isPinned ? "Unpin from sidebar" : "Pin to sidebar",
        onClick: async () => {
          if (isPinned) {
            await invoke("unpin_item", { path: entry.path, contextId: ctxId });
            removePinnedItem(entry.path);
          } else {
            await invoke("pin_item", { path: entry.path, name: entry.name, isDir: entry.is_dir, contextId: ctxId });
            addPinnedItem({ id: Date.now(), path: entry.path, name: entry.name, is_dir: entry.is_dir, context_id: ctxId });
          }
        },
      });
      items.push({ separator: true });
    }

    if (isMulti && selectedPaths.length > 1) {
      items.push({ label: `Bulk rename (${targets.length})`, onClick: () => setBulkRenameOpen(true) });
      items.push({ separator: true });
    }

    items.push({ label: isMulti ? `Delete (${targets.length})` : "Delete", shortcut: "Del", danger: true, onClick: () => setDeleteTargets(targets) });
    return items;
  };

  // ─── Operations ────────────────────────────────────────────────────────────
  const handleDuplicate = async (entry: ListEntry) => {
    try {
      await invoke("duplicate_file", { path: entry.path });
      await refreshList();
    } catch (e) { console.error(e); }
  };

  const handleDelete = async (targets: ListEntry[]) => {
    for (const t of targets) {
      try {
        if (isCurrentTabRemote) await invoke("delete_remote_path", { path: t.path });
        else await invoke("delete_path", { path: t.path });
      } catch (e) { console.error(e); }
    }
    setSelectedPaths([]);
    selectEntry(null);
    await refreshList();
  };

  const handlePaste = async () => {
    if (!clipboard || !currentPath) return;
    const srcRemote = clipboard.isRemote;
    const dstRemote = isCurrentTabRemote;

    if (srcRemote === dstRemote) {
      // Same-side: use native commands
      for (const src of clipboard.paths) {
        try {
          if (srcRemote) {
            // remote → remote copy: read + write (best-effort for text files)
            if (clipboard.action === "copy") {
              const entry = clipboard.entries.find((e) => e.path === src) ?? { path: src, name: src.replace(/\\/g, "/").split("/").pop()!, is_dir: false };
              await uploadRemoteEntry(entry, currentPath);
            } else {
              const name = src.replace(/\\/g, "/").split("/").pop()!;
              await invoke("rename_remote_path", { fromPath: src, toPath: currentPath.replace(/\\/g, "/") + "/" + name });
            }
          } else {
            // local → local
            if (clipboard.action === "copy") await invoke("copy_path", { src, dstDir: currentPath });
            else await invoke("move_path", { src, dstDir: currentPath });
          }
        } catch (e) { console.error(e); }
      }
    } else {
      // Cross-transfer copy
      for (const entry of clipboard.entries) {
        try {
          if (srcRemote) await downloadEntry(entry, currentPath);
          else await uploadEntry(entry, currentPath);
        } catch (e) { console.error(e); }
      }
      // Cut: delete source after transfer
      if (clipboard.action === "cut") {
        for (const src of clipboard.paths) {
          try {
            if (srcRemote) await invoke("delete_remote_path", { path: src });
            else await invoke("delete_path", { path: src });
          } catch (e) { console.error(e); }
        }
      }
    }

    if (clipboard.action === "cut") setClipboard(null);
    await refreshList();
  };

  const handleRenameSubmit = async (entry: ListEntry, newName: string) => {
    setRenamingPath(null);
    const trimmed = newName.trim();
    if (!trimmed || trimmed === entry.name) return;
    const parent = entry.path.replace(/\\/g, "/").split("/").slice(0, -1).join("\\") || currentPath;
    const newPath = (parent ? parent + "\\" : "") + trimmed;
    try {
      if (isCurrentTabRemote) await invoke("rename_remote_path", { fromPath: entry.path, toPath: newPath });
      else await invoke("rename_path", { oldPath: entry.path, newPath });
      await refreshList();
    } catch (e) { console.error(e); }
  };

  // ─── Create folder ──────────────────────────────────────────────────────────
  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name || !currentPath) return;
    const newPath = currentPath.replace(/\\/g, "/").replace(/\/$/, "") + "/" + name;
    try {
      if (isCurrentTabRemote) await invoke("create_remote_dir", { path: newPath });
      else await invoke("create_directory", { path: newPath });
      await refreshList();
    } catch (e) { console.error(e); }
    setNewFolderName(""); setShowNewFolder(false);
  };

  // ─── Create file ───────────────────────────────────────────────────────────
  const handleCreateFile = async () => {
    const name = newFileName.trim();
    if (!name || !currentPath) return;
    try {
      if (isCurrentTabRemote) {
        const newPath = currentPath.replace(/\\/g, "/").replace(/\/$/, "") + "/" + name;
        await invoke("create_remote_file", { path: newPath });
      } else {
        // Pass dir + name separately so Rust builds the path with OS-native separators
        await invoke("create_file", { dir: currentPath, name });
      }
      await refreshList();
    } catch (e) { console.error(e); }
    setNewFileName(""); setShowNewFile(false);
  };

  // ─── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;

      if (e.key === "F2" && selectedPaths.length === 1) {
        e.preventDefault();
        setRenamingPath(selectedPaths[0]);
      }
      if (e.key === "Delete" && selectedPaths.length > 0) {
        e.preventDefault();
        const targets = visibleEntries.filter((x) => selectedPaths.includes(x.path));
        setDeleteTargets(targets);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        setSelectedPaths(visibleEntries.map((x) => x.path));
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "c" && selectedPaths.length > 0) {
        e.preventDefault();
        const sel = selectedPaths.map((p) => listEntriesRef.current.find((x) => x.path === p)).filter(Boolean) as ListEntry[];
        setClipboard({ action: "copy", paths: [...selectedPaths], isRemote: isRemoteRef.current, entries: sel.map((x) => ({ path: x.path, name: x.name, is_dir: x.is_dir })) });
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "x" && selectedPaths.length > 0) {
        e.preventDefault();
        const sel = selectedPaths.map((p) => listEntriesRef.current.find((x) => x.path === p)).filter(Boolean) as ListEntry[];
        setClipboard({ action: "cut", paths: [...selectedPaths], isRemote: isRemoteRef.current, entries: sel.map((x) => ({ path: x.path, name: x.name, is_dir: x.is_dir })) });
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "v" && clipboard) {
        e.preventDefault();
        handlePaste();
      }
      if (e.key === "Escape") {
        setSelectedPaths([]);
        selectEntry(null);
      }

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (visibleEntries.length === 0) return;
        e.preventDefault();
        const lastPath = selectedPaths[selectedPaths.length - 1];
        const curIdx = lastPath ? visibleEntries.findIndex((x) => x.path === lastPath) : -1;
        const newIdx = e.key === "ArrowDown"
          ? Math.min(curIdx + 1, visibleEntries.length - 1)
          : Math.max(curIdx - 1, 0);
        if (newIdx < 0 || newIdx >= visibleEntries.length) return;
        const entry = visibleEntries[newIdx];
        setSelectedPaths([entry.path]);
        selectEntry(entry.is_dir ? { kind: "folder", entry } : { kind: "file", entry: toFileEntry(entry) });
      }

      if (e.key === "Enter" && selectedPaths.length === 1) {
        e.preventDefault();
        const entry = visibleEntries.find((x) => x.path === selectedPaths[0]);
        if (entry) {
          if (entry.is_dir) navigate(entry.path);
          else handleOpen(entry);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPaths, visibleEntries, clipboard]);

  // ─── Early returns ──────────────────────────────────────────────────────────
  if (isScanning) {
    return <div className="flex-1 flex items-center justify-center text-text-muted"><span className="text-[12px]">Scanning…</span></div>;
  }
  if (!currentPath && !folderTabs.some((t) => t.isRemote)) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted">
        <Folder size={28} className="opacity-20" />
        <span className="text-[12px]">Navigate to a folder to start</span>
      </div>
    );
  }

  // ─── Grid mode ─────────────────────────────────────────────────────────────
  if (layoutMode === "grid") {
    const files = visibleEntries.filter((e) => !e.is_dir);
    const dirs = visibleEntries.filter((e) => e.is_dir);
    return (
      <>
        {deleteTargets && (
          <ConfirmDialog
            message={`Delete ${deleteTargets.length === 1 ? `"${deleteTargets[0].name}"` : `${deleteTargets.length} items`}?`}
            detail="This action cannot be undone."
            onConfirm={() => { handleDelete(deleteTargets); setDeleteTargets(null); }}
            onCancel={() => setDeleteTargets(null)}
          />
        )}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          {parentPath && (
            <button onClick={() => navigate(parentPath)} onDoubleClick={() => navigate(parentPath)}
              className="flex flex-col items-start gap-1.5 p-3 rounded-lg border border-border hover:border-yellow-400/30 hover:bg-surface-2 text-left w-32 transition-colors">
              <Folder size={20} className="text-yellow-400 opacity-50" />
              <span className="text-[12px] text-text-muted">..</span>
            </button>
          )}
          {dirs.length > 0 && (
            <div>
              <p className="text-[10px] text-text-muted uppercase tracking-widest mb-2">Folders</p>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2">
                {dirs.map((e) => (
                  <button key={e.path}
                    onDoubleClick={() => navigate(e.path)}
                    onClick={(ev) => handleClick(ev, e)}
                    onContextMenu={(ev) => handleContextMenu(ev, e)}
                    className={clsx("flex flex-col items-start gap-1.5 p-3 rounded-lg border text-left transition-colors",
                      selectedPaths.includes(e.path) ? "border-yellow-400/50 bg-yellow-400/5" : "border-border hover:border-yellow-400/30 hover:bg-surface-2")}>
                    <Folder size={20} className="text-yellow-400" />
                    <span className="text-[12px] text-text-primary truncate w-full">{e.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {files.length > 0 && (
            <div>
              {dirs.length > 0 && <p className="text-[10px] text-text-muted uppercase tracking-widest mb-2">Files</p>}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2">
                {files.map((e) => (
                  <button key={e.path}
                    onDoubleClick={() => handleOpen(e)}
                    onClick={(ev) => handleClick(ev, e)}
                    onContextMenu={(ev) => handleContextMenu(ev, e)}
                    className={clsx("flex flex-col items-start gap-2 p-3 rounded-lg border text-left transition-colors",
                      selectedPaths.includes(e.path) ? "border-accent/50 bg-accent/5" : "border-border hover:bg-surface-2")}>
                    <FileIcon entry={e} />
                    <span className="text-[12px] text-text-primary truncate w-full">{e.name}</span>
                    <span className="text-[10px] text-text-muted">{formatSize(e.size)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {dirs.length === 0 && files.length === 0 && (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted">
              <File size={28} className="opacity-20" />
              <span className="text-[12px]">Empty folder</span>
            </div>
          )}
        </div>
        {ctxMenu && (
          <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={buildMenuItems(ctxMenu.entry)} onClose={() => setCtxMenu(null)} />
        )}
      </>
    );
  }

  // ─── List mode ─────────────────────────────────────────────────────────────
  return (
    <>
      {deleteTargets && (
        <ConfirmDialog
          message={`Delete ${deleteTargets.length === 1 ? `"${deleteTargets[0].name}"` : `${deleteTargets.length} items`}?`}
          detail="This action cannot be undone."
          onConfirm={() => { handleDelete(deleteTargets); setDeleteTargets(null); }}
          onCancel={() => setDeleteTargets(null)}
        />
      )}

      <div
        className="flex-1 overflow-y-auto flex flex-col"
        onContextMenu={(e) => {
          const target = e.target as HTMLElement;
          if (!target.closest("[data-is-entry]")) {
            e.preventDefault();
            setEmptyCtxMenu({ x: e.clientX, y: e.clientY });
          }
        }}
      >
        {/* Header */}
        <div style={ROW_COLS} className={clsx(ROW_GRID, "h-7 border-b border-border-subtle sticky top-0 bg-surface-0 shrink-0")}>
          {/* col 1: icon spacer */}
          <span />
          {/* col 2: name */}
          <SortHeader col="name" label={t.name} sortBy={sortBy} sortDir={sortDir} onSort={setSortBy} />
          {/* col 3: size */}
          <SortHeader col="size" label={t.size} width="w-full justify-end" sortBy={sortBy} sortDir={sortDir} onSort={setSortBy} />
          {/* col 4: modified */}
          <SortHeader col="modified" label={t.modified} width="w-full justify-end" sortBy={sortBy} sortDir={sortDir} onSort={setSortBy} />
          {/* col 5: actions */}
          <div className="flex items-center gap-0.5 justify-end">
            {currentPath && (<>
              <button onClick={() => { setShowNewFile(true); setTimeout(() => newFileRef.current?.focus(), 50); }}
                className="w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors" title="New file">
                <File size={11} />
              </button>
              <button onClick={() => { setShowNewFolder(true); setTimeout(() => newFolderRef.current?.focus(), 50); }}
                className="w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors" title="New folder">
                <FolderPlus size={11} />
              </button>
            </>)}
          </div>
        </div>

        {/* New file input */}
        {showNewFile && (
          <div className="flex items-center gap-2 px-4 h-8 bg-surface-2 border-b border-border-subtle shrink-0">
            <File size={13} className="text-text-muted shrink-0" />
            <input ref={newFileRef} value={newFileName} onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateFile(); if (e.key === "Escape") { setShowNewFile(false); setNewFileName(""); } }}
              onBlur={() => { if (!newFileName.trim()) setShowNewFile(false); }}
              placeholder="filename.txt…"
              className="flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder-text-muted" />
          </div>
        )}

        {/* New folder input */}
        {showNewFolder && (
          <div className="flex items-center gap-2 px-4 h-8 bg-surface-2 border-b border-border-subtle shrink-0">
            <Folder size={13} className="text-yellow-400 shrink-0" />
            <input ref={newFolderRef} value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateFolder(); if (e.key === "Escape") { setShowNewFolder(false); setNewFolderName(""); } }}
              onBlur={() => { if (!newFolderName.trim()) setShowNewFolder(false); }}
              placeholder="Folder name…"
              className="flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder-text-muted" />
          </div>
        )}

        {/* ".." up row */}
        {parentPath && (
          <button style={ROW_COLS} onClick={() => navigate(parentPath)} onDoubleClick={() => navigate(parentPath)}
            className={clsx(ROW_GRID, "w-full h-9 text-left transition-colors hover:bg-surface-2 text-text-muted hover:text-text-primary shrink-0")}>
            <ChevronUp size={15} className="opacity-50" />
            <span className="text-[12px]">..</span>
          </button>
        )}

        {/* Entries */}
        {visibleEntries.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted">
            <File size={28} className="opacity-20" />
            <span className="text-[12px]">Empty folder</span>
          </div>
        )}

        {visibleEntries.map((e) => (
          <EntryRow
            key={e.path}
            entry={e}
            selected={selectedPaths.includes(e.path)}
            cut={clipboard?.action === "cut" && clipboard.paths.includes(e.path)}
            renaming={renamingPath === e.path}
            onClick={(ev) => handleClick(ev, e)}
            onDoubleClick={() => handleOpen(e)}
            onNavigate={navigate}
            onContextMenu={handleContextMenu}
            onRenameSubmit={(name) => handleRenameSubmit(e, name)}
            onRenameCancel={() => setRenamingPath(null)}
            isDragTarget={dropTarget === e.path}
            onMouseDown={(ev) => startDrag(ev, e)}
            onMouseEnter={() => handleDragEnter(e)}
            onMouseLeave={() => handleDragLeave(e)}
          />
        ))}

        {/* Drag ghost */}
        {ghostPos && (
          <div
            style={{ position: "fixed", left: ghostPos.x + 14, top: ghostPos.y - 10, pointerEvents: "none", zIndex: 9999 }}
            className="bg-surface-2 border border-accent/50 rounded px-2.5 py-1 text-[12px] text-text-primary shadow-xl opacity-90 max-w-[200px] truncate"
          >
            {ghostPos.label}
          </div>
        )}
      </div>

      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={buildMenuItems(ctxMenu.entry)} onClose={() => setCtxMenu(null)} />
      )}

      {emptyCtxMenu && (
        <ContextMenu
          x={emptyCtxMenu.x}
          y={emptyCtxMenu.y}
          onClose={() => setEmptyCtxMenu(null)}
          items={[
            { label: "New file", onClick: () => { setEmptyCtxMenu(null); setShowNewFile(true); setTimeout(() => newFileRef.current?.focus(), 50); } },
            { label: "New folder", onClick: () => { setEmptyCtxMenu(null); setShowNewFolder(true); setTimeout(() => newFolderRef.current?.focus(), 50); } },
            ...(clipboard ? [{ separator: true as const }, { label: "Paste", shortcut: "Ctrl+V", onClick: () => { setEmptyCtxMenu(null); handlePaste(); } }] : []),
          ]}
        />
      )}
    </>
  );
}
