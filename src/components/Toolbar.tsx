import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, Clock, Eye, EyeOff, LayoutGrid, List, Search } from "lucide-react";
import { useEffect, useRef } from "react";
import { useStore } from "../store/useStore";
import type { FileEntry, ListEntry } from "../types";
import { clsx } from "clsx";

type SearchType = "all" | "files" | "folders";

function useDebounce(fn: (...args: unknown[]) => void, delay: number) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (...args: unknown[]) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => fn(...args), delay);
  };
}

export function Toolbar() {
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
  } = useStore();

  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const runSearch = async (q: string, type: SearchType) => {
    if (!q.trim()) {
      if (currentPath) {
        try {
          const entries = await invoke<ListEntry[]>("list_directory", { path: currentPath, contextId: activeContextId ?? 0 });
          setListEntries(entries);
        } catch { /* ignore */ }
      }
      return;
    }
    try {
      const [fileEntries, folderEntries] = await Promise.all([
        type !== "folders"
          ? invoke<FileEntry[]>("search_files", { query: q }).then((files) =>
              files.map((f): ListEntry => ({
                is_dir: false, name: f.name, path: f.path, size: f.size,
                modified_at: f.modified_at, extension: f.extension, id: f.id, tags: f.tags,
              }))
            )
          : Promise.resolve([] as ListEntry[]),
        type !== "files"
          ? invoke<ListEntry[]>("search_folders", { query: q })
          : Promise.resolve([] as ListEntry[]),
      ]);
      setListEntries([...folderEntries, ...fileEntries]);
    } catch (e) {
      console.error(e);
    }
  };

  const debouncedSearch = useDebounce((q: unknown, type: unknown) => {
    runSearch(q as string, type as SearchType);
  }, 200);

  const handleSearch = (q: string) => {
    setSearchQuery(q);
    debouncedSearch(q, searchType);
  };

  const handleTypeChange = (type: SearchType) => {
    setSearchType(type);
    if (searchQuery.trim()) runSearch(searchQuery, type);
  };

  // Build breadcrumb: find the rootPath that is a prefix of currentPath
  const breadcrumb = (() => {
    if (!currentPath) return [];
    const cur = currentPath.replace(/\\/g, "/");
    const root = rootPaths
      .map((p) => p.replace(/\\/g, "/"))
      .find((p) => cur === p || cur.startsWith(p + "/"));
    if (!root) return [{ label: cur.split("/").pop() ?? cur, path: currentPath }];
    const rootParts = root.split("/");
    const curParts = cur.split("/");
    return curParts.slice(rootParts.length - 1).map((label, i) => ({
      label,
      path: curParts.slice(0, rootParts.length - 1 + i + 1).join("/").replace(/\//g, "\\"),
    }));
  })();

  const navigateTo = async (path: string) => {
    setCurrentPath(path);
    pushNav(path);
    setSearchQuery("");
    try {
      const entries = await invoke<ListEntry[]>("list_directory", { path, contextId: activeContextId ?? 0 });
      setListEntries(entries);
      selectFile(null);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="flex items-center gap-2 px-3 h-[48px] bg-surface-1 border-b border-border-subtle shrink-0">

      {/* Breadcrumb */}
      {breadcrumb.length > 0 ? (
        <div className="flex items-center gap-0.5 min-w-0 overflow-hidden flex-1">
          {breadcrumb.map((seg, i) => (
            <span key={seg.path} className="flex items-center gap-0.5 min-w-0">
              {i > 0 && <ChevronRight size={11} className="text-text-muted shrink-0" />}
              <button
                onClick={() => navigateTo(seg.path)}
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
          watching
        </span>
      )}

      <div className="flex items-center gap-1.5">
        <div className="relative flex items-center">
          <Search size={12} className="absolute left-2.5 text-text-muted pointer-events-none" />
          <input
            ref={searchRef}
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { handleSearch(""); searchRef.current?.blur(); }
            }}
            placeholder="Search…"
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
      </div>
    </div>
  );
}
