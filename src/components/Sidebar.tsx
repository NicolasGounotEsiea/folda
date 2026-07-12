import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { clsx } from "clsx";
import {
  Bookmark, BookmarkPlus, Check, ChevronDown, ChevronRight, ChevronUp,
  File, Folder, FolderPlus, Hash, Loader2, LogIn, Plus, RefreshCw, Share2, Tag, Trash2, Users, Workflow, X, Zap,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store/useStore";
import { useIndexingStore, seedIndexingProgress } from "../store/useIndexingStore";
import type { Context, FileEntry, ListEntry, PinnedItem, SavedView, Tag as TagType } from "../types";
import { AutomationsModal } from "./AutomationsModal";
import { GitPanel } from "./GitPanel";
import { JoinModal } from "./JoinModal";
import { ShareModal } from "./ShareModal";
import { TagRulesModal } from "./TagRulesModal";
import { TrashModal } from "./TrashModal";
import { useTranslation } from "../utils/i18n";
import { useResizable } from "../utils/useResizable";

const COLOR_PALETTE = [
  "#6366f1","#ec4899","#f59e0b","#10b981","#3b82f6",
  "#8b5cf6","#ef4444","#14b8a6","#f43f5e","#84cc16",
  "#06b6d4","#a855f7","#fb923c","#64748b","#fbbf24",
];

function folderName(path: string) {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

// ─── Folder tree node ─────────────────────────────────────────────────────────
const FolderNode = memo(function FolderNode({
  path, name, depth, currentPath, onNavigate,
}: {
  path: string; name: string; depth: number;
  currentPath: string; onNavigate: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<{ path: string; name: string }[] | null>(null);

  const normCur = currentPath.replace(/\\/g, "/");
  const normPath = path.replace(/\\/g, "/");
  const isActive = normCur === normPath || normCur.startsWith(normPath + "/");

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!expanded && children === null) {
      try {
        const entries = await invoke<ListEntry[]>("list_directory", { path });
        setChildren(entries.filter((e) => e.is_dir).map((e) => ({ path: e.path, name: e.name })));
      } catch { setChildren([]); }
    }
    setExpanded((v) => !v);
  };

  return (
    <>
      <div
        data-drop-path={path}
        className={clsx(
          "group flex items-center gap-0.5 h-6 rounded transition-colors cursor-pointer select-none",
          isActive ? "bg-surface-3 text-text-primary" : "text-text-secondary hover:bg-surface-3"
        )}
        style={{ paddingLeft: `${4 + depth * 12}px` }}
      >
        <button onClick={handleToggle}
          className="w-4 h-4 flex items-center justify-center shrink-0 text-text-muted hover:text-text-secondary">
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </button>
        <button onClick={() => onNavigate(path)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left h-full">
          <Folder size={12} className="text-yellow-400 shrink-0" />
          <span className="text-[12px] truncate">{name}</span>
        </button>
      </div>
      {expanded && children && children.map((c) => (
        <FolderNode key={c.path} path={c.path} name={c.name}
          depth={depth + 1} currentPath={currentPath} onNavigate={onNavigate} />
      ))}
    </>
  );
});

const WORKSPACE_ICONS = ["📁","💼","🔬","🎨","📝","🚀","🏠","⚙️","🌿","🔥","🎯","💡","🔑","🌐","📦","🎵","🏗️","🔐","🧪","📊"];

function IconPicker({ selected, onSelect }: { selected: string; onSelect: (icon: string) => void }) {
  return (
    <div className="grid grid-cols-5 gap-0.5 p-1.5 bg-surface-3 rounded-lg">
      {WORKSPACE_ICONS.map((icon) => (
        <button
          key={icon}
          onClick={() => onSelect(icon)}
          className={clsx(
            "w-7 h-7 flex items-center justify-center text-[14px] rounded transition-colors hover:bg-surface-4",
            icon === selected && "bg-surface-4 ring-1 ring-accent"
          )}
        >{icon}</button>
      ))}
    </div>
  );
}

// ─── Workspace dropdown ───────────────────────────────────────────────────────
function WorkspaceSwitcher({
  contexts, activeId, sharingContextId, onSwitch, onExitWorkspace, onCreate, onDelete, onEdit,
}: {
  contexts: Context[];
  activeId: number | null;
  sharingContextId: number | null;
  onSwitch: (ctx: Context) => void;
  onExitWorkspace: () => void;
  onCreate: (name: string, icon: string) => void;
  onDelete: (id: number) => void;
  onEdit: (id: number, name: string, icon: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newIcon, setNewIcon] = useState("📁");
  const [showNewIconPicker, setShowNewIconPicker] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editIcon, setEditIcon] = useState("📁");
  const [showEditIconPicker, setShowEditIconPicker] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const active = contexts.find((c) => c.id === activeId);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setEditingId(null);
      }
    };
    window.addEventListener("mousedown", handler, true);
    return () => window.removeEventListener("mousedown", handler, true);
  }, [open]);

  useEffect(() => {
    if (creating) setTimeout(() => inputRef.current?.focus(), 50);
  }, [creating]);

  useEffect(() => {
    if (editingId !== null) setTimeout(() => editInputRef.current?.focus(), 50);
  }, [editingId]);

  const startEdit = (ctx: Context, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(ctx.id);
    setEditName(ctx.name);
    setEditIcon(ctx.icon);
    setShowEditIconPicker(false);
  };

  const commitEdit = () => {
    if (editingId !== null && editName.trim()) {
      onEdit(editingId, editName.trim(), editIcon);
    }
    setEditingId(null);
  };

  return (
    <div ref={ref} className="relative">
      {/* Switcher button */}
      <button
        onClick={() => { setOpen((v) => !v); setCreating(false); setEditingId(null); }}
        className="w-full flex items-center gap-2 px-3 h-9 transition-colors select-none bg-surface-2 hover:bg-surface-3 border-b border-border-subtle"
      >
        {/* Key on activeId so each switch remounts the span, re-firing the
            workspace-pulse keyframe animation. First mount also pulses,
            which doubles as a small welcome cue. */}
        <span
          key={active?.id ?? "global"}
          className="text-[14px] shrink-0 workspace-pulse"
        >
          {active?.icon ?? "🌍"}
        </span>
        <span className="flex-1 text-[12px] font-medium text-text-primary truncate text-left">
          {active?.name ?? "Global"}
        </span>
        <ChevronUp size={11} className={clsx("text-text-muted transition-transform shrink-0", open && "rotate-180")} />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full left-0 right-0 z-50 bg-surface-2 border border-border rounded-b-lg shadow-2xl py-1 overflow-hidden">
          {/* Global mode entry */}
          <button
            onClick={() => { if (activeId !== null) { onExitWorkspace(); setOpen(false); } }}
            className={clsx(
              "w-full flex items-center gap-2 px-3 h-8 text-left transition-colors",
              activeId === null ? "text-text-primary bg-accent/10" : "text-text-secondary hover:bg-surface-3"
            )}
          >
            <span className="text-[13px] shrink-0">🌍</span>
            <span className="flex-1 text-[12px] truncate">Global (no workspace)</span>
            {activeId === null && <Check size={11} className="text-accent shrink-0" />}
          </button>
          <div className="h-px bg-border-subtle mx-2 my-1" />
          {contexts.map((ctx) => (
            <div key={ctx.id}>
              {editingId === ctx.id ? (
                <div className="px-2 py-1.5 flex flex-col gap-1.5">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setShowEditIconPicker((v) => !v)}
                      className="w-7 h-7 flex items-center justify-center text-[14px] rounded hover:bg-surface-3 transition-colors"
                    >{editIcon}</button>
                    <input
                      ref={editInputRef}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { commitEdit(); setOpen(false); }
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      className="flex-1 h-6 px-2 rounded bg-surface-3 border border-accent text-[11px] text-text-primary outline-none"
                    />
                    <button onClick={() => { commitEdit(); setOpen(false); }}
                      className="text-[10px] text-accent hover:text-text-primary px-1.5 py-0.5 rounded hover:bg-surface-3 transition-colors">Save</button>
                  </div>
                  {showEditIconPicker && <IconPicker selected={editIcon} onSelect={(ic) => { setEditIcon(ic); setShowEditIconPicker(false); }} />}
                </div>
              ) : (
                <button
                  onClick={() => { if (ctx.id !== activeId) { onSwitch(ctx); setOpen(false); } }}
                  className={clsx(
                    "w-full flex items-center gap-2 px-3 h-8 text-left transition-colors group",
                    ctx.id === activeId ? "text-text-primary bg-accent/10" : "text-text-secondary hover:bg-surface-3"
                  )}
                >
                  <span className="text-[13px] shrink-0">{ctx.icon}</span>
                  <span className="flex-1 text-[12px] truncate">{ctx.name}</span>
                  {sharingContextId === ctx.id && (
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" title="Shared" />
                  )}
                  {ctx.id === activeId
                    ? <Check size={11} className="text-accent shrink-0 ml-0.5" />
                    : null}
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                    <span onClick={(e) => startEdit(ctx, e)}
                      className="w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-secondary hover:bg-surface-4 cursor-pointer">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </span>
                    {ctx.id !== activeId && (
                      <span onClick={(e) => { e.stopPropagation(); onDelete(ctx.id); }}
                        className="w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-red-400 hover:bg-surface-4 cursor-pointer">
                        <Trash2 size={10} />
                      </span>
                    )}
                  </div>
                </button>
              )}
            </div>
          ))}

          <div className="h-px bg-border-subtle mx-2 my-1" />

          {creating ? (
            <div className="px-2 py-1.5 flex flex-col gap-1.5">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setShowNewIconPicker((v) => !v)}
                  className="w-7 h-7 flex items-center justify-center text-[14px] rounded hover:bg-surface-3 transition-colors"
                >{newIcon}</button>
                <input
                  ref={inputRef}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newName.trim()) {
                      onCreate(newName.trim(), newIcon);
                      setNewName(""); setNewIcon("📁"); setCreating(false); setOpen(false);
                    }
                    if (e.key === "Escape") { setCreating(false); setNewName(""); }
                  }}
                  placeholder="Workspace name…"
                  className="flex-1 h-6 px-2 rounded bg-surface-3 border border-accent text-[11px] text-text-primary placeholder-text-muted outline-none"
                />
              </div>
              {showNewIconPicker && <IconPicker selected={newIcon} onSelect={(ic) => { setNewIcon(ic); setShowNewIconPicker(false); }} />}
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="w-full flex items-center gap-2 px-3 h-7 text-[12px] text-text-muted hover:text-accent hover:bg-surface-3 transition-colors"
            >
              <Plus size={11} /> New workspace
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Pinned item ──────────────────────────────────────────────────────────────
function PinnedRow({ item, currentPath, onNavigate, onUnpin }: {
  item: PinnedItem; currentPath: string;
  onNavigate: (path: string) => void; onUnpin: () => void;
}) {
  const isActive = currentPath.replace(/\\/g, "/") === item.path.replace(/\\/g, "/");
  return (
    <div
      data-drop-path={item.is_dir ? item.path : undefined}
      className={clsx(
        "group flex items-center gap-1.5 h-6 px-2 rounded cursor-pointer select-none transition-colors",
        isActive ? "bg-surface-3 text-text-primary" : "text-text-secondary hover:bg-surface-3"
      )}
    >
      <button onClick={() => onNavigate(item.path)}
        className="flex items-center gap-1.5 flex-1 min-w-0">
        {item.is_dir
          ? <Folder size={11} className="text-yellow-400 shrink-0" />
          : <File size={11} className="text-text-muted shrink-0" />}
        <span className="text-[12px] truncate">{item.name}</span>
      </button>
      <button onClick={(e) => { e.stopPropagation(); onUnpin(); }}
        className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-red-400 transition-all shrink-0">
        <X size={10} />
      </button>
    </div>
  );
}

