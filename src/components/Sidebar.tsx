import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { clsx } from "clsx";
import {
  Check, ChevronDown, ChevronRight, ChevronUp,
  File, Folder, FolderPlus, Hash, LogIn, Plus, Share2, Tag, Trash2, Users, X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import type { Context, FileEntry, ListEntry, PinnedItem, Tag as TagType } from "../types";
import { JoinModal } from "./JoinModal";
import { ShareModal } from "./ShareModal";

function folderName(path: string) {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

// ─── Folder tree node ─────────────────────────────────────────────────────────
function FolderNode({
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
}

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
  contexts, activeId, onSwitch, onCreate, onDelete, onEdit,
}: {
  contexts: Context[];
  activeId: number | null;
  onSwitch: (ctx: Context) => void;
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
        <span className="text-[14px] shrink-0">{active?.icon ?? "📁"}</span>
        <span className="flex-1 text-[12px] font-medium text-text-primary truncate text-left">
          {active?.name ?? "No workspace"}
        </span>
        <ChevronUp size={11} className={clsx("text-text-muted transition-transform shrink-0", open && "rotate-180")} />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full left-0 right-0 z-50 bg-surface-2 border border-border rounded-b-lg shadow-2xl py-1 overflow-hidden">
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
                  {ctx.id === activeId
                    ? <Check size={11} className="text-accent shrink-0" />
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
    <div className={clsx(
      "group flex items-center gap-1.5 h-6 px-2 rounded cursor-pointer select-none transition-colors",
      isActive ? "bg-surface-3 text-text-primary" : "text-text-secondary hover:bg-surface-3"
    )}>
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

// ─── Main Sidebar ─────────────────────────────────────────────────────────────
export function Sidebar() {
  const {
    tags, setTags, selectedTagIds, toggleTagFilter, clearTagFilters,
    currentPath, setCurrentPath, setListEntries,
    setFiles, setTags: _setTags, setIsScanning, selectFile, pushNav,
    contexts, setContexts, activeContextId,
    addFolderToContext, removeFolderFromContext, switchWorkspace,
    pinnedItems, setPinnedItems, removePinnedItem,
    folderTabs, tabs,
    sharingMode, sharingClients, shareModalOpen, joinModalOpen,
    setShareModalOpen, setJoinModalOpen,
  } = useStore();

  const [showNewTag, setShowNewTag] = useState(false);
  const [newTagName, setNewTagName] = useState("");

  const activeCtx = contexts.find((c) => c.id === activeContextId) ?? null;

  // Load on mount
  useEffect(() => {
    Promise.all([
      invoke<Context[]>("get_contexts"),
      invoke<PinnedItem[]>("get_pinned_items"),
      invoke<TagType[]>("get_tags"),
    ]).then(([ctxs, pins, tagList]) => {
      setContexts(ctxs);
      setPinnedItems(pins);
      setTags(tagList);
    }).catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigateTo = async (path: string) => {
    setCurrentPath(path);
    pushNav(path);
    try {
      const entries = await invoke<ListEntry[]>("list_directory", { path });
      setListEntries(entries);
      selectFile(null);
    } catch (e) { console.error(e); }
  };

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
        const entries = await invoke<ListEntry[]>("list_directory", { path: target });
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
      // setContexts derives activeContextId from is_active — new workspace is now active
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
      const entries = await invoke<ListEntry[]>("list_directory", { path: selected });
      setListEntries(entries); selectFile(null);
    } catch { /* ignore */ }

    setIsScanning(true);
    invoke<FileEntry[]>("scan_directory", { path: selected })
      .then(async (files) => {
        setFiles(files);
        const tl = await invoke<TagType[]>("get_tags"); _setTags(tl);
        const entries = await invoke<ListEntry[]>("list_directory", { path: selected as string });
        setListEntries(entries);
      })
      .catch(console.error)
      .finally(() => setIsScanning(false));
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
      await invoke("create_tag", { name: newTagName.trim() });
      const updated = await invoke<TagType[]>("get_tags");
      setTags(updated);
      setNewTagName(""); setShowNewTag(false);
    } catch (e) { console.error(e); }
  };

  // ── Pinned ────────────────────────────────────────────────────────────────
  const handleUnpin = async (path: string) => {
    await invoke("unpin_item", { path }).catch(console.error);
    removePinnedItem(path);
  };

  return (
    <aside className="flex flex-col w-[210px] bg-surface-1 border-r shrink-0 overflow-hidden"
      style={{ borderColor: "#1f1f1f" }}>

      {/* ── Workspace switcher ── */}
      <WorkspaceSwitcher
        contexts={contexts}
        activeId={activeContextId}
        onSwitch={handleSwitch}
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
            <p className="text-[11px] text-text-muted text-center py-3">No workspace selected</p>
          ) : activeCtx.watched_paths.length === 0 ? (
            <button onClick={handleAddFolder}
              className="w-full flex items-center gap-2 px-2 h-7 rounded border border-dashed border-border text-text-muted hover:border-accent hover:text-accent text-[11px] transition-colors">
              <Plus size={11} /> Add a folder
            </button>
          ) : (
            <div className="flex flex-col gap-0.5">
              {activeCtx.watched_paths.map((p) => (
                <div key={p} className="group/root flex items-center">
                  <div className="flex-1 min-w-0">
                    <FolderNode path={p} name={folderName(p)} depth={0}
                      currentPath={currentPath} onNavigate={navigateTo} />
                  </div>
                  <button
                    onClick={() => handleRemoveFolder(p)}
                    title="Remove from workspace"
                    className="opacity-0 group-hover/root:opacity-100 w-4 h-4 flex items-center justify-center shrink-0 text-text-muted hover:text-red-400 transition-all mr-0.5"
                  ><X size={9} /></button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Pinned ── */}
        {pinnedItems.length > 0 && (
          <>
            <div className="h-px bg-border-subtle mx-3" />
            <div className="px-3 py-2">
              <SectionHeader label="Pinned" />
              <div className="flex flex-col gap-0.5">
                {pinnedItems.map((item) => (
                  <PinnedRow key={item.path} item={item} currentPath={currentPath}
                    onNavigate={navigateTo} onUnpin={() => handleUnpin(item.path)} />
                ))}
              </div>
            </div>
          </>
        )}

        {/* ── Tags ── */}
        <div className="h-px bg-border-subtle mx-3" />
        <div className="px-3 py-2 pb-4">
          <SectionHeader label="Tags" action={
            <button onClick={() => setShowNewTag((v) => !v)}
              className="w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors">
              <Plus size={11} />
            </button>
          } />
          {showNewTag && (
            <input autoFocus type="text" value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateTag(); if (e.key === "Escape") setShowNewTag(false); }}
              placeholder="Tag name…"
              className="w-full h-6 px-2 mt-1 mb-2 rounded bg-surface-3 border border-border text-[11px] text-text-primary placeholder-text-muted outline-none focus:border-accent" />
          )}
          <button onClick={clearTagFilters}
            className={clsx("w-full flex items-center gap-2 px-2 h-6 rounded text-[12px] transition-colors",
              selectedTagIds.length === 0 ? "text-text-primary bg-surface-3" : "text-text-secondary hover:bg-surface-3")}>
            <Hash size={12} className="text-text-muted" /> All files
          </button>
          <div className="mt-1 flex flex-col gap-0.5">
            {tags.map((tag) => (
              <button key={tag.id} onClick={() => toggleTagFilter(tag.id)}
                className={clsx("w-full flex items-center gap-2 px-2 h-6 rounded text-[12px] transition-colors",
                  selectedTagIds.includes(tag.id) ? "text-text-primary bg-surface-3" : "text-text-secondary hover:bg-surface-3")}>
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: tag.color }} />
                <span className="truncate">{tag.name}</span>
              </button>
            ))}
          </div>
          {tags.length === 0 && (
            <div className="mt-2 flex flex-col items-center gap-1 text-center">
              <Tag size={18} className="text-text-muted opacity-30" />
              <span className="text-[10px] text-text-muted">No tags yet</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Sharing ── */}
      <div className="shrink-0 border-t border-border-subtle px-3 py-2 flex flex-col gap-1">
        {sharingMode === "joined" ? (
          <div className="flex items-center gap-1.5 px-2 h-6 rounded bg-accent/10 text-accent text-[11px]">
            <Users size={11} className="shrink-0" />
            <span className="truncate flex-1">Connecté en tant qu'invité</span>
            <button
              onClick={() => setJoinModalOpen(true)}
              className="text-text-muted hover:text-text-primary transition-colors"
              title="Gérer la connexion"
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
              Partage actif
              {sharingClients.length > 0 && ` · ${sharingClients.length} invité${sharingClients.length > 1 ? "s" : ""}`}
            </span>
          </button>
        ) : (
          <div className="flex gap-1">
            <button
              onClick={() => setShareModalOpen(true)}
              title="Partager ce workspace"
              className="flex-1 flex items-center justify-center gap-1 h-6 rounded text-[11px] text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors"
            >
              <Share2 size={11} /> Partager
            </button>
            <button
              onClick={() => setJoinModalOpen(true)}
              title="Rejoindre un workspace partagé"
              className="flex-1 flex items-center justify-center gap-1 h-6 rounded text-[11px] text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors"
            >
              <LogIn size={11} /> Rejoindre
            </button>
          </div>
        )}
      </div>

      {shareModalOpen && <ShareModal onClose={() => setShareModalOpen(false)} />}
      {joinModalOpen && <JoinModal onClose={() => setJoinModalOpen(false)} />}
    </aside>
  );
}
