import { invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import {
  ChevronLeft, ChevronRight, Code, File, FileImage, FileText, Film, Folder, Music, Network, X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import type { ListEntry } from "../types";

function TabIcon({ ext }: { ext: string }) {
  const e = ext.toLowerCase();
  if (["png","jpg","jpeg","gif","webp","svg","ico","bmp","avif"].includes(e))
    return <FileImage size={12} className="text-pink-400 shrink-0" />;
  if (["mp4","mkv","avi","mov","webm","m4v"].includes(e))
    return <Film size={12} className="text-purple-400 shrink-0" />;
  if (["mp3","wav","flac","ogg","m4a","aac","opus"].includes(e))
    return <Music size={12} className="text-cyan-400 shrink-0" />;
  if (["ts","tsx","js","jsx","rs","py","go","java","c","cpp","h","css","html","json","toml","yaml","sh","md"].includes(e))
    return <Code size={12} className="text-green-400 shrink-0" />;
  if (["pdf","doc","docx","odt","rtf","txt"].includes(e))
    return <FileText size={12} className="text-blue-400 shrink-0" />;
  return <File size={12} className="text-text-muted shrink-0" />;
}

function folderName(path: string) {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "Explorateur";
}

// ─── Folder tab context menu ──────────────────────────────────────────────────
function FolderTabMenu({
  x, y, path, onClose,
}: {
  x: number; y: number; path: string; onClose: () => void;
}) {
  const { contexts, addFolderToContext } = useStore();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", handler, true);
    return () => window.removeEventListener("mousedown", handler, true);
  }, [onClose]);

  const menuW = 200;
  const left = Math.min(x, window.innerWidth - menuW - 8);

  return (
    <div
      ref={ref}
      style={{ position: "fixed", top: y, left, minWidth: menuW, zIndex: 9999 }}
      className="bg-surface-2 border border-border rounded-lg shadow-2xl py-1 overflow-hidden"
    >
      <button
        onClick={() => {
          invoke("open_new_window", { mode: "folder", path }).catch(console.error);
          onClose();
        }}
        className="w-full flex items-center gap-2 px-3 h-7 text-left text-[12px] text-text-secondary hover:bg-surface-3 hover:text-text-primary transition-colors"
      >
        Ouvrir dans une nouvelle fenêtre
      </button>
      <div className="my-1 border-t border-border-subtle" />
      <p className="px-3 py-1 text-[10px] text-text-muted uppercase tracking-widest">Add to workspace</p>
      {contexts.map((ctx) => (
        <button
          key={ctx.id}
          onClick={async () => {
            const alreadyIn = ctx.watched_paths.includes(path);
            if (!alreadyIn) {
              addFolderToContext(ctx.id, path);
              const newPaths = [...ctx.watched_paths, path];
              await invoke("update_context", {
                id: ctx.id, name: ctx.name, icon: ctx.icon,
                watchedPaths: newPaths, lastPath: ctx.last_path,
                activeTagIds: ctx.pinned_tag_ids,
              }).catch(console.error);
              await invoke("watch_directory", { path }).catch(console.error);
            }
            onClose();
          }}
          className="w-full flex items-center gap-2 px-3 h-7 text-left text-[12px] text-text-secondary hover:bg-surface-3 hover:text-text-primary transition-colors"
        >
          <span className="text-[12px]">{ctx.icon}</span>
          <span className="truncate">{ctx.name}</span>
          {ctx.watched_paths.includes(path) && (
            <span className="ml-auto text-[10px] text-text-muted">✓</span>
          )}
        </button>
      ))}
    </div>
  );
}

