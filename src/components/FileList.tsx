import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import {
  ArrowDown, ArrowUp, ChevronUp,
  Code, File, FileImage, FileText, Film, Folder, FolderPlus, Music, Package,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { QuickLookModal } from "./QuickLookModal";
import { FolderPickerModal } from "./FolderPickerModal";
import { useStore } from "../store/useStore";
import { useGitStore, statusForAbsolutePath } from "../store/useGitStore";
import { highlightSnippet } from "../utils/highlightSnippet";
import { DiffCompareModal } from "./DiffCompareModal";
import { useToastStore } from "../store/useToastStore";
import type { FileEntry, ListEntry } from "../types";
import { useTranslation } from "../utils/i18n";
import { humanizeError } from "../utils/humanizeError";

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

const IMAGE_THUMB_EXTS = new Set(["png","jpg","jpeg","gif","webp","bmp","avif"]);

// Status-dot color for the per-row git badge. Kept aligned with GitPanel's
// statusColor() — same palette = same mental model for the user. We don't
// import from GitPanel to avoid an unnecessary chunk dep for non-git users.
function gitStatusDotClass(s: import("../store/useGitStore").FileStatus): string {
  switch (s) {
    case "modified":   return "bg-amber-400";
    case "added":      return "bg-emerald-400";
    case "deleted":    return "bg-red-400";
    case "renamed":    return "bg-blue-400";
    case "untracked":  return "bg-sky-400";
    case "ignored":    return "bg-text-muted";
    case "conflicted": return "bg-pink-500";
  }
}

function GridThumbnail({ entry }: { entry: ListEntry }) {
  if (entry.is_dir || !IMAGE_THUMB_EXTS.has(entry.extension.toLowerCase())) {
    return (
      <div className="w-full h-16 flex items-center justify-center">
        <FileIcon entry={entry} />
      </div>
    );
  }
  return (
    <img
      src={convertFileSrc(entry.path)}
      alt=""
      loading="lazy"
      draggable={false}
      className="w-full h-16 object-cover rounded-sm"
      onError={(ev) => {
        const img = ev.currentTarget;
        img.style.display = "none";
        const fallback = document.createElement("div");
        fallback.className = "w-full h-16 flex items-center justify-center";
        img.parentNode?.insertBefore(fallback, img);
      }}
    />
  );
}

function StatusBar({ total, selected, selectedSize }: { total: number; selected: number; selectedSize: number }) {
  const t = useTranslation();
  return (
    <div className="shrink-0 flex items-center gap-2 px-3 h-6 bg-surface-1 border-t border-border-subtle text-[10px] text-text-muted select-none">
      <span>{total.toLocaleString()} {total !== 1 ? t.elements : t.element}</span>
      {selected > 0 && (
        <>
          <span className="text-border">·</span>
          <span className="text-text-secondary">
            {selected} {selected !== 1 ? t.selectedMany : t.selectedOne}
            {selectedSize > 0 && <span className="text-text-muted"> — {formatSize(selectedSize)}</span>}
          </span>
        </>
      )}
    </div>
  );
}

export function FileIcon({ entry }: { entry: ListEntry }) {
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
const EntryRow = memo(function EntryRow({
  entry, selected, cut,
  onClick, onDoubleClick, onNavigate, onContextMenu,
  renaming, onRenameSubmit, onRenameCancel,
  isDragTarget, onPointerDown,
  gitStatus, gitDimmed,
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
  onPointerDown?: (e: React.PointerEvent) => void;
  /// Pre-resolved git status for this entry (relative-to-repo-root path lookup
  /// happens in the parent so each row stays a pure memo'd render).
  gitStatus?: import("../store/useGitStore").FileStatus | null;
  gitDimmed?: boolean;
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
      data-entry-path={entry.path}
      data-drop-path={entry.is_dir ? entry.path : undefined}
      data-is-dir={entry.is_dir ? "true" : undefined}
      style={ROW_COLS}
      onContextMenu={(e) => onContextMenu(e, entry)}
      onClick={renaming ? undefined : onClick}
      onDoubleClick={renaming ? undefined : () => entry.is_dir ? onNavigate(entry.path) : onDoubleClick()}
      onPointerDown={onPointerDown}
      className={clsx(
        ROW_GRID,
        "w-full h-9 transition-colors group cursor-pointer select-none",
        isDragTarget
          ? "ring-1 ring-inset ring-accent bg-accent/15 text-text-primary"
          : selected
          ? "bg-accent/10 text-text-primary"
          : "hover:bg-surface-2 text-text-secondary hover:text-text-primary",
        cut && "opacity-40",
        gitDimmed && !selected && "opacity-50"
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
            {gitStatus && (
              // 6px dot in the same row as the name. Position before the name so
              // it doesn't shift the entry tags chip group. Color from GitPanel's
              // palette so the legend stays single-source.
              <span
                className={clsx(
                  "inline-block w-1.5 h-1.5 rounded-full shrink-0",
                  gitStatusDotClass(gitStatus),
                )}
                title={`git: ${gitStatus}`}
              />
            )}
            <span className="truncate text-[12px]">{entry.name}</span>
            {/* Match-by-content badge for search results. Surfaces WHY a file
                whose name doesn't contain the query is showing up — without
                this, users assume the search is broken when a content match
                appears. Always visible (not gated on hover) because that's the
                user's whole question when they see the row. */}
            {entry.matched_content && (
              <span
                className="text-[9px] uppercase tracking-wide text-accent bg-accent/10 border border-accent/20 px-1.5 py-0.5 rounded shrink-0"
                title="Match in indexed file content"
              >
                contenu
              </span>
            )}
            {/* Inline snippet from FTS5 — first 24 tokens around the matched
                terms, with `<mark>` highlights via the safe parser. Truncated
                with CSS so a long line doesn't blow the row height. */}
            {entry.match_snippet && (
              <span className="text-[10px] text-text-muted truncate min-w-0 italic" title={entry.match_snippet.replace(/<\/?b>/g, "")}>
                {highlightSnippet(entry.match_snippet)}
              </span>
            )}
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
            {entry.is_dir ? "—" : formatSize(entry.size)}
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
// Only re-render when the data that actually affects display changes.
// Callbacks change identity every render but always behave the same for a given entry.
}, (prev, next) =>
  prev.entry === next.entry &&
  prev.selected === next.selected &&
  prev.cut === next.cut &&
  prev.renaming === next.renaming &&
  prev.isDragTarget === next.isDragTarget
);

// ─── Zip name modal ───────────────────────────────────────────────────────────
function ZipNameModal({ defaultName, onConfirm, onClose }: {
  defaultName: string;
  onConfirm: (name: string) => void;
  onClose: () => void;
}) {
  const t = useTranslation();
  const [name, setName] = useState(defaultName);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.select();
  }, []);
  const confirm = () => { if (name.trim()) onConfirm(name.trim()); };
  return (
    <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/60">
      <div className="bg-surface-1 border border-border rounded-xl shadow-2xl w-80 p-5 flex flex-col gap-4">
        <p className="text-[13px] font-semibold text-text-primary">{t.archiveName}</p>
        <div className="flex items-center gap-1">
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") confirm(); if (e.key === "Escape") onClose(); }}
            className="flex-1 h-7 px-2 rounded bg-surface-3 border border-accent text-[12px] text-text-primary outline-none font-mono"
            spellCheck={false}
            autoFocus
          />
          <span className="text-[12px] text-text-muted shrink-0">.zip</span>
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 h-7 rounded text-[12px] text-text-secondary hover:bg-surface-3 transition-colors">{t.cancel}</button>
          <button onClick={confirm} disabled={!name.trim()} className="px-3 h-7 rounded text-[12px] bg-accent text-white hover:bg-accent/80 disabled:opacity-40 transition-colors">{t.create}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export function FileList({ paneIndex }: { paneIndex?: 0 | 1 }) {
  const {
    listEntries, selectEntry, layoutMode,
    pinnedItems, addPinnedItem, removePinnedItem,
    setBulkRenameOpen,
    selectedTagIds, isScanning, scanProgress, setCurrentPath, setListEntries, rootPaths,
    openFile, openFolderTab, currentPath, pushNav,
    selectedPaths, setSelectedPaths,
    clipboard, setClipboard,
    sortBy, sortDir, setSortBy,
    showHidden,
    folderTabs, activeFolderTabId,
    activeContextId,
    dualPaneActive, activePaneIndex, setActivePaneIndex,
    pane2Path, pane2Entries, pane2SelectedPaths,
    setPane2Path, setPane2Entries, setPane2SelectedPaths,
    pushNav2,
  } = useStore();
  const addToast = useToastStore((s) => s.addToast);

  const pane = paneIndex ?? 0;
  const panePath = pane === 0 ? currentPath : pane2Path;
  const paneEntries = pane === 0 ? listEntries : pane2Entries;
  const paneSelectedPaths = pane === 0 ? selectedPaths : pane2SelectedPaths;
  const setPanePath = pane === 0 ? setCurrentPath : setPane2Path;
  const setPaneEntries = pane === 0 ? setListEntries : setPane2Entries;
  const setPaneSelectedPaths = pane === 0 ? setSelectedPaths : setPane2SelectedPaths;

  const t = useTranslation();

  // Per-tab remote: check the ACTIVE folder tab, not global sharing mode
  const activeTab = folderTabs.find((t) => t.id === activeFolderTabId);
  const isCurrentTabRemote = activeTab?.isRemote ?? false;

  // Refs so global handlers (inside empty-dep useEffect) always see fresh values
  const isRemoteRef = useRef(isCurrentTabRemote);
  useEffect(() => { isRemoteRef.current = isCurrentTabRemote; });
  const listEntriesRef = useRef(paneEntries);
  useEffect(() => { listEntriesRef.current = paneEntries; });
  // paneSelectedPaths is captured by EntryRow onClick/onPointerDown via memo'd closures.
  // EntryRow only re-renders when its own props change (selected, entry…), so unselected entries
  // hold a stale closure with paneSelectedPaths = []. Using a ref gives every handler the
  // current selection regardless of when EntryRow last rendered.
  const selectedPathsRef = useRef(paneSelectedPaths);
  useEffect(() => { selectedPathsRef.current = paneSelectedPaths; });

  // Always-current list helper (used in callbacks and effects)
  const listDirRef = useRef((_path: string): Promise<ListEntry[]> => Promise.resolve([]));
  useEffect(() => {
    listDirRef.current = (path: string) =>
      isCurrentTabRemote
        ? invoke<ListEntry[]>("list_remote_dir", { path })
        : invoke<ListEntry[]>("list_directory", { path, contextId: activeContextId ?? 0 });
  });
  const listDir = (path: string) => listDirRef.current(path);

  // ─── Quick Look ───────────────────────────────────────────────────────────────
  const [quickLookEntry, setQuickLookEntry] = useState<ListEntry | null>(null);


  // ─── Rubber-band selection ────────────────────────────────────────────────────
  const [rubberBand, setRubberBand] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const rubberBandActive = useRef<{ startX: number; startY: number } | null>(null);

  // ─── Drag state (mouse-event based, avoids WebView2 HTML5 DnD issues) ───────
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number; label: string } | null>(null);
  const dragRef = useRef<{
    pending: { startX: number; startY: number; paths: string[]; label: string } | null;
    active: boolean;
    paths: string[];
    label: string;
    dropTarget: string | null;
    highlightEl: Element | null;
    sourceIsRemote: boolean;
    dropTargetIsRemote: boolean;
  }>({ pending: null, active: false, paths: [], label: "", dropTarget: null, highlightEl: null, sourceIsRemote: false, dropTargetIsRemote: false });
  const didDragRef = useRef(false);
  const listContainerRef = useRef<HTMLDivElement>(null);

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
  // Archive extract-to picker
  const [extractTarget, setExtractTarget] = useState<string | null>(null);
  // Zip name prompt
  const [zipPending, setZipPending] = useState<{ paths: string[]; defaultName: string } | null>(null);
  // Two-file diff modal — tuple of paths or null. Set by the "Compare files"
  // context menu entry, cleared on close.
  const [diffTargets, setDiffTargets] = useState<[string, string] | null>(null);

  // ─── Derived: parent path for ".." row ─────────────────────────────────────
  const parentPath = useMemo(() => {
    if (!panePath) return null;
    const norm = panePath.replace(/\\/g, "/");
    if (rootPaths.some((r) => r.replace(/\\/g, "/") === norm)) return null;
    const parts = norm.split("/");
    return parts.length <= 1 ? null : parts.slice(0, -1).join("/");
  }, [panePath, rootPaths]);

  // ─── Git status (opt-in via settings, no-op when disabled) ────────────────
  // Read just the two booleans we need so this doesn't subscribe to the whole
  // settings object's churn.
  const gitEnabled = useStore((s) => s.settings.gitEnabled);
  const gitDimIgnored = useStore((s) => s.settings.gitDimIgnored);
  // Selector-scoped to avoid re-rendering FileList on unrelated GitStore changes.
  const gitStatus = useGitStore((s) => s.status);
  const gitByPath = useGitStore((s) => s.statusByPath);

  // Whether we're currently showing search results. When true, we honor the
  // backend's relevance ordering instead of column sort — otherwise the user
  // searches "focus" and the column sort puts `_kakemono.pdf` (content match,
  // alphabetically first) before `FOCUS_logo.pdf` (name match, alphabetically
  // later). Search intent always beats column sort.
  const searchQuery = useStore((s) => s.searchQuery);
  const inSearchMode = searchQuery.trim() !== "";

  // ─── Filtered + sorted entries ─────────────────────────────────────────────
  const visibleEntries = useMemo(() => {
    let entries = paneEntries;
    if (!showHidden) entries = entries.filter((e) => !e.name.startsWith("."));
    if (selectedTagIds.length > 0)
      entries = entries.filter((e) => e.is_dir || selectedTagIds.every((tid) => e.tags.some((t) => t.id === tid)));

    // In search mode, preserve backend order (Toolbar already concatenates
    // folders-first then file relevance). Column header clicks are visually
    // inert during search — that's an acceptable trade for unambiguous
    // relevance ranking. Clear the search to get column sort back.
    if (inSearchMode) {
      return entries;
    }

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
  }, [paneEntries, showHidden, selectedTagIds, sortBy, sortDir, inSearchMode]);

  const selectedSize = useMemo(() =>
    visibleEntries
      .filter((e) => !e.is_dir && paneSelectedPaths.includes(e.path))
      .reduce((s, e) => s + e.size, 0),
  [visibleEntries, paneSelectedPaths]);

  // ─── Helpers ───────────────────────────────────────────────────────────────
  const refreshList = useCallback(async (path?: string) => {
    const target = path ?? panePath;
    if (!target) return;
    try {
      const entries = await listDirRef.current(target);
      setPaneEntries(entries);
    } catch (e) { console.error(e); }
  }, [panePath, setPaneEntries]);

  // Stable ref so the drag mouseup handler (empty-dep useEffect) can call it
  const refreshListRef = useRef(refreshList);
  useEffect(() => { refreshListRef.current = refreshList; }, [refreshList]);

  const navigate = async (path: string) => {
    setPanePath(path);
    if (pane === 0) pushNav(path);
    else pushNav2(path);
    const folderName = path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
    invoke("record_activity", { path, name: folderName, action: "navigated" }).catch(() => {});
    try {
      const entries = await listDir(path);
      setPaneEntries(entries);
      selectEntry(null);
      setPaneSelectedPaths([]);
    } catch (e) { console.error("navigate error:", e); }
  };

  // ─── Pointer-Events based drag-and-drop ───────────────────────────────────
  const DRAG_THRESHOLD = 5;

  const handleEntryPointerDown = (ev: React.PointerEvent, entry: ListEntry) => {
    if (ev.button !== 0 || renamingPath === entry.path) return;
    const sel = selectedPathsRef.current;
    const paths = sel.includes(entry.path) ? [...sel] : [entry.path];
    const label = paths.length === 1 ? entry.name : `${paths.length} éléments`;
    dragRef.current.pending = { startX: ev.clientX, startY: ev.clientY, paths, label };
    dragRef.current.sourceIsRemote = isCurrentTabRemote;
  };

  // Activate drag: capture pointer so pointermove fires even outside the window,
  // then detect out-of-bounds coordinates to trigger the native OS drag.
  const activateDrag = (pointerId: number, clientX: number, clientY: number) => {
    const d = dragRef.current;
    d.paths = d.pending?.paths ?? [];
    d.label = d.pending?.label ?? "";
    d.active = true;
    d.pending = null;
    listContainerRef.current?.setPointerCapture(pointerId);
    setGhostPos({ x: clientX, y: clientY, label: d.label });
  };

  const handlePointerMove = (ev: React.PointerEvent) => {
    if (rubberBandActive.current) {
      const { startX, startY } = rubberBandActive.current;
      setRubberBand({ x1: startX, y1: startY, x2: ev.clientX, y2: ev.clientY });
      return;
    }
    const d = dragRef.current;

    if (d.active) {
      setGhostPos({ x: ev.clientX, y: ev.clientY, label: d.label });

      // With pointer capture, clientX/Y go negative or past innerWidth/Height when
      // the mouse is outside the WebView2 window — use that to trigger native OS drag.
      const outside =
        ev.clientX < 0 || ev.clientY < 0 ||
        ev.clientX >= window.innerWidth || ev.clientY >= window.innerHeight;
      if (outside && !d.sourceIsRemote && d.paths.length > 0) {
        listContainerRef.current?.releasePointerCapture(ev.pointerId);
        if (d.highlightEl) { (d.highlightEl as HTMLElement).removeAttribute("data-drag-over"); d.highlightEl = null; }
        d.active = false;
        const paths = [...d.paths];
        d.paths = []; d.dropTarget = null;
        setGhostPos(null); setDropTarget(null);
        const icon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        const onEvent = new Channel();
        invoke("plugin:drag|start_drag", { item: paths, image: icon, onEvent })
          .catch((e) => addToast({ type: "error", message: "Drag failed", detail: String(e) }));
        return;
      }

      // Update drop target while inside the window
      const els = document.elementsFromPoint(ev.clientX, ev.clientY);
      let newTarget: string | null = null;
      let newTargetEl: Element | null = null;
      for (const el of els) {
        const dropPath = (el as HTMLElement).dataset?.dropPath;
        if (dropPath && !d.paths.includes(dropPath)) {
          newTarget = dropPath;
          newTargetEl = el;
          break;
        }
      }
      if (newTarget !== d.dropTarget) {
        if (d.highlightEl) (d.highlightEl as HTMLElement).removeAttribute("data-drag-over");
        d.dropTarget = newTarget;
        d.highlightEl = newTargetEl;
        d.dropTargetIsRemote = isRemoteRef.current;
        setDropTarget(newTarget);
        if (newTargetEl) (newTargetEl as HTMLElement).setAttribute("data-drag-over", "true");
      }
      return;
    }

    if (!d.pending) return;
    const dx = ev.clientX - d.pending.startX;
    const dy = ev.clientY - d.pending.startY;
    if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
      activateDrag(ev.pointerId, ev.clientX, ev.clientY);
    }
  };

  const handlePointerUp = async (ev: React.PointerEvent) => {
    if (rubberBandActive.current) {
      rubberBandActive.current = null;
      listContainerRef.current?.releasePointerCapture(ev.pointerId);
      setRubberBand((rb) => {
        if (!rb) return null;
        const left = Math.min(rb.x1, rb.x2);
        const top = Math.min(rb.y1, rb.y2);
        const right = Math.max(rb.x1, rb.x2);
        const bottom = Math.max(rb.y1, rb.y2);
        if (right - left > 4 || bottom - top > 4) {
          const selected: string[] = [];
          listContainerRef.current?.querySelectorAll("[data-entry-path]").forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.right > left && r.left < right && r.bottom > top && r.top < bottom) {
              const path = (el as HTMLElement).dataset.entryPath;
              if (path) selected.push(path);
            }
          });
          if (selected.length > 0) setPaneSelectedPaths(selected);
        }
        return null;
      });
      return;
    }
    listContainerRef.current?.releasePointerCapture(ev.pointerId);
    const d = dragRef.current;
    if (d.highlightEl) { (d.highlightEl as HTMLElement).removeAttribute("data-drag-over"); d.highlightEl = null; }
    d.pending = null;
    if (!d.active) return;
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
      setPaneSelectedPaths([]);
      await refreshListRef.current();
    }
  };

  const handlePointerCancel = (ev: React.PointerEvent) => {
    if (rubberBandActive.current) {
      rubberBandActive.current = null;
      setRubberBand(null);
      return;
    }
    const d = dragRef.current;
    if (d.highlightEl) { (d.highlightEl as HTMLElement).removeAttribute("data-drag-over"); d.highlightEl = null; }
    d.pending = null;
    if (d.active) {
      listContainerRef.current?.releasePointerCapture(ev.pointerId);
      d.active = false;
      d.dropTarget = null;
      d.paths = [];
      setGhostPos(null);
      setDropTarget(null);
    }
  };

  const handleOpen = (e: ListEntry) => {
    invoke("record_activity", { path: e.path, name: e.name, action: "opened" }).catch(() => {});
    openFile(toFileEntry(e));
  };

  const handleOpenFolderInNewTab = async (path: string) => {
    openFolderTab(path);
    try {
      const entries = await listDir(path);
      setPaneEntries(entries);
      selectEntry(null);
      setPaneSelectedPaths([]);
    } catch (e) { console.error(e); }
  };

  // ─── Click handlers ─────────────────────────────────────────────────────────
  const handleClick = (e: React.MouseEvent, entry: ListEntry) => {
    if (didDragRef.current) { didDragRef.current = false; return; }
    const path = entry.path;
    const sel = selectedPathsRef.current;
    if (e.ctrlKey || e.metaKey) {
      setPaneSelectedPaths(
        sel.includes(path) ? sel.filter((p) => p !== path) : [...sel, path]
      );
    } else if (e.shiftKey && sel.length > 0) {
      const lastPath = sel[sel.length - 1];
      const lastIdx = visibleEntries.findIndex((x) => x.path === lastPath);
      const curIdx = visibleEntries.findIndex((x) => x.path === path);
      if (lastIdx >= 0 && curIdx >= 0) {
        const [from, to] = lastIdx < curIdx ? [lastIdx, curIdx] : [curIdx, lastIdx];
        setPaneSelectedPaths(visibleEntries.slice(from, to + 1).map((x) => x.path));
      }
    } else {
      setPaneSelectedPaths([path]);
      if (entry.is_dir) selectEntry({ kind: "folder", entry });
      else selectEntry({ kind: "file", entry: toFileEntry(entry) });
    }
  };

  // ─── Context menu builder ───────────────────────────────────────────────────
  const handleContextMenu = (e: React.MouseEvent, entry: ListEntry) => {
    e.preventDefault();
    if (!selectedPathsRef.current.includes(entry.path)) {
      setPaneSelectedPaths([entry.path]);
      if (entry.is_dir) selectEntry({ kind: "folder", entry });
      else selectEntry({ kind: "file", entry: toFileEntry(entry) });
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, entry });
  };

  const buildMenuItems = (entry: ListEntry): ContextMenuEntry[] => {
    const isMulti = paneSelectedPaths.length > 1;
    const targets = isMulti
      ? visibleEntries.filter((x) => paneSelectedPaths.includes(x.path))
      : [entry];

    const items: ContextMenuEntry[] = [];

    if (!isMulti) {
      if (!entry.is_dir) {
        items.push({ label: t.openWithSystem, onClick: () => invoke("open_with_default", { path: entry.path }) });
        items.push({ label: t.openInEditor, onClick: () => handleOpen(entry) });
        items.push({
          label: t.openInNewWindow,
          onClick: () => invoke("open_new_window", {
            mode: "file", path: entry.path, name: entry.name, ext: entry.extension,
          }).catch(console.error),
        });
      } else {
        items.push({ label: t.openFolder, onClick: () => navigate(entry.path) });
        items.push({ label: t.openInNewTab, onClick: () => handleOpenFolderInNewTab(entry.path) });
        items.push({
          label: t.openInNewWindow,
          onClick: () => invoke("open_new_window", { mode: "folder", path: entry.path }).catch(console.error),
        });
      }
      items.push({ separator: true });
      items.push({ label: t.rename, shortcut: "F2", onClick: () => setRenamingPath(entry.path) });
      if (!entry.is_dir)
        items.push({ label: t.duplicate, onClick: () => handleDuplicate(entry) });
      items.push({ separator: true });
    }

    const clipEntries = targets.map((e) => ({ path: e.path, name: e.name, is_dir: e.is_dir }));
    items.push({ label: isMulti ? `${t.copy} (${targets.length})` : t.copy, shortcut: "Ctrl+C", onClick: () => setClipboard({ action: "copy", paths: targets.map((e) => e.path), isRemote: isCurrentTabRemote, entries: clipEntries }) });
    items.push({ label: isMulti ? `${t.cut} (${targets.length})` : t.cut, shortcut: "Ctrl+X", onClick: () => setClipboard({ action: "cut", paths: targets.map((e) => e.path), isRemote: isCurrentTabRemote, entries: clipEntries }) });
    if (clipboard) items.push({ label: t.paste, shortcut: "Ctrl+V", onClick: handlePaste });
    items.push({ separator: true });

    if (!isMulti) {
      items.push({ label: t.copyPath, onClick: () => navigator.clipboard.writeText(entry.path) });
      items.push({ label: t.revealInExplorer, onClick: () => invoke("reveal_in_explorer", { path: entry.path }) });
      const ctxId = activeContextId ?? 0;
      const isPinned = pinnedItems.some((p) => p.path === entry.path && p.context_id === ctxId);
      items.push({
        label: isPinned ? t.unpinFromSidebar : t.pinToSidebar,
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

    if (isMulti && paneSelectedPaths.length > 1) {
      items.push({ label: `${t.bulkRename} (${targets.length})`, onClick: () => setBulkRenameOpen(true) });
      items.push({ separator: true });
    }

    // Compare files — only when EXACTLY 2 files (not folders) are selected.
    // Notepad++ Compare-style: unified diff in a modal.
    if (isMulti && targets.length === 2 && targets.every((e) => !e.is_dir)) {
      items.push({
        label: t.diffCompareFiles,
        onClick: () => setDiffTargets([targets[0].path, targets[1].path]),
      });
      items.push({ separator: true });
    }

    // ── Archive operations ──────────────────────────────────────────────────
    const ARCHIVE_EXTS_SET = new Set(["zip", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "7z", "rar"]);

    if (!isMulti && !entry.is_dir && ARCHIVE_EXTS_SET.has(entry.extension.toLowerCase())) {
      const archiveName = entry.name.replace(/\.(tar\.gz|tgz|tar|zip|gz|7z|rar|bz2|xz)$/i, "");
      const archiveDir = entry.path.replace(/[/\\][^/\\]+$/, "");
      items.push({ separator: true });
      items.push({
        label: t.archiveExtractHere,
        onClick: async () => {
          const dest = `${archiveDir}\\${archiveName}`;
          try {
            await invoke("extract_archive", { path: entry.path, dest });
            await refreshList();
          } catch (e) { console.error(e); }
        },
      });
      items.push({
        label: t.archiveExtractTo,
        onClick: () => setExtractTarget(entry.path),
      });
    }

    // Compress selection to zip
    if (panePath) {
      const compressTargets = targets.map((e) => e.path);
      const defaultName = isMulti
        ? "archive"
        : targets[0].name.replace(/\.[^.]+$/, "");
      items.push({
        label: isMulti ? `${t.compressToZip} (${targets.length})` : t.compressToZip,
        onClick: () => setZipPending({ paths: compressTargets, defaultName }),
      });
    }

    items.push({ separator: true });
    if (isCurrentTabRemote) {
      items.push({ label: isMulti ? `${t.delete} (${targets.length})` : t.delete, shortcut: "Del", danger: true, onClick: () => setDeleteTargets(targets) });
    } else {
      items.push({ label: isMulti ? `${t.trashMoveToTrash} (${targets.length})` : t.trashMoveToTrash, shortcut: "Del", onClick: () => handleTrash(targets) });
      items.push({ label: isMulti ? `${t.trashDeletePermanently} (${targets.length})` : t.trashDeletePermanently, shortcut: "Shift+Del", danger: true, onClick: () => setDeleteTargets(targets) });
    }
    return items;
  };

  // ─── Operations ────────────────────────────────────────────────────────────
  const handleDuplicate = async (entry: ListEntry) => {
    try {
      await invoke("duplicate_file", { path: entry.path });
      await refreshList();
    } catch (e) { console.error(e); }
  };

  const handleTrash = async (targets: ListEntry[]) => {
    const paths = targets.map((t) => t.path);
    try {
      await invoke("move_to_trash", { paths });
    } catch (e) {
      addToast({ type: "error", message: "Could not move to trash", detail: humanizeError(e) });
    }
    setPaneSelectedPaths([]);
    selectEntry(null);
    await refreshList();
  };

  const handleDelete = async (targets: ListEntry[]) => {
    const errors: string[] = [];
    for (const t of targets) {
      try {
        if (isCurrentTabRemote) await invoke("delete_remote_path", { path: t.path });
        else await invoke("delete_path", { path: t.path });
      } catch (e) { errors.push(`${t.name}: ${humanizeError(e)}`); }
    }
    if (errors.length) {
      addToast({ type: "error", message: `Failed to delete ${errors.length} item(s)`, detail: errors[0] });
    }
    setPaneSelectedPaths([]);
    selectEntry(null);
    await refreshList();
  };

  const handlePaste = async () => {
    if (!clipboard || !panePath) return;
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
              await uploadRemoteEntry(entry, panePath);
            } else {
              const name = src.replace(/\\/g, "/").split("/").pop()!;
              await invoke("rename_remote_path", { fromPath: src, toPath: panePath.replace(/\\/g, "/") + "/" + name });
            }
          } else {
            // local → local
            if (clipboard.action === "copy") await invoke("copy_path", { src, dstDir: panePath });
            else await invoke("move_path", { src, dstDir: panePath });
          }
        } catch (e) {
          addToast({ type: "error", message: `Failed to ${clipboard.action} file`, detail: humanizeError(e) });
        }
      }
    } else {
      // Cross-transfer copy
      for (const entry of clipboard.entries) {
        try {
          if (srcRemote) await downloadEntry(entry, panePath);
          else await uploadEntry(entry, panePath);
        } catch (e) {
          addToast({ type: "error", message: `Failed to transfer "${entry.name}"`, detail: humanizeError(e) });
        }
      }
      // Cut: delete source after transfer
      if (clipboard.action === "cut") {
        for (const src of clipboard.paths) {
          try {
            if (srcRemote) await invoke("delete_remote_path", { path: src });
            else await invoke("delete_path", { path: src });
          } catch (e) {
            addToast({ type: "warning", message: "Transfer done but source could not be deleted", detail: humanizeError(e) });
          }
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
    const parent = entry.path.replace(/\\/g, "/").split("/").slice(0, -1).join("\\") || panePath;
    const newPath = (parent ? parent + "\\" : "") + trimmed;
    try {
      if (isCurrentTabRemote) await invoke("rename_remote_path", { fromPath: entry.path, toPath: newPath });
      else await invoke("rename_path", { oldPath: entry.path, newPath });
      await refreshList();
    } catch (e) {
      addToast({ type: "error", message: `Could not rename "${entry.name}"`, detail: humanizeError(e) });
    }
  };

  // ─── Create folder ──────────────────────────────────────────────────────────
  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name || !panePath) return;
    const newPath = panePath.replace(/\\/g, "/").replace(/\/$/, "") + "/" + name;
    try {
      if (isCurrentTabRemote) await invoke("create_remote_dir", { path: newPath });
      else await invoke("create_directory", { path: newPath });
      await refreshList();
    } catch (e) {
      addToast({ type: "error", message: `Could not create folder "${name}"`, detail: humanizeError(e) });
    }
    setNewFolderName(""); setShowNewFolder(false);
  };

  // ─── Create file ───────────────────────────────────────────────────────────
  const handleCreateFile = async () => {
    const name = newFileName.trim();
    if (!name || !panePath) return;
    try {
      if (isCurrentTabRemote) {
        const newPath = panePath.replace(/\\/g, "/").replace(/\/$/, "") + "/" + name;
        await invoke("create_remote_file", { path: newPath });
      } else {
        // Pass dir + name separately so Rust builds the path with OS-native separators
        await invoke("create_file", { dir: panePath, name });
      }
      await refreshList();
    } catch (e) { console.error(e); }
    setNewFileName(""); setShowNewFile(false);
  };

  // ─── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only the active pane handles keyboard shortcuts in dual pane mode
      if (activePaneIndex !== pane) return;
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;

      if (e.key === "F2" && paneSelectedPaths.length === 1) {
        e.preventDefault();
        setRenamingPath(paneSelectedPaths[0]);
      }
      if (e.key === "Delete" && paneSelectedPaths.length > 0) {
        e.preventDefault();
        const targets = visibleEntries.filter((x) => paneSelectedPaths.includes(x.path));
        if (e.shiftKey || isRemoteRef.current) {
          setDeleteTargets(targets);
        } else {
          handleTrash(targets);
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        setPaneSelectedPaths(visibleEntries.map((x) => x.path));
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "c" && paneSelectedPaths.length > 0) {
        e.preventDefault();
        const sel = paneSelectedPaths.map((p) => listEntriesRef.current.find((x) => x.path === p)).filter(Boolean) as ListEntry[];
        setClipboard({ action: "copy", paths: [...paneSelectedPaths], isRemote: isRemoteRef.current, entries: sel.map((x) => ({ path: x.path, name: x.name, is_dir: x.is_dir })) });
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "x" && paneSelectedPaths.length > 0) {
        e.preventDefault();
        const sel = paneSelectedPaths.map((p) => listEntriesRef.current.find((x) => x.path === p)).filter(Boolean) as ListEntry[];
        setClipboard({ action: "cut", paths: [...paneSelectedPaths], isRemote: isRemoteRef.current, entries: sel.map((x) => ({ path: x.path, name: x.name, is_dir: x.is_dir })) });
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "v" && clipboard) {
        e.preventDefault();
        handlePaste();
      }
      if (e.key === "Escape") {
        if (quickLookEntry) { setQuickLookEntry(null); return; }
        setPaneSelectedPaths([]);
        selectEntry(null);
      }

      if (e.key === " " && paneSelectedPaths.length === 1) {
        e.preventDefault();
        const entry = visibleEntries.find((x) => x.path === paneSelectedPaths[0]);
        if (entry && !entry.is_dir) {
          setQuickLookEntry(quickLookEntry?.path === entry.path ? null : entry);
        }
      }

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (visibleEntries.length === 0) return;
        e.preventDefault();
        const lastPath = paneSelectedPaths[paneSelectedPaths.length - 1];
        const curIdx = lastPath ? visibleEntries.findIndex((x) => x.path === lastPath) : -1;
        const newIdx = e.key === "ArrowDown"
          ? Math.min(curIdx + 1, visibleEntries.length - 1)
          : Math.max(curIdx - 1, 0);
        if (newIdx < 0 || newIdx >= visibleEntries.length) return;
        const entry = visibleEntries[newIdx];
        if (e.shiftKey) {
          // Extend selection range
          const anchorPath = paneSelectedPaths[0];
          const anchorIdx = anchorPath ? visibleEntries.findIndex((x) => x.path === anchorPath) : curIdx;
          const lo = Math.min(anchorIdx < 0 ? newIdx : anchorIdx, newIdx);
          const hi = Math.max(anchorIdx < 0 ? newIdx : anchorIdx, newIdx);
          setPaneSelectedPaths(visibleEntries.slice(lo, hi + 1).map((x) => x.path));
        } else {
          setPaneSelectedPaths([entry.path]);
          selectEntry(entry.is_dir ? { kind: "folder", entry } : { kind: "file", entry: toFileEntry(entry) });
        }
      }

      // Letter-key type-ahead jump
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && /\S/.test(e.key)) {
        e.preventDefault();
        const char = e.key.toLowerCase();
        const curIdx = paneSelectedPaths.length > 0
          ? visibleEntries.findIndex((x) => x.path === paneSelectedPaths[paneSelectedPaths.length - 1])
          : -1;
        // Search from next entry, wrapping around
        const found = visibleEntries.findIndex((x, i) =>
          i > curIdx && x.name.toLowerCase().startsWith(char)
        ) ?? -1;
        const idx = found >= 0 ? found : visibleEntries.findIndex((x) => x.name.toLowerCase().startsWith(char));
        if (idx >= 0) {
          const entry = visibleEntries[idx];
          setPaneSelectedPaths([entry.path]);
          selectEntry(entry.is_dir ? { kind: "folder", entry } : { kind: "file", entry: toFileEntry(entry) });
          // Scroll the row into view
          document.querySelector(`[data-entry-path="${CSS.escape(entry.path)}"]`)
            ?.scrollIntoView({ block: "nearest" });
        }
      }

      if (e.key === "Enter" && paneSelectedPaths.length === 1) {
        e.preventDefault();
        const entry = visibleEntries.find((x) => x.path === paneSelectedPaths[0]);
        if (entry) {
          if (entry.is_dir) navigate(entry.path);
          else handleOpen(entry);
        }
      }

      // Backspace → navigate up one level
      if (e.key === "Backspace" && !e.ctrlKey) {
        e.preventDefault();
        const parent = panePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
        if (parent) navigate(parent);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneSelectedPaths, visibleEntries, clipboard, activePaneIndex, pane, panePath]);

  // ─── Early returns ──────────────────────────────────────────────────────────
  if (isScanning && pane === 0) {
    // Show live file count from the scan-progress event stream. The number
    // updates every 500 files so the user knows the scan is making progress
    // instead of staring at an opaque "Scanning..." spinner.
    const count = scanProgress?.scanned ?? 0;
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text-muted gap-1">
        <span className="text-[12px]">{t.scanning}</span>
        {count > 0 ? (
          <span className="text-[11px] opacity-70 tabular-nums">{count.toLocaleString()} {t.files.toLowerCase()}</span>
        ) : null}
      </div>
    );
  }
  if (!panePath && (pane === 0 ? !folderTabs.some((tab) => tab.isRemote) : true)) {
    return (
      <div
        className="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted"
        onPointerDown={() => setActivePaneIndex(pane)}
      >
        <Folder size={28} className="opacity-20" />
        <span className="text-[12px]">{pane === 1 ? "Click to activate pane" : t.navigateToStart}</span>
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
            message={`${t.trashDeletePermanently} ${deleteTargets.length === 1 ? `"${deleteTargets[0].name}"` : `${deleteTargets.length} ${t.elements}`} ?`}
            detail={t.trashCannotUndo}
            onConfirm={() => { handleDelete(deleteTargets); setDeleteTargets(null); }}
            onCancel={() => setDeleteTargets(null)}
          />
        )}
        <div
          className={clsx("flex-1 flex flex-col min-h-0", dualPaneActive && activePaneIndex === pane && "border-t-2 border-accent")}
          onPointerDown={() => setActivePaneIndex(pane)}
        >
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          {parentPath && (
            <button data-is-entry onClick={() => navigate(parentPath)} onDoubleClick={() => navigate(parentPath)}
              className="flex flex-col items-start gap-1.5 p-3 rounded-lg border border-border hover:border-yellow-400/30 hover:bg-surface-2 text-left w-32 transition-colors">
              <Folder size={20} className="text-yellow-400 opacity-50" />
              <span className="text-[12px] text-text-muted">..</span>
            </button>
          )}
          {dirs.length > 0 && (
            <div>
              <p className="text-[10px] text-text-muted uppercase tracking-widest mb-2">{t.folders}</p>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2">
                {dirs.map((e) => (
                  <button key={e.path}
                    onDoubleClick={() => navigate(e.path)}
                    onClick={(ev) => handleClick(ev, e)}
                    onContextMenu={(ev) => handleContextMenu(ev, e)}
                    className={clsx("flex flex-col items-start gap-1.5 p-3 rounded-lg border text-left transition-colors",
                      paneSelectedPaths.includes(e.path) ? "border-yellow-400/50 bg-yellow-400/5" : "border-border hover:border-yellow-400/30 hover:bg-surface-2")}>
                    <Folder size={20} className="text-yellow-400" />
                    <span className="text-[12px] text-text-primary truncate w-full">{e.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {files.length > 0 && (
            <div>
              {dirs.length > 0 && <p className="text-[10px] text-text-muted uppercase tracking-widest mb-2">{t.files}</p>}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2">
                {files.map((e) => (
                  <button key={e.path}
                    onDoubleClick={() => handleOpen(e)}
                    onClick={(ev) => handleClick(ev, e)}
                    onContextMenu={(ev) => handleContextMenu(ev, e)}
                    className={clsx("flex flex-col items-start gap-1.5 p-2 rounded-lg border text-left transition-colors overflow-hidden",
                      paneSelectedPaths.includes(e.path) ? "border-accent/50 bg-accent/5" : "border-border hover:bg-surface-2")}>
                    <GridThumbnail entry={e} />
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
              <span className="text-[12px]">{t.emptyFolder}</span>
            </div>
          )}
        </div>
        <StatusBar total={visibleEntries.length} selected={paneSelectedPaths.length} selectedSize={selectedSize} />
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
        className={clsx("flex-1 flex flex-col min-h-0", dualPaneActive && activePaneIndex === pane && "border-t-2 border-accent")}
        onPointerDown={() => setActivePaneIndex(pane)}
      >
      <div
        ref={listContainerRef}
        className="flex-1 overflow-y-auto flex flex-col relative"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const target = e.target as HTMLElement;
          if (target.closest("[data-is-entry]") || target.closest("[data-is-header]")) return;
          rubberBandActive.current = { startX: e.clientX, startY: e.clientY };
          listContainerRef.current?.setPointerCapture(e.pointerId);
          setRubberBand({ x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY });
          if (!e.shiftKey && !e.ctrlKey) setPaneSelectedPaths([]);
        }}
        onContextMenu={(e) => {
          const target = e.target as HTMLElement;
          if (!target.closest("[data-is-entry]")) {
            e.preventDefault();
            setEmptyCtxMenu({ x: e.clientX, y: e.clientY });
          }
        }}
      >
        {/* Header */}
        <div data-is-header style={ROW_COLS} className={clsx(ROW_GRID, "h-7 border-b border-border-subtle sticky top-0 bg-surface-0 shrink-0")}>
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
            {panePath && (<>
              <button onClick={() => { setShowNewFile(true); setTimeout(() => newFileRef.current?.focus(), 50); }}
                className="w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors" title={t.newFile}>
                <File size={11} />
              </button>
              <button onClick={() => { setShowNewFolder(true); setTimeout(() => newFolderRef.current?.focus(), 50); }}
                className="w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors" title={t.newFolder}>
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
              placeholder={`${t.newFile}…`}
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
              placeholder={`${t.newFolder}…`}
              className="flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder-text-muted" />
          </div>
        )}

        {/* ".." up row */}
        {parentPath && (
          <button data-is-entry style={ROW_COLS} onClick={() => navigate(parentPath)} onDoubleClick={() => navigate(parentPath)}
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

        {visibleEntries.map((e) => {
          // Resolve git status once per row, only when git is on. Cheap Map.get
          // lookup; falls through to undefined for non-tracked / non-changed files.
          const gs = gitEnabled ? statusForAbsolutePath(e.path, gitStatus, gitByPath) : null;
          return (
            <EntryRow
              key={e.path}
              entry={e}
              selected={paneSelectedPaths.includes(e.path)}
              cut={clipboard?.action === "cut" && clipboard.paths.includes(e.path)}
              renaming={renamingPath === e.path}
              onClick={(ev) => handleClick(ev, e)}
              onDoubleClick={() => handleOpen(e)}
              onNavigate={navigate}
              onContextMenu={handleContextMenu}
              onRenameSubmit={(name) => handleRenameSubmit(e, name)}
              onRenameCancel={() => setRenamingPath(null)}
              isDragTarget={dropTarget === e.path}
              onPointerDown={(ev) => handleEntryPointerDown(ev, e)}
              gitStatus={gs?.status ?? null}
              gitDimmed={gitDimIgnored && gs?.status === "ignored"}
            />
          );
        })}

        {/* Rubber-band selection rect */}
        {rubberBand && (() => {
          const left = Math.min(rubberBand.x1, rubberBand.x2);
          const top = Math.min(rubberBand.y1, rubberBand.y2);
          const width = Math.abs(rubberBand.x2 - rubberBand.x1);
          const height = Math.abs(rubberBand.y2 - rubberBand.y1);
          return (
            <div
              style={{ position: "fixed", left, top, width, height, pointerEvents: "none", zIndex: 200 }}
              className="bg-accent/10 border border-accent/50 rounded-sm"
            />
          );
        })()}

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
      <StatusBar total={visibleEntries.length} selected={paneSelectedPaths.length} selectedSize={selectedSize} />
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

      {diffTargets && (
        <DiffCompareModal
          pathA={diffTargets[0]}
          pathB={diffTargets[1]}
          onClose={() => setDiffTargets(null)}
        />
      )}

      {zipPending && panePath && (
        <ZipNameModal
          defaultName={zipPending.defaultName}
          onConfirm={async (name) => {
            const dest = `${panePath}\\${name.endsWith(".zip") ? name : `${name}.zip`}`;
            setZipPending(null);
            try {
              await invoke("create_zip", { sourcePaths: zipPending.paths, dest });
              await refreshList();
            } catch (e) { console.error(e); }
          }}
          onClose={() => setZipPending(null)}
        />
      )}

      {quickLookEntry && (
        <QuickLookModal
          entry={quickLookEntry}
          siblings={visibleEntries}
          onClose={() => setQuickLookEntry(null)}
        />
      )}

      {extractTarget && panePath && (
        <FolderPickerModal
          title="Extraire vers…"
          initialPath={panePath}
          onSelect={async (dest) => {
            setExtractTarget(null);
            try {
              await invoke("extract_archive", { path: extractTarget, dest });
              await refreshList();
            } catch (e) { console.error(e); }
          }}
          onClose={() => setExtractTarget(null)}
        />
      )}
    </>
  );
}
