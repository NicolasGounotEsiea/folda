import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, Clock, Eye, EyeOff, LayoutGrid, List, Search, Settings, Columns2, BarChart2, Sparkles, StickyNote } from "lucide-react";
import { startTransition, useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { useViewerFindStore } from "../store/useViewerFindStore";
import type { ListEntry, SearchHit } from "../types";
import { clsx } from "clsx";
import { useTranslation } from "../utils/i18n";

type SearchType = "all" | "files" | "folders";

function useDebounce(fn: (...args: unknown[]) => void, delay: number) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (...args: unknown[]) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => fn(...args), delay);
  };
}

export function Toolbar({
  onOpenSettings, onOpenDiskUsage, onOpenAi, aiActive,
  onOpenNotes, notesActive, notesPendingCount,
}: {
  onOpenSettings: () => void;
  onOpenDiskUsage?: () => void;
  onOpenAi?: () => void;
  aiActive?: boolean;
  onOpenNotes?: () => void;
  notesActive?: boolean;
  notesPendingCount?: number;
}) {
  const {
    searchQuery, setSearchQuery,
    searchType, setSearchType,
    viewMode, setViewMode,
    layoutMode, setLayoutMode,
    setListEntries,
    setCurrentPath, currentPath, rootPaths,
    isWatching, selectFile, pushNav,
    showHidden, toggleShowHidden,
    activeContextId,
    dualPaneActive, setDualPaneActive,
    activePaneIndex, pane2Path, setPane2Path, pushNav2, setPane2Entries,
  } = useStore();

  const t = useTranslation();
  const searchRef = useRef<HTMLInputElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const [pathInputMode, setPathInputMode] = useState(false);
  const [pathInputValue, setPathInputValue] = useState("");

  const activePane2 = dualPaneActive && activePaneIndex === 1;
  const activePath = activePane2 ? pane2Path : currentPath;

  const enterPathMode = () => {
    setPathInputValue(activePath ?? "");
    setPathInputMode(true);
    setTimeout(() => { pathInputRef.current?.select(); }, 0);
  };

  const commitPath = async (raw: string) => {
    setPathInputMode(false);
    const p = raw.trim();
    if (!p || p === activePath) return;
    try {
      const entries = await invoke<import("../types").ListEntry[]>("list_directory", { path: p, contextId: activeContextId ?? 0 });
      if (activePane2) { setPane2Path(p); pushNav2(p); setPane2Entries(entries); }
      else { setCurrentPath(p); pushNav(p); setListEntries(entries); selectFile(null); }
    } catch { /* invalid path — silently ignore */ }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        // If a viewer registered a find handler (text editor, spreadsheet,
        // future PDF/DOCX), defer to it — Ctrl+F should mean "find in this
        // document" first, not "focus the global search bar". Falls back to
        // the global bar when no viewer is mounted or it doesn't support find.
        const viewerFind = useViewerFindStore.getState().handler;
        if (viewerFind) {
          viewerFind();
        } else {
          searchRef.current?.focus();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Each setListEntries below is wrapped in startTransition so the heavy
  // FileList + Sidebar re-render triggered by results landing is treated as
  // low-priority. Without this, a fast typer's next keystroke can stall while
  // React commits 500+ search hits to the DOM.
  const runSearch = async (q: string, type: SearchType) => {
    if (!q.trim()) {
      if (currentPath) {
        try {
          const entries = await invoke<ListEntry[]>("list_directory", { path: currentPath, contextId: activeContextId ?? 0 });
          startTransition(() => setListEntries(entries));
        } catch { /* ignore */ }
      }
      return;
    }
    try {
      const [fileEntries, folderEntries] = await Promise.all([
        type !== "folders"
          ? invoke<SearchHit[]>("search_files", { query: q }).then((hits) =>
              hits.map((f): ListEntry => ({
                is_dir: false, name: f.name, path: f.path, size: f.size,
                created_at: f.created_at, modified_at: f.modified_at, extension: f.extension, id: f.id, tags: f.tags,
                // Surface the origin + excerpt so the FileList row can show
                // both the "contenu" badge AND the highlighted snippet under
                // the file name (when match came from indexed content).
                matched_content: f.matched_content,
                match_snippet: f.snippet ?? undefined,
              }))
            )
          : Promise.resolve([] as ListEntry[]),
        type !== "files"
          ? invoke<ListEntry[]>("search_folders", { query: q })
          : Promise.resolve([] as ListEntry[]),
      ]);
      startTransition(() => setListEntries([...folderEntries, ...fileEntries]));
    } catch (e) {
      console.error(e);
    }
  };

  // The input is bound to local state so typing never triggers a global
  // store update. Without this, every keystroke fires setSearchQuery() →
  // re-renders every component that subscribes to the whole store
  // (Sidebar, PreviewPanel, this Toolbar itself), and the input's visual
  // update lags 50–200 ms behind the keystroke on heavy workspaces.
  // The debounced callback below pushes the value to the global store +
  // kicks off the actual search 200 ms after the user stops typing.
  const [searchInput, setSearchInput] = useState(searchQuery);

  // Sync external clears (Escape from another viewer, navigation, etc.)
  // back into the local input. Skipped when the change came from typing
  // because by then local and global already agree.
  useEffect(() => {
    setSearchInput((prev) => (prev === searchQuery ? prev : searchQuery));
  }, [searchQuery]);

  // startTransition tells React the global store update + search are LOW
  // priority. If the user types another character while React is mid-commit
  // of these heavy updates, the keystroke is treated as urgent and gets
  // processed first — the visual input update never blocks behind the search.
  // Without this, a fast typer who pauses 200 ms triggers the debounce, which
  // re-renders Sidebar/App/PreviewPanel, and the next keystroke waits.
  const debouncedSearch = useDebounce((q: unknown, type: unknown) => {
    startTransition(() => {
      setSearchQuery(q as string);
      runSearch(q as string, type as SearchType);
    });
  }, 250);

  const handleSearch = (q: string) => {
    setSearchInput(q);
    debouncedSearch(q, searchType);
  };

  const handleTypeChange = (type: SearchType) => {
    setSearchType(type);
    if (searchInput.trim()) runSearch(searchInput, type);
  };

  // Build breadcrumb from the active pane's path
  const breadcrumb = (() => {
    if (!activePath) return [];
    const cur = activePath.replace(/\\/g, "/");
    const root = rootPaths
      .map((p) => p.replace(/\\/g, "/"))
      .find((p) => cur === p || cur.startsWith(p + "/"));
    if (!root) return [{ label: cur.split("/").pop() ?? cur, path: activePath }];
    const rootParts = root.split("/");
    const curParts = cur.split("/");
    return curParts.slice(rootParts.length - 1).map((label, i) => ({
      label,
      path: curParts.slice(0, rootParts.length - 1 + i + 1).join("/").replace(/\//g, "\\"),
    }));
  })();

  const navigateTo = async (path: string) => {
    setSearchQuery("");
    try {
      const entries = await invoke<ListEntry[]>("list_directory", { path, contextId: activeContextId ?? 0 });
      if (activePane2) { setPane2Path(path); pushNav2(path); setPane2Entries(entries); }
      else { setCurrentPath(path); pushNav(path); setListEntries(entries); selectFile(null); }
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="flex items-center gap-2 px-3 h-[48px] bg-surface-1 border-b border-border-subtle shrink-0">

      {/* Breadcrumb / path input */}
      {pathInputMode ? (
        <input
          ref={pathInputRef}
          value={pathInputValue}
          onChange={(e) => setPathInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitPath(pathInputValue);
            if (e.key === "Escape") setPathInputMode(false);
          }}
          onBlur={() => setPathInputMode(false)}
          className="flex-1 h-7 px-2 rounded bg-surface-3 border border-accent text-[12px] text-text-primary outline-none font-mono"
          spellCheck={false}
        />
      ) : breadcrumb.length > 0 ? (
        <div
          className="flex items-center gap-0.5 min-w-0 overflow-hidden flex-1 cursor-text group/breadcrumb rounded px-1 hover:bg-surface-3 transition-colors"
          onClick={enterPathMode}
          title="Cliquer pour modifier le chemin"
        >
          {breadcrumb.map((seg, i) => (
            <span key={seg.path} className="flex items-center gap-0.5 min-w-0">
              {i > 0 && <ChevronRight size={11} className="text-text-muted shrink-0" />}
              <button
                onClick={(e) => { e.stopPropagation(); navigateTo(seg.path); }}
                className={clsx(
                  "text-[12px] truncate max-w-[160px] transition-colors",
                  i === breadcrumb.length - 1
                    ? "text-text-primary"
                    : "text-text-muted hover:text-text-secondary"
                )}
              >
                {seg.label}
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="flex-1" />
      )}

      {isWatching && (
        <span className="flex items-center gap-1 text-[10px] text-emerald-500 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          {t.watching}
        </span>
      )}

      <div className="flex items-center gap-1.5">
        <div className="relative flex items-center">
          <Search size={12} className="absolute left-2.5 text-text-muted pointer-events-none" />
          <input
            ref={searchRef}
            type="text"
            value={searchInput}
            onChange={(e) => handleSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { handleSearch(""); searchRef.current?.blur(); }
            }}
            placeholder={t.search}
            className="w-48 h-7 pl-8 pr-3 rounded bg-surface-3 border border-border text-[12px] text-text-primary placeholder-text-muted outline-none focus:border-accent focus:bg-surface-2 transition-colors"
          />
        </div>
        <div className="flex items-center rounded overflow-hidden border border-border h-7">
          {(["all", "files", "folders"] as SearchType[]).map((t) => (
            <button
              key={t}
              onClick={() => handleTypeChange(t)}
              className={clsx(
                "px-2 h-full text-[10px] transition-colors capitalize",
                searchType === t
                  ? "bg-accent text-white"
                  : "bg-surface-3 text-text-muted hover:text-text-secondary"
              )}
            >
              {t === "all" ? "All" : t === "files" ? "Files" : "Folders"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-0.5 ml-1">
        <button
          onClick={() => setViewMode("explorer")}
          className={clsx("w-7 h-7 flex items-center justify-center rounded transition-colors",
            viewMode === "explorer" ? "bg-accent text-white" : "text-text-muted hover:text-text-secondary hover:bg-surface-3")}
          title="Explorer"
        ><List size={13} /></button>
        <button
          onClick={() => setViewMode("timeline")}
          className={clsx("w-7 h-7 flex items-center justify-center rounded transition-colors",
            viewMode === "timeline" ? "bg-accent text-white" : "text-text-muted hover:text-text-secondary hover:bg-surface-3")}
          title="Timeline"
        ><Clock size={13} /></button>
      </div>

      <button
        onClick={toggleShowHidden}
        title={showHidden ? "Hide hidden files" : "Show hidden files"}
        className={clsx("w-7 h-7 flex items-center justify-center rounded transition-colors",
          showHidden ? "text-accent bg-accent/10" : "text-text-muted hover:text-text-secondary hover:bg-surface-3")}
      >
        {showHidden ? <Eye size={13} /> : <EyeOff size={13} />}
      </button>

      <div className="w-px h-5 bg-border mx-1" />

      <div className="flex items-center gap-0.5">
        <button
          onClick={() => setLayoutMode("list")}
          className={clsx("w-7 h-7 flex items-center justify-center rounded transition-colors",
            layoutMode === "list" ? "text-text-primary bg-surface-4" : "text-text-muted hover:text-text-secondary hover:bg-surface-3")}
        ><List size={13} /></button>
        <button
          onClick={() => setLayoutMode("grid")}
          className={clsx("w-7 h-7 flex items-center justify-center rounded transition-colors",
            layoutMode === "grid" ? "text-text-primary bg-surface-4" : "text-text-muted hover:text-text-secondary hover:bg-surface-3")}
        ><LayoutGrid size={13} /></button>
        <button
          onClick={() => setDualPaneActive(!dualPaneActive)}
          title="Toggle dual pane (F5)"
          className={clsx("w-7 h-7 flex items-center justify-center rounded transition-colors",
            dualPaneActive ? "bg-accent/20 text-accent" : "text-text-muted hover:text-text-secondary hover:bg-surface-3")}
        ><Columns2 size={13} /></button>
      </div>

      <div className="w-px h-5 bg-border mx-1" />

      {currentPath && onOpenDiskUsage && (
        <button
          onClick={onOpenDiskUsage}
          title="Disk usage"
          className="w-7 h-7 flex items-center justify-center rounded text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors"
        >
          <BarChart2 size={13} />
        </button>
      )}

      {onOpenAi && (
        <button
          onClick={onOpenAi}
          title="AI Assistant (Ctrl+I)"
          className={clsx(
            "w-7 h-7 flex items-center justify-center rounded transition-colors",
            aiActive ? "bg-accent/20 text-accent" : "text-text-muted hover:text-text-secondary hover:bg-surface-3"
          )}
        >
          <Sparkles size={13} />
        </button>
      )}

      {onOpenNotes && (
        <button
          onClick={onOpenNotes}
          title={notesPendingCount && notesPendingCount > 0
            ? `Workspace notes — ${notesPendingCount} task${notesPendingCount === 1 ? "" : "s"} pending`
            : "Workspace notes"}
          className={clsx(
            "relative w-7 h-7 flex items-center justify-center rounded transition-colors",
            notesActive ? "bg-accent/20 text-accent" : "text-text-muted hover:text-text-secondary hover:bg-surface-3"
          )}
        >
          <StickyNote size={13} />
          {!!notesPendingCount && notesPendingCount > 0 && (
            <span
              className="absolute -top-1 -right-1 min-w-[15px] h-[15px] px-1 rounded-full bg-amber-500 text-[10px] font-bold text-black flex items-center justify-center ring-2 ring-surface-1 pointer-events-none leading-none"
            >
              {notesPendingCount > 99 ? "99+" : notesPendingCount}
            </span>
          )}
        </button>
      )}

      <button
        onClick={onOpenSettings}
        title="Settings"
        className="w-7 h-7 flex items-center justify-center rounded text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors"
      >
        <Settings size={13} />
      </button>
    </div>
  );
}