// ─── Section label ────────────────────────────────────────────────────────────
function SectionHeader({ label, action }: { label: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-1">
      <span className="text-[10px] font-semibold text-text-muted tracking-widest uppercase">{label}</span>
      {action}
    </div>
  );
}

/// Per-folder indexing progress badge.
/// Uses the global `useIndexingStore` so a single tauri event listener feeds all
/// badges in the sidebar (instead of N listeners). The badge itself only subscribes
/// to its own slot via a selector, so it does not re-render when other folders progress.
function IndexingBadge({ path }: { path: string }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Subscribe ONLY to this folder's slice of the progress map. Returns undefined
  // until seedIndexingProgress has fired, which is fine — we render nothing then.
  const state = useIndexingStore((s) => s.progress[path]);
  const ensureListener = useIndexingStore((s) => s.ensureListener);
  useEffect(() => { ensureListener(); }, [ensureListener]);

  // Initial fetch — seeds the global store under our path key.
  useEffect(() => {
    let cancelled = false;
    invoke<[number, number]>("get_indexing_stats", { path })
      .then(([total, indexed]) => { if (!cancelled) seedIndexingProgress(path, total, indexed); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [path]);

  // Close popover on outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!state || state.total === 0) return null;
  // Clamp so display can never overshoot 100% even if the backend counter desyncs
  // (e.g. files added by the watcher during a long indexing run).
  const safeIndexed = Math.min(state.indexed, state.total);
  const stats = { total: state.total, indexed: safeIndexed };
  const currentFile = state.current;

  const pct = Math.round((stats.indexed / stats.total) * 100);
  const isFull = pct >= 100;
  const remaining = stats.total - stats.indexed;

  const handleReindex = async () => {
    if (busy) return;
    setBusy(true);
    // Keep the popover open so the user can see the live progress + current file.
    try {
      await invoke("index_directory_content", { path, force: true });
    } catch (e) { console.error(e); }
    finally {
      setBusy(false);
      // After the indexer's final emit (done=true), counters are already up to date
      // in the global store. A safety-net refresh re-reads the DB to be sure.
      invoke<[number, number]>("get_indexing_stats", { path })
        .then(([total, indexed]) => seedIndexingProgress(path, total, indexed))
        .catch(() => {});
    }
  };

  // Floating popover anchored to the button's bounding rect, rendered via portal
  // so the sidebar's overflow doesn't clip it. buttonRef + anchor are declared above
  // (with the other hooks) so they don't run conditionally after the early return.
  const toggleOpen = () => {
    if (!open && buttonRef.current) {
      const r = buttonRef.current.getBoundingClientRect();
      // Open to the right of the badge so it never overflows past the sidebar's right edge
      setAnchor({ top: r.bottom + 4, left: r.right - 240 });
    }
    setOpen((v) => !v);
  };

  return (
    <>
      <button
        ref={buttonRef}
        onClick={(e) => { e.stopPropagation(); toggleOpen(); }}
        title={busy ? "Indexing in progress — click to view details" : "Click for indexing details"}
        className={clsx(
          "shrink-0 mr-0.5 flex items-center gap-1 px-1 h-4 rounded text-[9px] font-medium transition-colors",
          isFull
            ? "text-emerald-400/80 hover:bg-emerald-500/10"
            : "text-amber-400 hover:bg-amber-500/10"
        )}
      >
        {busy ? <Loader2 size={8} className="animate-spin" /> : (!isFull && <RefreshCw size={8} />)}
        <span>{pct}%</span>
      </button>
      {open && anchor && createPortal(
        <div
          ref={popoverRef}
          style={{
            position: "fixed",
            top: anchor.top,
            left: Math.max(8, Math.min(anchor.left, window.innerWidth - 248)),
            width: 240,
            zIndex: 1000,
          }}
          className="rounded-lg border border-border bg-surface-2 shadow-2xl p-3 flex flex-col gap-2"
        >
          <div>
            <p className="text-[11px] font-semibold text-text-primary mb-0.5">Content indexing</p>
            <p className="text-[10px] text-text-muted leading-relaxed">
              Extracts text from PDFs, Word docs, spreadsheets so search works on file content.
            </p>
          </div>

          <div className="rounded bg-surface-3 px-2 py-1.5 text-[10px] text-text-secondary">
            <div className="flex justify-between">
              <span>Processed</span>
              <span className="font-mono">{stats.indexed} / {stats.total}</span>
            </div>
            <div className="flex justify-between">
              <span>Remaining</span>
              <span className={clsx("font-mono", remaining > 0 ? "text-amber-400" : "text-emerald-400")}>
                {remaining}
              </span>
            </div>
            {currentFile && (
              <div className="mt-1 pt-1 border-t border-border-subtle flex items-baseline gap-1">
                <Loader2 size={8} className="animate-spin text-accent shrink-0" />
                <span className="truncate text-[10px] text-text-muted font-mono">{currentFile}</span>
              </div>
            )}
          </div>

          <button
            onClick={handleReindex}
            disabled={busy}
            className="h-7 rounded bg-accent text-white text-[11px] font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
          >
            {busy ? "Indexing…" : isFull ? "Re-scan everything" : "Index missing files"}
          </button>
          <p className="text-[10px] text-text-muted leading-relaxed -mt-1">
            Runs in the background. The app may feel slower while it processes large PDFs.
          </p>
        </div>,
        document.body
      )}
    </>
  );
}

// ─── Main Sidebar ─────────────────────────────────────────────────────────────
export function Sidebar() {
  const {
    tags, setTags, tagStats, setTagStats, savedViews, setSavedViews,
    selectedTagIds, toggleTagFilter, clearTagFilters,
    currentPath, setCurrentPath, setListEntries,
    setFiles, setTags: _setTags, setIsScanning, setScanProgress, selectFile, pushNav,
    contexts, setContexts, activeContextId, exitWorkspace,
    addFolderToContext, removeFolderFromContext, switchWorkspace,
    pinnedItems, setPinnedItems, removePinnedItem,
    folderTabs, tabs,
    sharingMode, sharingClients, sharingContextId, sharingWorkspaceName, sharingWorkspaceIcon, remoteWorkspaceName,
    shareModalOpen, joinModalOpen, setShareModalOpen, setJoinModalOpen, sharingReconnecting,
    settings,
  } = useStore();

  const tSidebar = useTranslation();
  const [trashOpen, setTrashOpen] = useState(false);
  const [showNewTag, setShowNewTag] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(COLOR_PALETTE[0]);
  const [showRulesModal, setShowRulesModal] = useState(false);
  // automationsModalOpen lives in the store so toasts (e.g. rate-limit warning)
  // can open the modal from outside the Sidebar's local state.
  const automationsModalOpen = useStore((s) => s.automationsModalOpen);
  const setAutomationsModalOpen = useStore((s) => s.setAutomationsModalOpen);
  const [editingTagId, setEditingTagId] = useState<number | null>(null);
  const [editTagName, setEditTagName] = useState("");
  const [editTagColor, setEditTagColor] = useState("");
  const [savingViewName, setSavingViewName] = useState("");
  const [showSaveView, setShowSaveView] = useState(false);

  const activeCtx = contexts.find((c) => c.id === activeContextId) ?? null;

  // Load on mount
  useEffect(() => {
    Promise.all([
      invoke<Context[]>("get_contexts"),
      invoke<TagType[]>("get_tags"),
    ]).then(([ctxs, tagList]) => {
      setContexts(ctxs);
      setTags(tagList);
    }).catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload saved views when workspace changes
  useEffect(() => {
    const ctxId = activeContextId ?? 0;
    invoke<SavedView[]>("get_saved_views", { contextId: ctxId })
      .then(setSavedViews)
      .catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeContextId]);

  // Refresh tag counts after navigation — debounced to avoid hammering the DB on rapid folder changes
  useEffect(() => {
    const ctxId = activeContextId ?? 0;
    const tid = setTimeout(() => {
      invoke("get_tag_stats", { contextId: ctxId })
        .then((s) => setTagStats(s as Parameters<typeof setTagStats>[0]))
        .catch(console.error);
    }, 200);
    return () => clearTimeout(tid);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath, activeContextId]);

  // Reload pins whenever active workspace changes
  useEffect(() => {
    invoke<PinnedItem[]>("get_pinned_items", { contextId: activeContextId ?? 0 })
      .then(setPinnedItems)
      .catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeContextId]);

  const navigateTo = useCallback(async (path: string) => {
    setCurrentPath(path);
    pushNav(path);
    try {
      const entries = await invoke<ListEntry[]>("list_directory", { path, contextId: activeContextId ?? 0 });
      setListEntries(entries);
      selectFile(null);
    } catch (e) { console.error(e); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeContextId]);

  // ── Switch workspace ──────────────────────────────────────────────────────
  const handleSwitch = async (ctx: Context) => {
    if (ctx.id === activeContextId) return;

    // Persist current workspace state (including open tabs) to backend
    if (activeCtx) {
      await invoke("update_context", {
        id: activeCtx.id, name: activeCtx.name, icon: activeCtx.icon,
        watchedPaths: activeCtx.watched_paths,
        lastPath: currentPath,
        activeTagIds: selectedTagIds,
        openTabs: folderTabs.map((t) => t.path),
        openFileTabs: tabs.map((t) => t.id),
      }).catch(console.error);
      await invoke("set_active_context", { contextId: ctx.id }).catch(console.error);
    }

    // Store atomically saves current tabs and restores target workspace's tabs + currentPath
    const restored = switchWorkspace(ctx.id);
    if (!restored) return;

    // Navigate: store already set currentPath; just push nav and fetch entries
    const target = restored.lastPath;
    if (target) {
      pushNav(target);
      try {
        const entries = await invoke<ListEntry[]>("list_directory", { path: target, contextId: ctx.id });
        setListEntries(entries);
        selectFile(null);
      } catch { /* folder may have moved */ }
    }
  };

  // ── Create workspace ──────────────────────────────────────────────────────
  const handleCreate = async (name: string, icon: string) => {
    try {
      const id = await invoke<number>("create_context", { name, icon });
      await invoke("set_active_context", { contextId: id });
      const updated = await invoke<Context[]>("get_contexts");
      setContexts(updated);
      // New workspace has no folders — clear the file list view
      setCurrentPath("");
      setListEntries([]);
    } catch (e) { console.error(e); }
  };

  // ── Edit workspace (rename + icon) ─────────────────────────────────────────
  const handleEdit = async (id: number, name: string, icon: string) => {
    const ctx = contexts.find((c) => c.id === id);
    if (!ctx) return;
    try {
      await invoke("update_context", {
        id, name, icon,
        watchedPaths: ctx.watched_paths,
        lastPath: ctx.last_path,
        activeTagIds: ctx.pinned_tag_ids,
        openTabs: ctx.open_tabs ?? [],
        openFileTabs: ctx.open_file_tabs ?? [],
      });
      const updated = await invoke<Context[]>("get_contexts");
      setContexts(updated);
    } catch (e) { console.error(e); }
  };

  // ── Delete workspace ──────────────────────────────────────────────────────
  const handleDelete = async (id: number) => {
    // Don't delete the active one without confirmation — just prevent it silently
    if (id === activeContextId) return;
    try {
      await invoke("delete_context", { id });
      const updated = await invoke<Context[]>("get_contexts");
      setContexts(updated);
    } catch (e) { console.error(e); }
  };

  // ── Browse to any folder (global mode) ───────────────────────────────────
  const handleBrowse = async () => {
    let selected: string | string[] | null;
    try { selected = await open({ directory: true, multiple: false }); } catch { return; }
    if (!selected || typeof selected !== "string") return;
    navigateTo(selected);
  };

  // ── Add folder to active workspace ────────────────────────────────────────
  const handleAddFolder = async () => {
    if (!activeCtx) return;
    let selected: string | string[] | null;
    try { selected = await open({ directory: true, multiple: false }); } catch { return; }
    if (!selected || typeof selected !== "string") return;

    addFolderToContext(activeCtx.id, selected);
    const updated = activeCtx.watched_paths.includes(selected)
      ? activeCtx.watched_paths
      : [...activeCtx.watched_paths, selected];
    await invoke("update_context", {
      id: activeCtx.id, name: activeCtx.name, icon: activeCtx.icon,
      watchedPaths: updated, lastPath: activeCtx.last_path, activeTagIds: selectedTagIds,
      openTabs: folderTabs.map((t) => t.path),
      openFileTabs: tabs.map((t) => t.id),
    }).catch(console.error);

    setCurrentPath(selected); pushNav(selected);
    try {
      const entries = await invoke<ListEntry[]>("list_directory", { path: selected, contextId: activeCtx.id });
      setListEntries(entries); selectFile(null);
    } catch { /* ignore */ }

    setIsScanning(true);
    // Reset any leftover progress from a previous scan so the FileList overlay
    // starts at "0 files" instead of inheriting the stale done-state.
    setScanProgress({ path: selected as string, scanned: 0, done: false });
    invoke<FileEntry[]>("scan_directory", { path: selected })
      .then(async (files) => {
        setFiles(files);
        const tl = await invoke<TagType[]>("get_tags"); _setTags(tl);
        const entries = await invoke<ListEntry[]>("list_directory", { path: selected as string, contextId: activeCtx.id });
        setListEntries(entries);
        // Re-seed the IndexingBadge for this folder. Without this, the badge mounted
        // at addFolder-time saw total=0 (scan hadn't populated `files` yet) and the
        // store treats subsequent `content-indexed` events as "no matching badge"
        // because match is by `st.total === event.total`. Result: badge stays hidden
        // until the user switches workspaces, forcing a remount + re-fetch.
        // Re-seeding now (post-scan, pre-indexer) replaces the stale 0/0 slot with
        // the real totals so the badge appears immediately and tracks progress.
        try {
          const [total, indexed] = await invoke<[number, number]>("get_indexing_stats", { path: selected as string });
          seedIndexingProgress(selected as string, total, indexed);
        } catch { /* badge can self-recover on next mount */ }
        // Trigger async content extraction in background for all unindexed files
        // (PDFs, DOCX, etc. skipped during scan due to size). Fire and forget.
        // Only when content indexing is enabled in settings.
        if (settings.contentIndexing) {
          invoke("index_directory_content", { path: selected }).catch(console.error);
        }
      })
      .catch(console.error)
      .finally(() => {
        setIsScanning(false);
        setScanProgress(null);
      });
    invoke("watch_directory", { path: selected }).catch(console.error);
  };

  // ── Remove folder from active workspace ───────────────────────────────────
  const handleRemoveFolder = async (path: string) => {
    if (!activeCtx) return;
    removeFolderFromContext(activeCtx.id, path);
    const updated = activeCtx.watched_paths.filter((p) => p !== path);
    await invoke("update_context", {
      id: activeCtx.id, name: activeCtx.name, icon: activeCtx.icon,
      watchedPaths: updated, lastPath: activeCtx.last_path, activeTagIds: selectedTagIds,
      openTabs: folderTabs.map((t) => t.path),
      openFileTabs: tabs.map((t) => t.id),
    }).catch(console.error);
  };

  // ── Tags ──────────────────────────────────────────────────────────────────
  const handleCreateTag = async () => {
    if (!newTagName.trim()) return;
    try {
      await invoke("create_tag", { name: newTagName.trim(), color: newTagColor });
      const [updated, stats] = await Promise.all([
        invoke<TagType[]>("get_tags"),
        invoke("get_tag_stats", { contextId: activeContextId ?? 0 }),
      ]);
      setTags(updated);
      setTagStats(stats as Parameters<typeof setTagStats>[0]);
      setNewTagName(""); setNewTagColor(COLOR_PALETTE[0]); setShowNewTag(false);
    } catch (e) { console.error(e); }
  };

  const startEditTag = (tag: TagType) => {
    setEditingTagId(tag.id);
    setEditTagName(tag.name);
    setEditTagColor(tag.color);
  };

  const handleSaveTag = async () => {
    if (!editingTagId || !editTagName.trim()) return;
    try {
      await invoke("update_tag", { id: editingTagId, name: editTagName.trim(), color: editTagColor });
      const updated = await invoke<TagType[]>("get_tags");
      setTags(updated);
    } catch (e) { console.error(e); }
    setEditingTagId(null);
  };

  const handleDeleteTag = async (id: number) => {
    setEditingTagId(null);
    try {
      await invoke("delete_tag", { id });
      const [updated, stats] = await Promise.all([
        invoke<TagType[]>("get_tags"),
        invoke("get_tag_stats", { contextId: activeContextId ?? 0 }),
      ]);
      setTags(updated);
      setTagStats(stats as Parameters<typeof setTagStats>[0]);
    } catch (e) { console.error(e); }
  };

  // ── Saved views ───────────────────────────────────────────────────────────
  const handleSaveView = async () => {
    if (!savingViewName.trim() || selectedTagIds.length === 0) return;
    try {
      await invoke("create_saved_view", {
        name: savingViewName.trim(),
        icon: "🔖",
        tagIds: selectedTagIds,
        contextId: activeContextId ?? 0,
      });
      const views = await invoke<SavedView[]>("get_saved_views", { contextId: activeContextId ?? 0 });
      setSavedViews(views);
      setSavingViewName(""); setShowSaveView(false);
    } catch (e) { console.error(e); }
  };

  const handleDeleteView = async (id: number) => {
    try {
      await invoke("delete_saved_view", { id });
      setSavedViews(savedViews.filter((v) => v.id !== id));
    } catch (e) { console.error(e); }
  };

  // ── Pinned ────────────────────────────────────────────────────────────────
  const handleUnpin = async (path: string, contextId: number) => {
    await invoke("unpin_item", { path, contextId }).catch(console.error);
    removePinnedItem(path);
    // Refresh to reflect any remaining pin in other scope
    const updated = await invoke<PinnedItem[]>("get_pinned_items", { contextId: activeContextId ?? 0 }).catch(() => pinnedItems);
    setPinnedItems(updated);
  };

  const handlePromotePin = async (path: string) => {
    await invoke("promote_pin_to_global", { path }).catch(console.error);
    const updated = await invoke<PinnedItem[]>("get_pinned_items", { contextId: activeContextId ?? 0 }).catch(() => pinnedItems);
    setPinnedItems(updated);
  };

  // Resizable sidebar. Width is persisted across sessions (different from the
  // PreviewPanel which is ephemeral) because the user sets sidebar width once
  // and expects it to stick. Double-click on the handle resets to default.
  const { width: sidebarWidth, containerRef: sidebarRef, onDragStart: sidebarDragStart, reset: sidebarReset } =
    useResizable<HTMLElement>({ defaultWidth: 210, min: 200, max: 480, side: "left", storageKey: "nxs.sidebarWidth" });

  return (
    <aside ref={sidebarRef} className="flex flex-col bg-surface-1 border-r shrink-0 overflow-hidden relative"
      style={{ width: sidebarWidth, borderColor: "#1f1f1f" }}>
      {/* Resize handle — thin 4px column on the right edge. Double-click resets
          to the default width. position absolute keeps it from disturbing the
          sidebar's flex layout. z-10 to sit above content. */}
      <div
        onMouseDown={sidebarDragStart}
        onDoubleClick={sidebarReset}
        title="Drag to resize · double-click to reset"
        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/40 transition-colors z-10"
      />

      {/* ── Workspace switcher ── */}
      <WorkspaceSwitcher
        contexts={contexts}
        activeId={activeContextId}
        sharingContextId={sharingContextId}
        onSwitch={handleSwitch}
        onExitWorkspace={exitWorkspace}
        onCreate={handleCreate}
        onDelete={handleDelete}
        onEdit={handleEdit}
      />

      <div className="flex-1 overflow-y-auto">

        {/* ── Folders of active workspace ── */}
        <div className="px-3 pt-3 pb-2">
          <SectionHeader label="Folders" action={
            activeCtx && (
              <button onClick={handleAddFolder} title="Add folder"
                className="w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors">
                <FolderPlus size={11} />
              </button>
            )
          } />

          {!activeCtx ? (
            <div className="flex flex-col gap-1">
              <button
                onClick={handleBrowse}
                className="w-full flex items-center gap-2 px-2 h-7 rounded border border-dashed border-border text-text-muted hover:border-accent hover:text-accent text-[11px] transition-colors"
              >
                <FolderPlus size={11} /> Browse a folder…
              </button>
              {currentPath && (
                <div className="mt-0.5">
                  <FolderNode
                    path={currentPath} name={folderName(currentPath)} depth={0}
                    currentPath={currentPath} onNavigate={navigateTo}
                  />
                </div>
              )}
            </div>
          ) : activeCtx.watched_paths.length === 0 ? (
            <button onClick={handleAddFolder}
              className="w-full flex items-center gap-2 px-2 h-7 rounded border border-dashed border-border text-text-muted hover:border-accent hover:text-accent text-[11px] transition-colors">
              <Plus size={11} /> Add a folder
            </button>
          ) : (
            <div className="flex flex-col gap-0.5">
              {activeCtx.watched_paths.map((p) => (
                // items-start (NOT items-center): FolderNode renders its whole
                // expanded subtree inside the flex-1 wrapper, so centering
                // would pull the badge + remove button down to the vertical
                // middle of the expanded tree — the "12%" badge appeared to
                // float next to some random subfolder. Anchoring to the top
                // plus a fixed h-6 (FolderNode row height) keeps both pinned
                // to the ROOT folder's row no matter how deep the tree unfolds.
                <div key={p} className="group/root flex items-start">
                  <div className="flex-1 min-w-0">
                    <FolderNode path={p} name={folderName(p)} depth={0}
                      currentPath={currentPath} onNavigate={navigateTo} />
                  </div>
                  <div className="h-6 flex items-center shrink-0">
                    <IndexingBadge path={p} />
                    <button
                      onClick={() => handleRemoveFolder(p)}
                      title="Remove from workspace"
                      className="opacity-0 group-hover/root:opacity-100 w-4 h-4 flex items-center justify-center shrink-0 text-text-muted hover:text-red-400 transition-all mr-0.5"
                    ><X size={9} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Pinned ── */}
        {pinnedItems.length > 0 && (() => {
          const workspacePins = pinnedItems.filter((p) => p.context_id !== 0);
          const globalPins = pinnedItems.filter((p) => p.context_id === 0);
          return (
            <>
              <div className="h-px bg-border-subtle mx-3" />
              <div className="px-3 py-2">
                {/* Workspace pins */}
                {workspacePins.length > 0 && (
                  <>
                    <SectionHeader label="Pinned (workspace)" />
                    <div className="flex flex-col gap-0.5 mb-2">
                      {workspacePins.map((item) => (
                        <div key={item.path} className="group/pin flex items-center gap-1">
                          <div className="flex-1 min-w-0">
                            <PinnedRow item={item} currentPath={currentPath}
                              onNavigate={navigateTo} onUnpin={() => handleUnpin(item.path, item.context_id)} />
                          </div>
                          <button
                            onClick={() => handlePromotePin(item.path)}
                            title="Promote to global"
                            className="opacity-0 group-hover/pin:opacity-100 shrink-0 text-[9px] text-accent hover:text-text-primary transition-all px-1"
                          >↑</button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {/* Global pins */}
                {globalPins.length > 0 && (
                  <>
                    <SectionHeader label={workspacePins.length > 0 ? "Pinned (global)" : "Pinned"} />
                    <div className="flex flex-col gap-0.5">
                      {globalPins.map((item) => (
                        <PinnedRow key={item.path} item={item} currentPath={currentPath}
                          onNavigate={navigateTo} onUnpin={() => handleUnpin(item.path, 0)} />
                      ))}
                    </div>
                  </>
                )}
              </div>
            </>
          );
        })()}

        {/* ── Tags ── */}
        <div className="h-px bg-border-subtle mx-3" />
        <div className="px-3 py-2 pb-4">
          <SectionHeader label="Tags" action={
            <div className="flex items-center gap-0.5">
              <button onClick={() => setShowRulesModal(true)} title="Tag rules"
                className="w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-accent hover:bg-surface-3 transition-colors">
                <Zap size={11} />
              </button>
              <button onClick={() => setShowNewTag((v) => !v)} title="New tag"
                className="w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors">
                <Plus size={11} />
              </button>
            </div>
          } />

          {showNewTag && (
            <div className="mt-1 mb-2 p-2 rounded-lg bg-surface-2 border border-border flex flex-col gap-1.5">
              <input
                autoFocus type="text" value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateTag(); if (e.key === "Escape") { setShowNewTag(false); setNewTagName(""); } }}
                placeholder="Tag name…"
                className="w-full h-6 px-2 rounded bg-surface-3 border border-border text-[11px] text-text-primary placeholder-text-muted outline-none focus:border-accent"
              />
              <div className="grid grid-cols-5 gap-1">
                {COLOR_PALETTE.map((c) => (
                  <button key={c} onClick={() => setNewTagColor(c)}
                    className={clsx("w-full aspect-square rounded-full transition-transform hover:scale-110",
                      newTagColor === c && "ring-2 ring-offset-1 ring-offset-surface-2 ring-white/70")}
                    style={{ background: c }} />
                ))}
              </div>
            </div>
          )}

          {/* Saved views */}
          {savedViews.length > 0 && (
            <div className="mb-1.5 flex flex-col gap-0.5">
              {savedViews.map((view) => (
                <div key={view.id} className="group flex items-center">
                  <button
                    onClick={() => {
                      clearTagFilters();
                      view.tag_ids.forEach((id) => toggleTagFilter(id));
                    }}
                    className={clsx(
                      "flex-1 flex items-center gap-1.5 px-2 h-6 rounded text-[12px] transition-colors truncate",
                      JSON.stringify(view.tag_ids.sort()) === JSON.stringify([...selectedTagIds].sort())
                        ? "text-text-primary bg-accent/10"
                        : "text-text-secondary hover:bg-surface-3"
                    )}
                  >
                    <Bookmark size={10} className="shrink-0 text-text-muted" />
                    <span className="truncate">{view.name}</span>
                  </button>
                  <button
                    onClick={() => handleDeleteView(view.id)}
                    className="opacity-0 group-hover:opacity-100 w-4 h-4 flex items-center justify-center rounded text-text-muted hover:text-red-400 transition-all shrink-0 mr-0.5">
                    <X size={9} />
                  </button>
                </div>
              ))}
              <div className="h-px bg-border-subtle my-0.5" />
            </div>
          )}

          {/* All files */}
          <button onClick={clearTagFilters}
            className={clsx("w-full flex items-center gap-2 px-2 h-6 rounded text-[12px] transition-colors",
              selectedTagIds.length === 0 ? "text-text-primary bg-surface-3" : "text-text-secondary hover:bg-surface-3")}>
            <Hash size={12} className="text-text-muted" /> All files
          </button>

          {/* Tag list */}
          <div className="mt-0.5 flex flex-col gap-0.5">
            {tags.map((tag) => {
              const count = tagStats.find((s) => s.tag_id === tag.id)?.count ?? 0;
              const isSelected = selectedTagIds.includes(tag.id);
              const isEditing = editingTagId === tag.id;

              if (isEditing) {
                return (
                  <div key={tag.id} className="rounded-lg bg-surface-2 border border-accent/40 p-2 flex flex-col gap-2">
                    {/* Name input */}
                    <input
                      autoFocus
                      value={editTagName}
                      onChange={(e) => setEditTagName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleSaveTag(); if (e.key === "Escape") setEditingTagId(null); }}
                      className="w-full h-6 px-2 rounded bg-surface-3 border border-border text-[11px] text-text-primary outline-none focus:border-accent"
                    />
                    {/* Color palette */}
                    <div className="grid grid-cols-5 gap-1">
                      {COLOR_PALETTE.map((c) => (
                        <button
                          key={c}
                          onClick={() => setEditTagColor(c)}
                          className={clsx(
                            "w-full aspect-square rounded-full transition-transform hover:scale-110",
                            editTagColor === c && "ring-2 ring-offset-1 ring-offset-surface-2 ring-white/70"
                          )}
                          style={{ background: c }}
                        />
                      ))}
                    </div>
                    {/* Actions */}
                    <div className="flex items-center justify-between">
                      <button
                        onClick={() => handleDeleteTag(tag.id)}
                        className="text-[11px] text-red-400 hover:text-red-300 transition-colors flex items-center gap-1"
                      >
                        <Trash2 size={10} /> Delete
                      </button>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setEditingTagId(null)}
                          className="h-5 px-2 rounded text-[11px] text-text-muted hover:bg-surface-3 transition-colors"
                        >Cancel</button>
                        <button
                          onClick={handleSaveTag}
                          disabled={!editTagName.trim()}
                          className="h-5 px-2 rounded bg-accent text-white text-[11px] disabled:opacity-30 hover:bg-accent/80 transition-colors"
                        >Save</button>
                      </div>
                    </div>
                  </div>
                );
              }

              return (
                <div key={tag.id} className="group flex items-center gap-1">
                  <button
                    onClick={() => toggleTagFilter(tag.id)}
                    className={clsx(
                      "flex-1 flex items-center gap-2 px-2 h-6 rounded text-[12px] transition-colors min-w-0",
                      isSelected ? "text-text-primary bg-surface-3" : "text-text-secondary hover:bg-surface-3"
                    )}>
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: tag.color }} />
                    <span className="truncate flex-1 text-left">{tag.name}</span>
                    {count > 0 && (
                      <span className="text-[10px] text-text-muted shrink-0">{count}</span>
                    )}
                  </button>
                  {!tag.is_auto && (
                    <button
                      onClick={() => startEditTag(tag)}
                      title="Edit tag"
                      className="opacity-0 group-hover:opacity-100 w-4 h-4 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-all shrink-0">
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {tags.length === 0 && (
            <div className="mt-2 flex flex-col items-center gap-1 text-center">
              <Tag size={18} className="text-text-muted opacity-30" />
              <span className="text-[10px] text-text-muted">No tags yet</span>
            </div>
          )}

          {/* Save current filter as view */}
          {selectedTagIds.length > 0 && (
            <div className="mt-2">
              {showSaveView ? (
                <div className="flex items-center gap-1">
                  <input autoFocus value={savingViewName}
                    onChange={(e) => setSavingViewName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleSaveView(); if (e.key === "Escape") setShowSaveView(false); }}
                    placeholder="View name…"
                    className="flex-1 h-6 px-2 rounded bg-surface-3 border border-accent text-[11px] text-text-primary placeholder-text-muted outline-none" />
                  <button onClick={handleSaveView} disabled={!savingViewName.trim()}
                    className="h-6 px-2 rounded bg-accent text-white text-[11px] disabled:opacity-30 hover:bg-accent/80 transition-colors">Save</button>
                </div>
              ) : (
                <button onClick={() => setShowSaveView(true)}
                  className="w-full flex items-center gap-1.5 px-2 h-6 rounded text-[11px] text-text-muted hover:text-accent hover:bg-surface-3 transition-colors border border-dashed border-border">
                  <BookmarkPlus size={10} /> Save filter as view
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {showRulesModal && <TagRulesModal onClose={() => setShowRulesModal(false)} />}

      {/* ── Git panel (opt-in via Settings; self-hides if currentPath not in a repo) ── */}
      <GitPanel />

      {/* ── Automations ── */}
      <div className="shrink-0 border-t border-border-subtle px-3 py-1.5">
        <button
          onClick={() => setAutomationsModalOpen(true)}
          className="w-full flex items-center gap-2 px-2 h-7 rounded text-[12px] text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors"
        >
          <Workflow size={12} className="shrink-0" />
          {tSidebar.automations}
        </button>
      </div>

      {/* ── Trash ── */}
      <div className="shrink-0 border-t border-border-subtle px-3 py-1.5">
        <button
          onClick={() => setTrashOpen(true)}
          className="w-full flex items-center gap-2 px-2 h-7 rounded text-[12px] text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors"
        >
          <Trash2 size={12} className="shrink-0" />
          {tSidebar.trash}
        </button>
      </div>

      {automationsModalOpen && <AutomationsModal onClose={() => setAutomationsModalOpen(false)} />}

      {/* ── Sharing ── */}
      <div className="shrink-0 border-t border-border-subtle px-3 py-2 flex flex-col gap-1">
        {sharingReconnecting ? (
          <div className="flex items-center gap-1.5 px-2 h-6 rounded bg-yellow-500/10 text-yellow-400 text-[11px]">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse shrink-0" />
            <span className="truncate flex-1">{tSidebar.sharingReconnecting}</span>
          </div>
        ) : sharingMode === "joined" ? (
          <div className="flex items-center gap-1.5 px-2 h-6 rounded bg-accent/10 text-accent text-[11px]">
            <Users size={11} className="shrink-0" />
            <span className="truncate flex-1">
              {remoteWorkspaceName ? `↔ ${remoteWorkspaceName}` : tSidebar.sharingConnectedAsGuest}
            </span>
            <button
              onClick={() => setJoinModalOpen(true)}
              className="text-text-muted hover:text-text-primary transition-colors"
              title={tSidebar.sharingManageConnection}
            >
              <X size={11} />
            </button>
          </div>
        ) : sharingMode === "hosting" ? (
          <button
            onClick={() => setShareModalOpen(true)}
            className="flex items-center gap-1.5 px-2 h-6 rounded bg-accent/10 text-accent text-[11px] hover:bg-accent/20 transition-colors"
          >
            <Share2 size={11} className="shrink-0" />
            <span className="flex-1 text-left truncate">
              {sharingWorkspaceIcon && sharingWorkspaceName
                ? `${sharingWorkspaceIcon} ${sharingWorkspaceName}`
                : tSidebar.sharingActiveShare}
              {sharingClients.length > 0 && ` · ${sharingClients.length} ${sharingClients.length > 1 ? tSidebar.sharingGuests : tSidebar.sharingGuest}`}
            </span>
          </button>
        ) : (
          <div className="flex gap-1">
            <button
              onClick={() => setShareModalOpen(true)}
              title={tSidebar.sharingShare}
              className="flex-1 flex items-center justify-center gap-1 h-6 rounded text-[11px] text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors"
            >
              <Share2 size={11} /> {tSidebar.sharingShare}
            </button>
            <button
              onClick={() => setJoinModalOpen(true)}
              title={tSidebar.sharingJoin}
              className="flex-1 flex items-center justify-center gap-1 h-6 rounded text-[11px] text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors"
            >
              <LogIn size={11} /> {tSidebar.sharingJoin}
            </button>
          </div>
        )}
      </div>

      {shareModalOpen && <ShareModal onClose={() => setShareModalOpen(false)} />}
      {joinModalOpen && <JoinModal onClose={() => setJoinModalOpen(false)} />}
      {trashOpen && <TrashModal onClose={() => setTrashOpen(false)} />}
    </aside>
  );
}
