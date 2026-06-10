import { invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import { ChevronRight, Folder, FolderOpen, FolderPlus, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ListEntry } from "../types";
import { useTranslation } from "../utils/i18n";

interface Props {
  title?: string;
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export function FolderPickerModal({ title, initialPath, onSelect, onClose }: Props) {
  const t = useTranslation();
  const [path, setPath] = useState(initialPath);
  const [entries, setEntries] = useState<ListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const newFolderRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLoading(true);
    invoke<ListEntry[]>("list_directory", { path, contextId: 0 })
      .then((all) => setEntries(all.filter((e) => e.is_dir)))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [path]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  useEffect(() => {
    if (creatingFolder) newFolderRef.current?.focus();
  }, [creatingFolder]);

  const goUp = () => {
    const norm = path.replace(/\\/g, "/");
    const parent = norm.split("/").slice(0, -1).join("/").replace(/\//g, "\\");
    if (parent) setPath(parent);
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) { setCreatingFolder(false); return; }
    const newPath = `${path}\\${name}`;
    try {
      await invoke("create_directory", { path: newPath });
      setPath(newPath);
    } catch { /* ignore */ }
    setCreatingFolder(false);
    setNewFolderName("");
  };

  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);

  return (
    <div className="modal-backdrop-in fixed inset-0 z-[400] flex items-center justify-center bg-black/60">
      <div className="modal-content-in bg-surface-1 border border-border rounded-xl shadow-2xl flex flex-col w-[520px] max-w-[95vw] h-[420px] max-h-[80vh]">

        {/* Header */}
        <div className="flex items-center gap-2 px-4 h-11 border-b border-border-subtle shrink-0">
          <FolderOpen size={13} className="text-accent shrink-0" />
          <span className="text-[12px] font-medium text-text-primary flex-1">{title ?? t.chooseFolder}</span>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
          >
            <X size={13} />
          </button>
        </div>

        {/* Breadcrumb */}
        <div className="flex items-center gap-0.5 px-3 h-8 bg-surface-0 border-b border-border-subtle shrink-0 overflow-x-auto">
          {parts.map((part, i) => {
            const partPath = parts.slice(0, i + 1).join("\\");
            const fullPath = i === 0 ? `${partPath}\\` : partPath;
            const isLast = i === parts.length - 1;
            return (
              <span key={i} className="flex items-center gap-0.5 shrink-0">
                {i > 0 && <ChevronRight size={10} className="text-text-muted" />}
                <button
                  onClick={() => !isLast && setPath(fullPath)}
                  className={clsx(
                    "text-[11px] px-0.5 rounded transition-colors",
                    isLast
                      ? "text-text-primary font-medium cursor-default"
                      : "text-text-muted hover:text-text-secondary hover:bg-surface-3"
                  )}
                >
                  {part || "\\"}
                </button>
              </span>
            );
          })}
        </div>

        {/* Folder list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-full gap-2 text-text-muted animate-pulse">
              <Loader2 size={14} className="animate-spin" />
              <span className="text-[12px]">{t.loading}</span>
            </div>
          ) : (
            <>
              {/* Go up */}
              <button
                onClick={goUp}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-text-muted hover:bg-surface-2 hover:text-text-primary transition-colors border-b border-border-subtle/50"
              >
                <Folder size={14} className="shrink-0 text-text-muted" />
                <span>..</span>
              </button>

              {entries.length === 0 && !creatingFolder ? (
                <div className="flex items-center justify-center h-20 text-[11px] text-text-muted">
                  {t.emptyFolder}
                </div>
              ) : (
                entries.map((e) => (
                  <button
                    key={e.path}
                    onDoubleClick={() => setPath(e.path)}
                    onClick={() => setPath(e.path)}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors border-b border-border-subtle/30"
                  >
                    <Folder size={14} className="text-yellow-400 shrink-0" />
                    <span className="truncate text-left">{e.name}</span>
                  </button>
                ))
              )}

              {/* New folder input */}
              {creatingFolder && (
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-subtle/30 bg-accent/5">
                  <Folder size={14} className="text-accent shrink-0" />
                  <input
                    ref={newFolderRef}
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") createFolder();
                      if (e.key === "Escape") { setCreatingFolder(false); setNewFolderName(""); }
                    }}
                    onBlur={() => { if (!newFolderName.trim()) { setCreatingFolder(false); } }}
                    placeholder={t.newFolderName}
                    className="flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder-text-muted border-b border-accent"
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-border-subtle shrink-0">
          <button
            onClick={() => { setCreatingFolder(true); setNewFolderName(""); }}
            disabled={creatingFolder}
            title={t.newFolder}
            className="flex items-center gap-1 px-2 h-6 text-[11px] rounded border border-border text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors disabled:opacity-40 shrink-0"
          >
            <FolderPlus size={11} />
            {t.newFolder}
          </button>

          <div className="flex-1 min-w-0">
            <span className="text-[10px] text-text-muted truncate block" title={path}>{path}</span>
          </div>

          <button onClick={onClose} className="px-3 h-7 rounded text-[12px] text-text-secondary hover:bg-surface-3 transition-colors shrink-0">
            {t.cancel}
          </button>
          <button
            onClick={() => onSelect(path)}
            className="px-3 h-7 rounded text-[12px] bg-accent text-white hover:bg-accent/80 transition-colors shrink-0"
          >
            {t.select}
          </button>
        </div>
      </div>
    </div>
  );
}