// ─── File tab context menu ────────────────────────────────────────────────────
function FileTabMenu({
  x, y, filePath, onClose,
}: {
  x: number; y: number; filePath: string; onClose: () => void;
}) {
  const { contexts, addFileTabToContext } = useStore();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", handler, true);
    return () => window.removeEventListener("mousedown", handler, true);
  }, [onClose]);

  const menuW = 200;
  const left = Math.min(x, window.innerWidth - menuW - 8);

  const fileExt = filePath.replace(/\\/g, "/").split("/").pop()?.split(".").pop() ?? "";
  const fileName = filePath.replace(/\\/g, "/").split("/").pop() ?? "";

  return (
    <div
      ref={ref}
      style={{ position: "fixed", top: y, left, minWidth: menuW, zIndex: 9999 }}
      className="bg-surface-2 border border-border rounded-lg shadow-2xl py-1 overflow-hidden"
    >
      <button
        onClick={() => {
          invoke("open_new_window", { mode: "file", path: filePath, name: fileName, ext: fileExt }).catch(console.error);
          onClose();
        }}
        className="w-full flex items-center gap-2 px-3 h-7 text-left text-[12px] text-text-secondary hover:bg-surface-3 hover:text-text-primary transition-colors"
      >
        Ouvrir dans une nouvelle fenêtre
      </button>
      <div className="my-1 border-t border-border-subtle" />
      <p className="px-3 py-1 text-[10px] text-text-muted uppercase tracking-widest">Ajouter au workspace</p>
      {contexts.map((ctx) => {
        const alreadyIn = (ctx.open_file_tabs ?? []).includes(filePath);
        return (
          <button
            key={ctx.id}
            onClick={async () => {
              if (!alreadyIn) {
                addFileTabToContext(ctx.id, filePath);
                const newFileTabs = [...(ctx.open_file_tabs ?? []), filePath];
                await invoke("update_context", {
                  id: ctx.id, name: ctx.name, icon: ctx.icon,
                  watchedPaths: ctx.watched_paths, lastPath: ctx.last_path,
                  activeTagIds: ctx.pinned_tag_ids,
                  openTabs: ctx.open_tabs ?? [], openFileTabs: newFileTabs,
                }).catch(console.error);
              }
              onClose();
            }}
            className="w-full flex items-center gap-2 px-3 h-7 text-left text-[12px] text-text-secondary hover:bg-surface-3 hover:text-text-primary transition-colors"
          >
            <span className="text-[12px]">{ctx.icon}</span>
            <span className="truncate flex-1">{ctx.name}</span>
            {alreadyIn && <span className="text-[10px] text-text-muted">✓</span>}
          </button>
        );
      })}
    </div>
  );
}

// ─── Dirty-close confirmation dialog ─────────────────────────────────────────
function DirtyCloseDialog({
  fileName, onSave, onDiscard, onCancel,
}: {
  fileName: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onSave();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onSave, onCancel]);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50">
      <div className="bg-surface-1 border border-border rounded-xl shadow-2xl w-80 p-5 flex flex-col gap-4">
        <div>
          <p className="text-[13px] font-semibold text-text-primary">Unsaved changes</p>
          <p className="text-[12px] text-text-secondary mt-1">
            Save changes to <strong className="text-text-primary">{fileName}</strong> before closing?
          </p>
        </div>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-3 h-7 rounded text-[12px] text-text-secondary hover:bg-surface-3 transition-colors"
          >Cancel</button>
          <button
            onClick={onDiscard}
            className="px-3 h-7 rounded text-[12px] text-red-400 hover:bg-red-500/10 transition-colors"
          >Discard</button>
          <button
            onClick={onSave}
            className="px-3 h-7 rounded text-[12px] bg-accent text-white hover:bg-accent/80 transition-colors"
          >Save & Close</button>
        </div>
      </div>
    </div>
  );
}

