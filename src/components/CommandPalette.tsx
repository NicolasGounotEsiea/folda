import { invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import {
  Clock, File, Folder, Hash,
  LayoutGrid, List, Search, X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import type { FileEntry, ListEntry } from "../types";

interface Command {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  group: string;
  action: () => void;
}

function score(text: string, query: string): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.includes(q)) return 60;
  // fuzzy: all query chars appear in order
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length ? 20 : 0;
}

const RECENT_QUERIES_KEY = "nxs_recent_queries";
const MAX_RECENT = 8;

function loadRecentQueries(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_QUERIES_KEY) ?? "[]"); } catch { return []; }
}

function saveRecentQuery(q: string) {
  const trimmed = q.trim();
  if (!trimmed || trimmed.length < 2) return;
  const prev = loadRecentQueries().filter((x) => x !== trimmed);
  localStorage.setItem(RECENT_QUERIES_KEY, JSON.stringify([trimmed, ...prev].slice(0, MAX_RECENT)));
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const {
    rootPaths, setCurrentPath, setListEntries, pushNav, selectFile,
    setViewMode, setLayoutMode, viewMode, layoutMode, toggleShowHidden, showHidden,
    pinnedItems,
  } = useStore();

  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Recent items from activity DB (folders + files, deduplicated, newest first)
  const [recentFiles, setRecentFiles] = useState<Command[]>([]);
  useEffect(() => {
    const now = Math.floor(Date.now() / 1000);
    invoke<Array<{ file_path: string; file_name: string; action: string }>>("get_timeline", {
      from: now - 30 * 86400, to: now, folder: null,
    }).then((entries) => {
      const seen = new Set<string>();
      const cmds: Command[] = [];
      for (const e of entries) {
        if (seen.has(e.file_path) || !e.file_name) continue;
        seen.add(e.file_path);
        const isDir = e.action === "navigated";
        const target = isDir
          ? e.file_path
          : e.file_path.replace(/\\/g, "/").split("/").slice(0, -1).join("\\");
        cmds.push({
          id: `recent:${e.file_path}`,
          label: e.file_name,
          description: e.file_path,
          group: "Recent",
          icon: isDir
            ? <Folder size={13} className="text-yellow-400" />
            : <File size={13} className="text-text-muted" />,
          action: async () => {
            if (target) await navigateTo(target);
            else onClose();
          },
        });
        if (cmds.length >= 10) break;
      }
      setRecentFiles(cmds);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recent search queries from localStorage
  const [recentQueries, setRecentQueries] = useState<string[]>(() => loadRecentQueries());

  useEffect(() => { inputRef.current?.focus(); }, []);

  const navigateTo = async (path: string) => {
    setCurrentPath(path);
    pushNav(path);
    setViewMode("explorer");
    try {
      const entries = await invoke<ListEntry[]>("list_directory", { path });
      setListEntries(entries);
      selectFile(null);
    } catch { /* ignore */ }
    onClose();
  };

  // ── Static commands ────────────────────────────────────────────────────────
  const staticCommands = useMemo<Command[]>(() => {
    const cmds: Command[] = [
      {
        id: "view:explorer", label: "Switch to Explorer", group: "View",
        icon: <List size={13} />, description: "Show file explorer",
        action: () => { setViewMode("explorer"); onClose(); },
      },
      {
        id: "view:timeline", label: "Switch to Timeline", group: "View",
        icon: <Clock size={13} />, description: "Show recent activity",
        action: () => { setViewMode("timeline"); onClose(); },
      },
      {
        id: "layout:list", label: "List layout", group: "View",
        icon: <List size={13} />,
        action: () => { setLayoutMode("list"); onClose(); },
      },
      {
        id: "layout:grid", label: "Grid layout", group: "View",
        icon: <LayoutGrid size={13} />,
        action: () => { setLayoutMode("grid"); onClose(); },
      },
      {
        id: "hidden:toggle", label: showHidden ? "Hide hidden files" : "Show hidden files", group: "View",
        icon: <Hash size={13} />,
        action: () => { toggleShowHidden(); onClose(); },
      },
    ];

    // Root paths as navigation commands
    rootPaths.forEach((p) => {
      const name = p.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? p;
      cmds.push({
        id: `nav:root:${p}`, label: name, description: p, group: "Folders",
        icon: <Folder size={13} className="text-yellow-400" />,
        action: () => navigateTo(p),
      });
    });

    // Pinned items
    pinnedItems.forEach((item) => {
      cmds.push({
        id: `pinned:${item.path}`, label: item.name, description: item.path, group: "Pinned",
        icon: item.is_dir
          ? <Folder size={13} className="text-yellow-400" />
          : <File size={13} className="text-text-muted" />,
        action: () => navigateTo(item.path),
      });
    });

    return cmds;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPaths, pinnedItems, showHidden, viewMode, layoutMode]);

  // ── File search results (DB FTS + live filesystem fallback) ──────────────
  const [searchResults, setSearchResults] = useState<Command[]>([]);
  const { currentPath } = useStore();
  useEffect(() => {
    if (query.length < 2) { setSearchResults([]); return; }
    const timer = setTimeout(async () => {
      const q = query;
      const toCmd = (f: FileEntry, group: string): Command => ({
        id: `file:${f.path}`, label: f.name, description: f.path, group,
        icon: <File size={13} className="text-text-muted" />,
        action: async () => {
          saveRecentQuery(q);
          setRecentQueries(loadRecentQueries());
          const parent = f.path.replace(/\\/g, "/").split("/").slice(0, -1).join("\\");
          await navigateTo(parent);
        },
      });

      try {
        // Run DB search and live search in parallel
        const [dbResults, liveResults] = await Promise.all([
          invoke<FileEntry[]>("search_files", { query: q }).catch(() => [] as FileEntry[]),
          currentPath
            ? invoke<FileEntry[]>("search_live", { query: q, path: currentPath }).catch(() => [] as FileEntry[])
            : Promise.resolve([] as FileEntry[]),
        ]);

        const dbPaths = new Set(dbResults.map((f) => f.path));
        // Live results that aren't already in DB results go in a separate group
        const liveOnly = liveResults.filter((f) => !dbPaths.has(f.path));

        setSearchResults([
          ...dbResults.slice(0, 8).map((f) => toCmd(f, "Files")),
          ...liveOnly.slice(0, 5).map((f) => toCmd(f, "Here")),
        ]);
      } catch { setSearchResults([]); }
    }, 150);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, currentPath]);

  // ── Recent query commands (shown only when query is empty) ────────────────
  const recentQueryCommands = useMemo<Command[]>(() => {
    if (recentQueries.length === 0) return [];
    return recentQueries.map((q) => ({
      id: `recent-query:${q}`, label: q, group: "Recent searches",
      icon: <Search size={13} className="text-text-muted" />,
      action: () => setQuery(q),
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentQueries]);

  // ── Filtered + scored commands ─────────────────────────────────────────────
  const allCommands = useMemo(() => {
    if (!query) return [...recentFiles, ...recentQueryCommands, ...staticCommands];
    return [...staticCommands, ...searchResults];
  }, [staticCommands, searchResults, recentFiles, recentQueryCommands, query]);

  const filtered = useMemo(() => {
    if (!query) return allCommands;
    return allCommands
      .map((c) => ({ ...c, _score: Math.max(score(c.label, query), score(c.description ?? "", query)) }))
      .filter((c) => c._score > 0)
      .sort((a, b) => b._score - a._score);
  }, [allCommands, query]);

  useEffect(() => { setActiveIdx(0); }, [filtered.length]);

  // ── Scroll active item into view ───────────────────────────────────────────
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, filtered.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    if (e.key === "Enter" && filtered[activeIdx]) {
      if (query.length >= 2) {
        saveRecentQuery(query);
        setRecentQueries(loadRecentQueries());
      }
      filtered[activeIdx].action();
    }
    if (e.key === "Escape") onClose();
  };

  // Group items for display
  const groups = useMemo(() => {
    const map = new Map<string, Command[]>();
    filtered.forEach((c) => {
      if (!map.has(c.group)) map.set(c.group, []);
      map.get(c.group)!.push(c);
    });
    return map;
  }, [filtered]);

  let globalIdx = 0;

  return (
    <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-[12vh] bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[560px] max-h-[60vh] bg-surface-2 border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden">

        {/* Search input */}
        <div className="flex items-center gap-2 px-4 h-12 border-b border-border-subtle shrink-0">
          <Search size={14} className="text-text-muted shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search files, folders, actions…"
            className="flex-1 bg-transparent text-[13px] text-text-primary placeholder-text-muted outline-none"
          />
          {query && (
            <button onClick={() => setQuery("")} className="text-text-muted hover:text-text-secondary transition-colors">
              <X size={12} />
            </button>
          )}
          <kbd className="text-[10px] text-text-muted bg-surface-3 px-1.5 py-0.5 rounded border border-border">Esc</kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-8 text-text-muted">
              <Search size={20} className="opacity-20" />
              <span className="text-[12px]">No results</span>
            </div>
          )}
          {Array.from(groups.entries()).map(([group, items]) => (
            <div key={group}>
              <div className="px-4 py-1 text-[10px] text-text-muted uppercase tracking-widest font-semibold">
                {group}
              </div>
              {items.map((cmd) => {
                const idx = globalIdx++;
                const isActive = idx === activeIdx;
                return (
                  <button
                    key={cmd.id}
                    data-idx={idx}
                    onClick={cmd.action}
                    onMouseEnter={() => setActiveIdx(idx)}
                    className={clsx(
                      "w-full flex items-center gap-3 px-4 h-9 text-left transition-colors",
                      isActive ? "bg-accent/10 text-text-primary" : "text-text-secondary hover:bg-surface-3"
                    )}
                  >
                    <span className="shrink-0 text-text-muted">{cmd.icon}</span>
                    <span className="flex-1 min-w-0">
                      <span className="text-[12px] truncate block">{cmd.label}</span>
                      {cmd.description && (
                        <span className="text-[10px] text-text-muted truncate block">{cmd.description}</span>
                      )}
                    </span>
                    {isActive && (
                      <kbd className="text-[10px] text-text-muted bg-surface-3 px-1.5 py-0.5 rounded border border-border shrink-0">↵</kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-border-subtle shrink-0">
          {[["↑↓", "navigate"], ["↵", "select"], ["Esc", "close"]].map(([key, label]) => (
            <span key={key} className="flex items-center gap-1 text-[10px] text-text-muted">
              <kbd className="bg-surface-3 px-1 py-0.5 rounded border border-border">{key}</kbd>
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
