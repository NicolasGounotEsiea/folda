import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import hljs from "highlight.js/lib/core";
import { useEffect } from "react";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { Calendar, ChevronDown, ChevronRight, Clock, File, Folder, GitBranch, HardDrive, History, Info, PanelRightClose, Tag, X } from "lucide-react";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../store/useStore";
import { useGitStore, statusForAbsolutePath, type CommitInfo, type FileStatus } from "../store/useGitStore";
import { DiffView, FileDiff, formatRelativeDate, statusColor, statusLetter } from "./GitPanel";
import type { FolderStats, ListEntry, Tag as TagType } from "../types";
import { useTranslation } from "../utils/i18n";
import { getCachedFolderStats, cacheFolderStats } from "../utils/folderSizeCache";

interface ActivityEntry {
  id: number;
  file_id: number | null;
  file_path: string;
  file_name: string;
  action: string;
  timestamp: number;
  app_name: string | null;
}

// ── Per-file Git tab ─────────────────────────────────────────────────────────
//
// Resolves the repo for the selected file's path, then shows: current status,
// diff vs HEAD (working tree), and history of commits that touched this file
// (each commit expandable to see what changed in this file specifically).
//
// Hidden in the tab bar when git is disabled or the file isn't inside a repo
// — so this component only renders when there's actually something to show.

interface FileHistoryEntry {
  commit: CommitInfo;
  diff: string;
}