export function TabBar() {
  const {
    tabs, activeTabId, setActiveTab, closeTab, closeFile,
    folderTabs, activeFolderTabId, switchFolderTab, closeFolderTab,
    setListEntries, currentPath, openFolderTab, activeContextId,
    tabOrder, reorderAllTabs,
  } = useStore();

  const isExplorerActive = activeTabId === null;

  const [folderTabMenu, setFolderTabMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [fileTabMenu, setFileTabMenu] = useState<{ x: number; y: number; filePath: string } | null>(null);
  const [dirtyClose, setDirtyClose] = useState<{ id: string; name: string; content: string | null } | null>(null);
  const [draggingGlobalIdx, setDraggingGlobalIdx] = useState<number | null>(null);
  const [dragOverGlobalIdx, setDragOverGlobalIdx] = useState<number | null>(null);
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null);
  const [ghostItem, setGhostItem] = useState<{ type: "folder" | "file"; label: string; ext: string } | null>(null);
  const tabDragRef = useRef<{
    pending: { startX: number; startY: number; idx: number } | null;
    active: boolean;
    fromIdx: number | null;
    overIdx: number | null;
    didDrag: boolean;
  }>({ pending: null, active: false, fromIdx: null, overIdx: null, didDrag: false });
  const TAB_DRAG_THRESHOLD = 5;
  const tabCleanupRef = useRef<(() => void) | null>(null);

  // Build a unified ordered list of all tabs, reconciling any entries added outside of tabOrder
  const orderedItems = (() => {
    type Item = { type: "folder"; tab: typeof folderTabs[0] } | { type: "file"; tab: typeof tabs[0] };
    const result: Item[] = [];
    const seenFolder = new Set<string>();
    const seenFile = new Set<string>();
    for (const entry of tabOrder) {
      if (entry.type === "folder") {
        const t = folderTabs.find((ft) => ft.id === entry.id);
        if (t) { result.push({ type: "folder", tab: t }); seenFolder.add(t.id); }
      } else {
        const t = tabs.find((ft) => ft.id === entry.id);
        if (t) { result.push({ type: "file", tab: t }); seenFile.add(t.id); }
      }
    }
    for (const t of folderTabs) if (!seenFolder.has(t.id)) result.push({ type: "folder", tab: t });
    for (const t of tabs) if (!seenFile.has(t.id)) result.push({ type: "file", tab: t });
    return result;
  })();

  const startTabDrag = (
    e: React.MouseEvent<HTMLDivElement>,
    globalIdx: number,
    onMiddleClick?: () => void,
  ) => {
    if (e.button === 1) { e.preventDefault(); onMiddleClick?.(); return; }
    if (e.button !== 0) return;
    if (orderedItems.length < 2) return;

    const d = tabDragRef.current;
    d.pending = { startX: e.clientX, startY: e.clientY, idx: globalIdx };
    d.didDrag = false;

    const onMouseMove = (ev: MouseEvent) => {
      if (!d.pending && !d.active) return;
      if (d.pending && !d.active) {
        if (Math.abs(ev.clientX - d.pending.startX) > TAB_DRAG_THRESHOLD) {
          d.active = true;
          d.fromIdx = d.pending.idx;
          d.overIdx = d.pending.idx;
          d.pending = null;
          setDraggingGlobalIdx(d.fromIdx);
          setDragOverGlobalIdx(d.fromIdx);
          const item = orderedItems[globalIdx];
          if (item) {
            setGhostItem({
              type: item.type,
              label: item.type === "folder" ? folderName(item.tab.path) : item.tab.file.name,
              ext: item.type === "file" ? item.tab.file.extension : "",
            });
          }
        }
      }
      if (d.active) {
        setGhostPos({ x: ev.clientX, y: ev.clientY });
        const els = document.elementsFromPoint(ev.clientX, ev.clientY);
        for (const el of els) {
          const idxStr = (el as HTMLElement).dataset?.tabGlobalIdx;
          if (idxStr !== undefined) {
            const over = parseInt(idxStr, 10);
            if (!isNaN(over) && over !== d.overIdx) { d.overIdx = over; setDragOverGlobalIdx(over); }
            break;
          }
        }
      }
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      tabCleanupRef.current = null;
      d.pending = null;
      setGhostPos(null);
      setGhostItem(null);
      if (d.active) {
        d.active = false;
        d.didDrag = true;
        const from = d.fromIdx;
        const to = d.overIdx;
        if (from !== null && to !== null && from !== to) {
          reorderAllTabs(from, to);
        }
        d.fromIdx = null;
        d.overIdx = null;
        setDraggingGlobalIdx(null);
        setDragOverGlobalIdx(null);
      }
    };

    tabCleanupRef.current = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  useEffect(() => () => { tabCleanupRef.current?.(); }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };

  useLayoutEffect(() => {
    updateScrollState();
    const ro = new ResizeObserver(updateScrollState);
    if (scrollRef.current) ro.observe(scrollRef.current);
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, folderTabs]);

  const scrollTabs = (dir: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * 160, behavior: "smooth" });
  };

  // Check if a tab is dirty before closing; show dialog if so
  const tryCloseTab = (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (tab?.isDirty) {
      setDirtyClose({ id, name: tab.file.name, content: tab.draftContent });
    } else {
      closeTab(id);
    }
  };

  const tryCloseFile = () => {
    if (activeTabId === null) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab?.isDirty) {
      setDirtyClose({ id: activeTabId, name: tab.file.name, content: tab.draftContent });
    } else {
      closeFile();
    }
  };

  const handleFolderTabClick = async (tabId: string) => {
    const tab = folderTabs.find((t) => t.id === tabId);
    const path = switchFolderTab(tabId);
    setActiveTab(null);
    try {
      if (tab?.isRemote) {
        const entries = await invoke<ListEntry[]>("list_remote_dir", { path });
        setListEntries(entries);
      } else {
        const entries = await invoke<ListEntry[]>("list_directory", { path, contextId: activeContextId ?? 0 });
        setListEntries(entries);
      }
    } catch { /* folder may have moved */ }
  };

  const handleCloseFolderTab = async (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation();
    const tab = folderTabs.find((t) => t.id === tabId);
    const path = closeFolderTab(tabId);
    setActiveTab(null);
    if (path) {
      try {
        const newActive = folderTabs.find((t) => t.path === path && t.id !== tabId);
        if (newActive?.isRemote ?? tab?.isRemote) {
          const entries = await invoke<ListEntry[]>("list_remote_dir", { path });
          setListEntries(entries);
        } else {
          const entries = await invoke<ListEntry[]>("list_directory", { path, contextId: activeContextId ?? 0 });
          setListEntries(entries);
        }
      } catch { /* ignore */ }
    }
  };

  // Ctrl+W → dirty-aware close; Ctrl+Tab → cycle; Ctrl+T → new tab
  useEffect(() => {
    const allIds: Array<string | null> = [null, ...tabs.map((t) => t.id)];

    const handler = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;

      if ((e.ctrlKey || e.metaKey) && e.key === "w") {
        e.preventDefault();
        if (activeTabId !== null) tryCloseFile();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "t") {
        e.preventDefault();
        if (currentPath) openFolderTab(currentPath);
      }
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        if (allIds.length < 2) return;
        const idx = allIds.indexOf(activeTabId);
        const next = allIds[(idx + (e.shiftKey ? allIds.length - 1 : 1)) % allIds.length];
        setActiveTab(next);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, activeTabId, currentPath]);

  return (
    <>
      <div className="flex items-end bg-surface-1 border-b border-border-subtle shrink-0 h-9 min-h-[36px] relative">
        {/* Left scroll button */}
        {canScrollLeft && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => scrollTabs(-1)}
            className="absolute left-0 top-0 bottom-0 z-10 w-6 flex items-center justify-center bg-surface-1 hover:bg-surface-2 text-text-muted hover:text-text-primary border-r border-border-subtle transition-colors shrink-0"
          >
            <ChevronLeft size={12} />
          </button>
        )}
        {/* Right scroll button */}
        {canScrollRight && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => scrollTabs(1)}
            className="absolute right-0 top-0 bottom-0 z-10 w-6 flex items-center justify-center bg-surface-1 hover:bg-surface-2 text-text-muted hover:text-text-primary border-l border-border-subtle transition-colors shrink-0"
          >
            <ChevronRight size={12} />
          </button>
        )}
        <div
          ref={scrollRef}
          onScroll={updateScrollState}
          onWheel={(e) => {
            e.preventDefault();
            scrollRef.current!.scrollBy({ left: e.deltaY, behavior: "auto" });
            updateScrollState();
          }}
          className="flex items-end h-full w-full overflow-x-auto"
          style={{ scrollbarWidth: "none" }}
        >
        {/* Fallback "Explorateur" tab when no folder tabs exist */}
        {folderTabs.length === 0 && (
          <div
            onClick={() => setActiveTab(null)}
            className={clsx(
              "group flex items-center gap-1.5 px-3 h-full border-r border-border-subtle cursor-pointer shrink-0 max-w-[200px] relative select-none transition-colors",
              isExplorerActive
                ? "bg-surface-0 text-text-primary"
                : "text-text-muted hover:bg-surface-2 hover:text-text-secondary"
            )}
          >
            {isExplorerActive && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-accent" />}
            <Folder size={12} className="text-yellow-400 shrink-0" />
            <span className="text-[11px] truncate">Explorateur</span>
          </div>
        )}

        {/* Unified ordered tab list (folder + file interleaved) */}
        {orderedItems.map((item, globalIdx) => {
          const isDragging = draggingGlobalIdx === globalIdx;
          const isDropTarget = dragOverGlobalIdx === globalIdx && draggingGlobalIdx !== null && draggingGlobalIdx !== globalIdx;
          // insertion bar: right edge when moving forward, left edge when moving backward
          const insertAfter = isDropTarget && draggingGlobalIdx !== null && draggingGlobalIdx < globalIdx;

          if (item.type === "folder") {
            const tab = item.tab;
            const isActive = isExplorerActive && tab.id === activeFolderTabId;
            const canClose = folderTabs.length > 1;
            return (
              <div
                key={tab.id}
                data-tab-global-idx={String(globalIdx)}
                onClick={() => {
                  if (tabDragRef.current.didDrag) { tabDragRef.current.didDrag = false; return; }
                  handleFolderTabClick(tab.id);
                }}
                onMouseDown={(e) => startTabDrag(e, globalIdx, () => handleCloseFolderTab(e, tab.id))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setFolderTabMenu({ x: e.clientX, y: e.clientY + 4, path: tab.path });
                }}
                title={tab.path}
                className={clsx(
                  "group flex items-center gap-1.5 px-3 h-full border-r border-border-subtle cursor-pointer shrink-0 max-w-[200px] relative select-none transition-colors",
                  isActive
                    ? "bg-surface-0 text-text-primary"
                    : "text-text-muted hover:bg-surface-2 hover:text-text-secondary",
                  isDragging && "opacity-40",
                )}
              >
                {isActive && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-accent" />}
                {isDropTarget && (
                  <span
                    className="absolute top-[20%] bottom-[20%] w-[2px] bg-accent rounded-full z-10 pointer-events-none"
                    style={{ [insertAfter ? "right" : "left"]: "0" }}
                  />
                )}
                {tab.isRemote
                  ? <Network size={12} className="text-accent shrink-0" />
                  : <Folder size={12} className="text-yellow-400 shrink-0" />}
                <span className="text-[11px] truncate flex-1 min-w-0">{folderName(tab.path)}</span>
                {canClose && (
                  <button
                    onClick={(e) => handleCloseFolderTab(e, tab.id)}
                    className={clsx(
                      "w-4 h-4 flex items-center justify-center rounded transition-all shrink-0",
                      "hover:bg-surface-4 hover:text-text-primary",
                      isActive
                        ? "opacity-60 hover:opacity-100"
                        : "opacity-0 group-hover:opacity-60 group-hover:hover:opacity-100"
                    )}
                    title="Fermer l'onglet"
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
            );
          } else {
            const tab = item.tab;
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                data-tab-global-idx={String(globalIdx)}
                onClick={() => {
                  if (tabDragRef.current.didDrag) { tabDragRef.current.didDrag = false; return; }
                  setActiveTab(tab.id);
                }}
                onMouseDown={(e) => startTabDrag(e, globalIdx, () => tryCloseTab(tab.id))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setFileTabMenu({ x: e.clientX, y: e.clientY + 4, filePath: tab.id });
                }}
                title={tab.id}
                className={clsx(
                  "group flex items-center gap-1.5 px-3 h-full border-r border-border-subtle cursor-pointer shrink-0 max-w-[180px] relative select-none transition-colors",
                  isActive
                    ? "bg-surface-0 text-text-primary"
                    : "text-text-muted hover:bg-surface-2 hover:text-text-secondary",
                  isDragging && "opacity-40",
                )}
              >
                {isActive && <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-accent" />}
                {isDropTarget && (
                  <span
                    className="absolute top-[20%] bottom-[20%] w-[2px] bg-accent rounded-full z-10 pointer-events-none"
                    style={{ [insertAfter ? "right" : "left"]: "0" }}
                  />
                )}
                <TabIcon ext={tab.file.extension} />
                <span className="text-[11px] truncate flex-1 min-w-0">{tab.file.name}</span>
                {tab.isDirty && (
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); tryCloseTab(tab.id); }}
                  className={clsx(
                    "w-4 h-4 flex items-center justify-center rounded transition-all shrink-0",
                    "hover:bg-surface-4 hover:text-text-primary",
                    tab.isDirty || isActive
                      ? "opacity-60 hover:opacity-100"
                      : "opacity-0 group-hover:opacity-60 group-hover:hover:opacity-100"
                  )}
                  title="Fermer (Ctrl+W)"
                >
                  <X size={10} />
                </button>
              </div>
            );
          }
        })}

        <div className="flex-1 min-w-4 h-full" />
        </div>{/* end scroll inner div */}
      </div>

      {/* Folder tab context menu */}
      {folderTabMenu && (
        <FolderTabMenu
          x={folderTabMenu.x}
          y={folderTabMenu.y}
          path={folderTabMenu.path}
          onClose={() => setFolderTabMenu(null)}
        />
      )}

      {/* File tab context menu */}
      {fileTabMenu && (
        <FileTabMenu
          x={fileTabMenu.x}
          y={fileTabMenu.y}
          filePath={fileTabMenu.filePath}
          onClose={() => setFileTabMenu(null)}
        />
      )}

      {/* Drag ghost */}
      {ghostPos && ghostItem && (
        <div
          style={{ position: "fixed", left: ghostPos.x + 10, top: ghostPos.y - 16, pointerEvents: "none", zIndex: 9999 }}
          className="flex items-center gap-1.5 px-3 h-7 bg-surface-2 border border-accent/50 rounded shadow-xl text-text-primary opacity-90 select-none"
        >
          {ghostItem.type === "folder"
            ? <Folder size={12} className="text-yellow-400 shrink-0" />
            : <TabIcon ext={ghostItem.ext} />}
          <span className="text-[11px] truncate max-w-[150px]">{ghostItem.label}</span>
        </div>
      )}

      {/* Dirty-close confirmation */}
      {dirtyClose && (
        <DirtyCloseDialog
          fileName={dirtyClose.name}
          onCancel={() => setDirtyClose(null)}
          onDiscard={() => { closeTab(dirtyClose.id); setDirtyClose(null); }}
          onSave={async () => {
            if (dirtyClose.content !== null) {
              await invoke("write_file", { path: dirtyClose.id, content: dirtyClose.content }).catch(console.error);
            }
            closeTab(dirtyClose.id);
            setDirtyClose(null);
          }}
        />
      )}
    </>
  );
}