function FileGitTab({ filePath }: { filePath: string }) {
  const t = useTranslation();
  // Reuse the sidebar's resolved status/map when the file lives in the same
  // repo as currentPath — avoids an extra status query for the common case.
  const sidebarStatus = useGitStore((s) => s.status);
  const sidebarMap = useGitStore((s) => s.statusByPath);

  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [relPath, setRelPath] = useState<string | null>(null);
  const [resolving, setResolving] = useState(true);

  const [history, setHistory] = useState<FileHistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [expandedSha, setExpandedSha] = useState<string | null>(null);

  // Step 1: figure out the repo + relative path. If the file shares the
  // sidebar repo, we can derive both for free (zero extra invoke).
  useEffect(() => {
    let cancelled = false;
    setRepoRoot(null);
    setRelPath(null);
    setResolving(true);

    const fromSidebar = statusForAbsolutePath(filePath, sidebarStatus, sidebarMap);
    if (sidebarStatus) {
      const root = sidebarStatus.info.repo_root.replace(/\\/g, "/").replace(/\/+$/, "");
      const abs = filePath.replace(/\\/g, "/");
      if (abs.startsWith(root + "/")) {
        setRepoRoot(sidebarStatus.info.repo_root);
        setRelPath(abs.slice(root.length + 1));
        setResolving(false);
        return;
      }
    }
    // Fallback: discover via the file's parent dir.
    void fromSidebar;
    const parent = filePath.replace(/[\\/][^\\/]+$/, "");
    invoke<string | null>("git_get_repo_root", { path: parent })
      .then((root) => {
        if (cancelled || !root) { setResolving(false); return; }
        setRepoRoot(root);
        const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
        const abs = filePath.replace(/\\/g, "/");
        setRelPath(abs.startsWith(r + "/") ? abs.slice(r.length + 1) : null);
        setResolving(false);
      })
      .catch(() => { if (!cancelled) setResolving(false); });

    return () => { cancelled = true; };
  }, [filePath, sidebarStatus, sidebarMap]);

  // Step 2: load history once we have repo+rel.
  useEffect(() => {
    if (!repoRoot || !relPath) return;
    let cancelled = false;
    setHistoryLoading(true);
    invoke<FileHistoryEntry[]>("git_get_file_history", { repoRoot, path: relPath, n: 20 })
      .then((h) => { if (!cancelled) setHistory(h); })
      .catch(() => { if (!cancelled) setHistory([]); })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [repoRoot, relPath]);

  if (resolving) {
    return <div className="px-3 py-3 text-[11px] text-text-muted">{t.gitLoading}</div>;
  }
  if (!repoRoot || !relPath) {
    return (
      <div className="px-3 py-3 text-[11px] text-text-muted italic">
        {t.gitFileNotInRepo}
      </div>
    );
  }

  const currentStatus: { status: FileStatus; staged: boolean } | null =
    statusForAbsolutePath(filePath, sidebarStatus, sidebarMap)
      ?? null;

  return (
    <div className="flex flex-col gap-3 px-3 py-3 text-[12px]">
      {/* Status badge */}
      <div className="flex items-center gap-2">
        {currentStatus ? (
          <>
            <span className={clsx("inline-block w-2 h-2 rounded-full shrink-0", statusColor(currentStatus.status))} />
            <span className="text-[11px] text-text-primary">
              {statusLetter(currentStatus.status)} · {currentStatus.status}
              {currentStatus.staged && <span className="text-emerald-400 ml-1.5 text-[9px] uppercase tracking-wide">staged</span>}
            </span>
          </>
        ) : (
          <span className="text-[11px] text-text-muted italic">{t.gitFileClean}</span>
        )}
      </div>

      {/* Diff vs HEAD — only when modified */}
      {currentStatus && currentStatus.status !== "untracked" && currentStatus.status !== "ignored" && (
        <div className="border border-border-subtle rounded overflow-hidden">
          <div className="px-2 py-1 bg-surface-2 text-[10px] uppercase tracking-widest text-text-muted">
            {t.gitFileDiffHeader}
          </div>
          <div className="bg-surface-0/50">
            <FileDiff repoRoot={repoRoot} path={relPath} />
          </div>
        </div>
      )}

      {/* History */}
      <div className="flex flex-col gap-0.5">
        <div className="px-1 pb-1 text-[10px] uppercase tracking-widest text-text-muted">
          {t.gitFileHistoryHeader}
        </div>
        {historyLoading && <p className="text-[11px] text-text-muted px-1">{t.gitLoading}</p>}
        {!historyLoading && history !== null && history.length === 0 && (
          <p className="text-[11px] text-text-muted italic px-1">{t.gitFileNoHistory}</p>
        )}
        {!historyLoading && history && history.map((entry) => {
          const expanded = expandedSha === entry.commit.sha;
          const subject = entry.commit.message.split("\n", 1)[0] ?? "";
          return (
            <div key={entry.commit.sha} className="border border-border-subtle rounded overflow-hidden">
              <button
                onClick={() => setExpandedSha(expanded ? null : entry.commit.sha)}
                className="w-full flex flex-col items-stretch px-2 py-1 hover:bg-surface-3 transition-colors text-left"
              >
                <div className="flex items-center gap-1.5">
                  {expanded
                    ? <ChevronDown size={9} className="text-text-muted shrink-0" />
                    : <ChevronRight size={9} className="text-text-muted shrink-0" />}
                  <span className="text-[11px] text-text-secondary truncate flex-1" title={subject}>
                    {subject || "(empty message)"}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 pl-4 mt-0.5 text-[9px] text-text-muted">
                  <span className="font-mono">{entry.commit.short_sha}</span>
                  <span>·</span>
                  <span className="truncate">{entry.commit.author_name}</span>
                  <span>·</span>
                  <span className="shrink-0">{formatRelativeDate(entry.commit.date, t)}</span>
                </div>
              </button>
              {expanded && (
                <div className="bg-surface-0/50 border-t border-border-subtle">
                  <DiffView diff={entry.diff} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FileActivityTab({ filePath }: { filePath: string }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    invoke<ActivityEntry[]>("get_file_activity", { filePath, limit: 100 })
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [filePath]);

  const ACTION_LABELS: Record<string, string> = {
    opened: "Opened", edited: "Edited", saved: "Saved",
    created: "Created", deleted: "Deleted", renamed: "Renamed", moved: "Moved",
  };

  const ACTION_COLORS: Record<string, string> = {
    opened: "text-blue-400", edited: "text-amber-400", saved: "text-emerald-400",
    created: "text-emerald-400", deleted: "text-red-400", renamed: "text-purple-400", moved: "text-purple-400",
  };

  const tActivity = useTranslation();

  if (loading) return (
    <div className="p-3 text-[10px] text-text-muted animate-pulse">{tActivity.loading}</div>
  );

  if (entries.length === 0) return (
    <div className="flex flex-col items-center justify-center py-8 gap-2 text-text-muted">
      <History size={18} className="opacity-30" />
      <span className="text-[10px]">{tActivity.noActivity}</span>
    </div>
  );

  return (
    <div className="flex flex-col">
      {entries.map((e) => (
        <div key={e.id} className="flex flex-col gap-0.5 px-3 py-2 border-b border-border-subtle hover:bg-surface-2 transition-colors">
          <div className="flex items-center justify-between gap-1">
            <span className={clsx("text-[10px] font-medium", ACTION_COLORS[e.action] ?? "text-text-secondary")}>
              {ACTION_LABELS[e.action] ?? e.action}
            </span>
            {e.app_name && (
              <span className="text-[9px] text-text-muted truncate max-w-[80px]">{e.app_name}</span>
            )}
          </div>
          <span className="text-[9px] text-text-muted">
            {formatActivityDate(e.timestamp)}
          </span>
        </div>
      ))}
    </div>
  );
}

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("bash", bash);

const EXT_LANG: Record<string, string> = {
  js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
  py: "python", rs: "rust", go: "go", java: "java",
  c: "cpp", cpp: "cpp", h: "cpp", cc: "cpp",
  css: "css", scss: "css", json: "json",
  yaml: "yaml", yml: "yaml", toml: "yaml",
  html: "xml", xml: "xml", svg: "xml",
  sh: "bash", bash: "bash",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/// Compact date for the activity history feed. Year is omitted only when the
/// date is in the current year, so "20 janv., 22:21" makes sense for recent
/// events but "20 janv. 2011, 22:21" is shown for older ones (avoids the
/// ambiguity reported by users seeing a 14-year-old timestamp as if it were today).
function formatActivityDate(unixSecs: number): string {
  if (!unixSecs) return "—";
  const d = new Date(unixSecs * 1000);
  const opts: Intl.DateTimeFormatOptions = {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleString(undefined, opts);
}

function formatDate(unixSecs: number): string {
  if (!unixSecs) return "—";
  return new Date(unixSecs * 1000).toLocaleString(undefined, {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ─── Folder stats ─────────────────────────────────────────────────────────────
function FolderStatsView({ path }: { path: string }) {
  const [stats, setStats] = useState<FolderStats | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Use cached value if fresh — avoids re-walking the tree on back/forth navigation.
    const cached = getCachedFolderStats(path);
    if (cached) {
      setStats(cached);
      setLoading(false);
      return;
    }
    setStats(null);
    setLoading(true);
    let cancelled = false;
    invoke<FolderStats>("get_folder_stats", { path })
      .then((s) => {
        if (cancelled) return;
        cacheFolderStats(path, s);
        setStats(s);
      })
      .catch(() => { if (!cancelled) setStats(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path]);

  if (loading) return (
    <div className="text-[10px] text-text-muted animate-pulse py-2">Calculating…</div>
  );
  if (!stats) return null;

  const totalBar = stats.breakdown.reduce((s, b) => s + b.size, 0) || 1;

  const TYPE_COLORS: Record<string, string> = {
    js: "#f7df1e", ts: "#3178c6", tsx: "#3178c6", jsx: "#61dafb",
    py: "#3572a5", rs: "#dea584", go: "#00add8", json: "#68a063",
    css: "#563d7c", html: "#e34c26", md: "#083fa1",
    png: "#ec4899", jpg: "#ec4899", jpeg: "#ec4899", svg: "#ff9900",
    mp4: "#a855f7", mp3: "#06b6d4", pdf: "#ef4444",
    zip: "#f97316", tar: "#f97316",
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "Total size", value: formatSize(stats.total_size) },
          { label: "Files", value: stats.file_count.toLocaleString() },
          { label: "Folders", value: stats.dir_count.toLocaleString() },
        ].map(({ label, value }) => (
          <div key={label} className="bg-surface-0 rounded p-2 flex flex-col gap-0.5">
            <span className="text-[9px] text-text-muted uppercase tracking-wide">{label}</span>
            <span className="text-[12px] font-medium text-text-primary">{value}</span>
          </div>
        ))}
      </div>

      {stats.breakdown.length > 0 && (
        <div>
          <p className="text-[9px] text-text-muted uppercase tracking-widest mb-2">By file type</p>
          <div className="flex flex-col gap-1.5">
            {stats.breakdown.map((b) => {
              const pct = Math.max(4, Math.round((b.size / totalBar) * 100));
              const color = TYPE_COLORS[b.ext] ?? "#6b7280";
              return (
                <div key={b.ext} className="flex items-center gap-2">
                  <span className="text-[10px] text-text-muted w-8 text-right shrink-0">
                    {b.ext || "—"}
                  </span>
                  <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all"
                      style={{ width: `${pct}%`, background: color }} />
                  </div>
                  <span className="text-[10px] text-text-muted w-12 text-right shrink-0">
                    {formatSize(b.size)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Resize hook ─────────────────────────────────────────────────────────────
// Resize behavior now lives in `utils/useResizable` so the Sidebar can share
// it. We pass `side: "right"` (this panel is on the right) and skip the
// `storageKey` so the preview panel stays ephemeral — re-opening a file uses
// the default width, matching the pre-refactor behavior.
import { useResizable } from "../utils/useResizable";

// ─── Folder preview ───────────────────────────────────────────────────────────
function FolderPreview({ folder, onClose, width, onDragStart }: {
  folder: ListEntry;
  onClose: () => void;
  width: number;
  onDragStart: (e: React.MouseEvent) => void;
}) {
  const { tags, updateFolderTags, activeContextId } = useStore();
  const tFolder = useTranslation();
  const ctxId = activeContextId ?? 0;
  const [tagInput, setTagInput] = useState("");
  const [showTagInput, setShowTagInput] = useState(false);
  const [itemCount, setItemCount] = useState<number | null>(null);
  const [folderTags, setFolderTags] = useState<TagType[]>(folder.tags);

  useEffect(() => { setFolderTags(folder.tags); }, [folder.path, folder.tags]);

  useEffect(() => {
    setItemCount(null);
    invoke<ListEntry[]>("list_directory", { path: folder.path })
      .then((entries) => setItemCount(entries.length))
      .catch(() => setItemCount(null));
  }, [folder.path]);

  const handleAddTag = async (tagName: string) => {
    if (!tagName.trim()) return;
    const existing = tags.find((t) => t.name.toLowerCase() === tagName.toLowerCase());
    try {
      const tagId = existing
        ? existing.id
        : await invoke<number>("create_tag", { name: tagName.trim() });
      await invoke("add_tag_to_folder", { path: folder.path, tagId, contextId: ctxId });
      const updated = await invoke<TagType[]>("get_folder_tags", { path: folder.path, contextId: ctxId });
      setFolderTags(updated);
      updateFolderTags(folder.path, updated);
      setTagInput(""); setShowTagInput(false);
    } catch (e) { console.error(e); }
  };

  const handleRemoveTag = async (tagId: number) => {
    try {
      await invoke("remove_tag_from_folder", { path: folder.path, tagId, contextId: ctxId });
      const updated = await invoke<TagType[]>("get_folder_tags", { path: folder.path, contextId: ctxId });
      setFolderTags(updated);
      updateFolderTags(folder.path, updated);
    } catch (e) { console.error(e); }
  };

  return (
    <div style={{ width }} className="bg-surface-1 border-l border-border-subtle shrink-0 flex flex-col overflow-hidden relative select-text">
      {/* Resize handle */}
      <div
        onMouseDown={onDragStart}
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/40 transition-colors z-10"
      />
      <div className="h-20 bg-surface-0 flex flex-col items-center justify-center border-b border-border-subtle shrink-0 gap-1 relative">
        <Folder size={28} className="text-yellow-400 opacity-80" />
        <button
          onClick={onClose}
          title="Close panel"
          className="absolute top-2 right-2 w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
        >
          <PanelRightClose size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        <div>
          <h3 className="text-[13px] font-medium text-text-primary break-all leading-snug">{folder.name}</h3>
          <p className="text-[10px] text-text-muted mt-0.5 break-all leading-relaxed">{folder.path}</p>
        </div>

        <div className="flex flex-col gap-2">
          {itemCount !== null && (
            <Row icon={<Folder size={12} />} label="Items" value={`${itemCount}`} />
          )}
          <Row icon={<Clock size={12} />} label={tFolder.modified} value={formatDate(folder.modified_at)} />
        </div>

        <div>
          <p className="text-[9px] text-text-muted uppercase tracking-widest font-semibold mb-2">{tFolder.statistics}</p>
          <FolderStatsView path={folder.path} />
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] text-text-muted uppercase tracking-widest font-semibold flex items-center gap-1">
              <Tag size={10} /> {tFolder.tags}
            </span>
            <button onClick={() => setShowTagInput((v) => !v)}
              className="text-[10px] text-accent hover:text-accent-glow transition-colors">{tFolder.addTag}</button>
          </div>
          {showTagInput && (
            <>
              <input autoFocus type="text" value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleAddTag(tagInput); if (e.key === "Escape") setShowTagInput(false); }}
                placeholder="Tag name…" list="folder-tags-datalist"
                className="w-full h-6 px-2 mb-2 rounded bg-surface-3 border border-border text-[11px] text-text-primary placeholder-text-muted outline-none focus:border-accent" />
              <datalist id="folder-tags-datalist">
                {tags.map((t) => <option key={t.id} value={t.name} />)}
              </datalist>
            </>
          )}
          <div className="flex flex-wrap gap-1.5">
            {folderTags.length === 0 && <span className="text-[11px] text-text-muted">{tFolder.noTags}</span>}
            {folderTags.map((tag) => (
              <span key={tag.id} className="group flex items-center gap-1 px-2 py-0.5 rounded text-[11px]"
                style={{ background: tag.color + "22", color: tag.color }}>
                {tag.name}
                <button onClick={() => handleRemoveTag(tag.id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity"><X size={9} /></button>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Code preview with syntax highlighting ────────────────────────────────────
function CodePreview({ code, ext }: { code: string; ext: string }) {
  const highlighted = useMemo(() => {
    const lang = EXT_LANG[ext];
    if (lang) {
      try { return hljs.highlight(code, { language: lang }).value; }
      catch { /* fallback */ }
    }
    return hljs.highlightAuto(code).value;
  }, [code, ext]);

  return (
    <div className="h-52 bg-surface-0 border-b border-border-subtle overflow-hidden shrink-0 relative">
      <div className="absolute inset-0 overflow-auto p-3">
        <pre className="text-[10px] font-mono leading-relaxed hljs-dark"
          dangerouslySetInnerHTML={{ __html: highlighted }} />
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-surface-0 to-transparent pointer-events-none" />
    </div>
  );
}

// ─── Main PreviewPanel ────────────────────────────────────────────────────────
export function PreviewPanel({ onClose }: { onClose: () => void }) {
  const { selectedFile, selectedEntry, tags, updateFileTags, activeContextId, settings } = useStore();
  const t = useTranslation();
  const ctxId = activeContextId ?? 0;
  const [tagInput, setTagInput] = useState("");
  const [showTagInput, setShowTagInput] = useState(false);
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [activeTab, setActiveTab] = useState<"info" | "history" | "git">("info");
  const { width, onDragStart } = useResizable({ defaultWidth: 280, side: "right" });

  useEffect(() => {
    setTextPreview(null);
    setShowTagInput(false);
    setTagInput("");
    setActiveTab("info");
    if (!selectedFile) return;
    let cancelled = false;
    setLoadingPreview(true);
    invoke<string | null>("get_file_preview", { path: selectedFile.path })
      .then((v) => { if (!cancelled) setTextPreview(v); })
      .catch(() => { if (!cancelled) setTextPreview(null); })
      .finally(() => { if (!cancelled) setLoadingPreview(false); });
    return () => { cancelled = true; };
  }, [selectedFile?.id]);

  if (selectedEntry?.kind === "folder") return (
    <FolderPreview folder={selectedEntry.entry} onClose={onClose} width={width} onDragStart={onDragStart} />
  );

  if (!selectedFile) {
    return (
      <div style={{ width }} className="bg-surface-1 border-l border-border-subtle shrink-0 flex flex-col items-center justify-center gap-2 text-text-muted relative">
        <div onMouseDown={onDragStart} className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/40 transition-colors" />
        <button onClick={onClose} title="Close panel" className="absolute top-2 right-2 w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors">
          <PanelRightClose size={12} />
        </button>
        <File size={28} className="opacity-20" />
        <span className="text-[12px]">Select a file to preview</span>
      </div>
    );
  }

  const handleAddTag = async (tagName: string) => {
    if (!tagName.trim()) return;
    const existing = tags.find((t) => t.name.toLowerCase() === tagName.toLowerCase());
    try {
      const tagId = existing
        ? existing.id
        : await invoke<number>("create_tag", { name: tagName.trim() });
      await invoke("add_tag_to_file", { fileId: selectedFile.id, tagId, contextId: ctxId });
      const updated = await invoke<TagType[]>("get_file_tags", { fileId: selectedFile.id, contextId: ctxId });
      updateFileTags(selectedFile.id, updated);
      setTagInput(""); setShowTagInput(false);
    } catch (e) { console.error(e); }
  };

  const handleRemoveTag = async (tagId: number) => {
    try {
      await invoke("remove_tag_from_file", { fileId: selectedFile.id, tagId, contextId: ctxId });
      const updated = await invoke<TagType[]>("get_file_tags", { fileId: selectedFile.id, contextId: ctxId });
      updateFileTags(selectedFile.id, updated);
    } catch (e) { console.error(e); }
  };

  const ext = selectedFile.extension.toLowerCase();
  const isImage = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].includes(ext);
  const isMarkdown = ext === "md" || ext === "mdx";
  const isCode = ext in EXT_LANG;

  return (
    <div style={{ width }} className="bg-surface-1 border-l border-border-subtle shrink-0 flex flex-col overflow-hidden relative select-text">
      {/* Resize handle */}
      <div onMouseDown={onDragStart} className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/40 transition-colors z-10" />
      {/* Close button */}
      <button onClick={onClose} title="Close panel" className="absolute top-2 right-2 w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors z-10">
        <PanelRightClose size={12} />
      </button>

      {/* Tab bar */}
      <div className="flex items-center border-b border-border-subtle shrink-0 bg-surface-1 mt-0">
        <button
          onClick={() => setActiveTab("info")}
          className={clsx(
            "flex items-center gap-1 px-3 h-7 text-[10px] transition-colors border-b-2",
            activeTab === "info"
              ? "border-accent text-accent"
              : "border-transparent text-text-muted hover:text-text-secondary"
          )}
        >
          <Info size={10} /> {t.info}
        </button>
        <button
          onClick={() => setActiveTab("history")}
          className={clsx(
            "flex items-center gap-1 px-3 h-7 text-[10px] transition-colors border-b-2",
            activeTab === "history"
              ? "border-accent text-accent"
              : "border-transparent text-text-muted hover:text-text-secondary"
          )}
        >
          <History size={10} /> {t.history}
        </button>
        {settings.gitEnabled && (
          <button
            onClick={() => setActiveTab("git")}
            className={clsx(
              "flex items-center gap-1 px-3 h-7 text-[10px] transition-colors border-b-2",
              activeTab === "git"
                ? "border-accent text-accent"
                : "border-transparent text-text-muted hover:text-text-secondary"
            )}
          >
            <GitBranch size={10} /> {t.gitTabLabel}
          </button>
        )}
      </div>

      {activeTab === "history" ? (
        <div className="flex-1 overflow-y-auto">
          <FileActivityTab filePath={selectedFile.path} />
        </div>
      ) : null}

      {activeTab === "git" && settings.gitEnabled ? (
        <div className="flex-1 overflow-y-auto">
          <FileGitTab filePath={selectedFile.path} />
        </div>
      ) : null}

      {/* Info tab */}
      {activeTab === "info" && (<>
        {isImage ? (
          <div className="h-44 bg-surface-0 flex items-center justify-center border-b border-border-subtle overflow-hidden shrink-0">
            <img src={convertFileSrc(selectedFile.path)} alt={selectedFile.name}
              className="max-w-full max-h-full object-contain"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
          </div>
        ) : isMarkdown && textPreview !== null ? (
          <div className="h-56 bg-surface-0 border-b border-border-subtle overflow-y-auto shrink-0 relative">
            <div className="p-3 prose prose-invert prose-xs max-w-none
              [&>h1]:text-[13px] [&>h1]:font-semibold [&>h1]:text-text-primary [&>h1]:mb-1 [&>h1]:mt-0
              [&>h2]:text-[12px] [&>h2]:font-semibold [&>h2]:text-text-primary [&>h2]:mb-1 [&>h2]:mt-2
              [&>h3]:text-[11px] [&>h3]:font-semibold [&>h3]:text-text-secondary [&>h3]:mb-1 [&>h3]:mt-2
              [&>p]:text-[11px] [&>p]:text-text-secondary [&>p]:my-1 [&>p]:leading-relaxed
              [&>ul]:text-[11px] [&>ul]:text-text-secondary [&>ul]:my-1 [&>ul]:pl-4
              [&>ol]:text-[11px] [&>ol]:text-text-secondary [&>ol]:my-1 [&>ol]:pl-4
              [&_li]:my-0.5
              [&>blockquote]:border-l-2 [&>blockquote]:border-accent [&>blockquote]:pl-2 [&>blockquote]:text-text-muted [&>blockquote]:italic
              [&_code]:text-[10px] [&_code]:font-mono [&_code]:bg-surface-3 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-accent-glow
              [&>pre]:bg-surface-3 [&>pre]:p-2 [&>pre]:rounded [&>pre]:overflow-x-auto
              [&_pre_code]:bg-transparent [&_pre_code]:p-0
              [&>table]:text-[10px] [&>table]:w-full [&_th]:text-text-muted [&_th]:text-left [&_th]:pb-1 [&_td]:py-0.5 [&_tr]:border-b [&_tr]:border-border-subtle
              [&_a]:text-accent [&_a]:no-underline [&_a:hover]:underline
              [&_strong]:text-text-primary [&_em]:text-text-secondary
              [&_hr]:border-border">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{textPreview}</ReactMarkdown>
            </div>
            <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-surface-0 to-transparent pointer-events-none" />
          </div>
        ) : isCode && textPreview !== null ? (
          <CodePreview code={textPreview} ext={ext} />
        ) : textPreview !== null ? (
          <div className="h-44 bg-surface-0 border-b border-border-subtle overflow-hidden shrink-0 relative">
            <pre className="p-3 text-[10px] font-mono text-text-muted leading-relaxed overflow-hidden h-full">
              {textPreview.slice(0, 800)}
            </pre>
            <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-surface-0 to-transparent pointer-events-none" />
          </div>
        ) : (
          <div className="h-20 bg-surface-0 flex items-center justify-center border-b border-border-subtle shrink-0">
            {loadingPreview
              ? <span className="text-[10px] text-text-muted animate-pulse">Loading…</span>
              : <span className="text-3xl font-mono text-text-muted opacity-30 uppercase">{ext || "?"}</span>
            }
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          <div>
            <h3 className="text-[13px] font-medium text-text-primary break-all leading-snug">{selectedFile.name}</h3>
            <p className="text-[10px] text-text-muted mt-0.5 break-all leading-relaxed">{selectedFile.path}</p>
          </div>

          <div className="flex flex-col gap-2">
            <Row icon={<HardDrive size={12} />} label={t.size} value={formatSize(selectedFile.size)} />
            {(() => {
              // On Windows, copying a file sets `created_at` to NOW (inode creation
              // at the new path) but preserves `modified_at` from the original.
              // That makes `modified < created` for any copied file, which confuses
              // users. We display the OLDER of the two as "Created" (the file's
              // real age) and surface the copy event in a tooltip on hover.
              const realCreated = selectedFile.created_at && selectedFile.modified_at
                ? Math.min(selectedFile.created_at, selectedFile.modified_at)
                : selectedFile.created_at;
              const wasCopied = selectedFile.created_at > selectedFile.modified_at && selectedFile.modified_at > 0;
              const tip = wasCopied
                ? t.addedHereOn.replace("{date}", formatDate(selectedFile.created_at))
                : undefined;
              return (
                <>
                  <Row icon={<Calendar size={12} />} label={t.created} value={formatDate(realCreated)} title={tip} />
                  <Row icon={<Clock size={12} />} label={t.modified} value={formatDate(selectedFile.modified_at)} />
                </>
              );
            })()}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] text-text-muted uppercase tracking-widest font-semibold flex items-center gap-1">
                <Tag size={10} /> {t.tags}
              </span>
              <button onClick={() => setShowTagInput((v) => !v)}
                className="text-[10px] text-accent hover:text-accent-glow transition-colors">{t.addTag}</button>
            </div>
            {showTagInput && (
              <>
                <input autoFocus type="text" value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleAddTag(tagInput); if (e.key === "Escape") setShowTagInput(false); }}
                  placeholder="Tag name…" list="tags-datalist"
                  className="w-full h-6 px-2 mb-2 rounded bg-surface-3 border border-border text-[11px] text-text-primary placeholder-text-muted outline-none focus:border-accent" />
                <datalist id="tags-datalist">
                  {tags.map((t) => <option key={t.id} value={t.name} />)}
                </datalist>
              </>
            )}
            <div className="flex flex-wrap gap-1.5">
              {selectedFile.tags.length === 0 && <span className="text-[11px] text-text-muted">{t.noTags}</span>}
              {selectedFile.tags.map((tag) => (
                <span key={`${tag.id}-${tag.context_id}`}
                  className={clsx("group flex items-center gap-1 px-2 py-0.5 rounded text-[11px]", tag.is_auto && "opacity-70")}
                  style={{ background: tag.color + "22", color: tag.color }}>
                  {tag.name}
                  {!tag.is_auto && tag.context_id !== 0 && (
                    <button
                      onClick={() => invoke("promote_file_tag_to_global", { fileId: selectedFile.id, tagId: tag.id })
                        .then(() => invoke<TagType[]>("get_file_tags", { fileId: selectedFile.id, contextId: ctxId }))
                        .then(updateFileTags.bind(null, selectedFile.id))
                        .catch(console.error)}
                      title="Promote to global"
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-[9px]">↑</button>
                  )}
                  {!tag.is_auto && (
                    <button onClick={() => handleRemoveTag(tag.id)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity"><X size={9} /></button>
                  )}
                </span>
              ))}
            </div>
          </div>
        </div>
      </>)}
    </div>
  );
}

function Row({ icon, label, value, title }: { icon: React.ReactNode; label: string; value: string; title?: string }) {
  return (
    <div className="flex items-start gap-2" title={title}>
      <span className="text-text-muted mt-0.5 shrink-0">{icon}</span>
      <span className="text-[11px] text-text-muted w-16 shrink-0">{label}</span>
      <span className={clsx("text-[11px] text-text-secondary break-all", title && "underline decoration-dotted decoration-text-muted/40 underline-offset-2")}>
        {value}
      </span>
    </div>
  );
}
