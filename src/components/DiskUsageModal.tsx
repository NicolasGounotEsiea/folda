import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { getCachedFolderSizes, cacheFolderSizes } from "../utils/folderSizeCache";

interface Entry { name: string; path: string; size: number; is_dir: boolean; }

function fmt(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function DiskUsageModal({ path, onClose, onNavigate: _onNavigate }: {
  path: string;
  onClose: () => void;
  onNavigate: (p: string) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentPath, setCurrentPath] = useState(path);

  useEffect(() => {
    const cached = getCachedFolderSizes(currentPath);
    if (cached) {
      setEntries(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    invoke<Entry[]>("get_folder_sizes", { path: currentPath })
      .then((rows) => {
        if (cancelled) return;
        cacheFolderSizes(currentPath, rows);
        setEntries(rows);
      })
      .catch(console.error)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentPath]);

  const total = entries.reduce((s, e) => s + e.size, 0);

  return (
    <div className="modal-backdrop-in fixed inset-0 z-[400] flex items-center justify-center bg-black/60">
      <div className="modal-content-in bg-surface-1 border border-border rounded-xl shadow-2xl w-[600px] max-h-[80vh] flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle shrink-0">
          <span className="text-[13px] font-semibold text-text-primary flex-1 truncate">
            Disk Usage — {currentPath.replace(/\\/g, "/").split("/").pop()}
          </span>
          <button onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3">
            <X size={13} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-1.5">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-[12px] text-text-muted">Calculating…</div>
          ) : entries.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-[12px] text-text-muted">Empty folder</div>
          ) : entries.map((e) => {
            const pct = total > 0 ? (e.size / total) * 100 : 0;
            return (
              <div key={e.path} className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between text-[11px]">
                  <button
                    onClick={() => e.is_dir ? setCurrentPath(e.path) : undefined}
                    className={e.is_dir ? "text-text-primary hover:text-accent truncate max-w-[400px] text-left" : "text-text-secondary truncate max-w-[400px] text-left cursor-default"}
                  >
                    {e.is_dir ? "📁 " : "📄 "}{e.name}
                  </button>
                  <span className="text-text-muted shrink-0 ml-2">{fmt(e.size)}</span>
                </div>
                <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden">
                  <div
                    className={e.is_dir ? "h-full bg-yellow-400/70 rounded-full" : "h-full bg-accent/60 rounded-full"}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        {total > 0 && (
          <div className="px-4 py-2 border-t border-border-subtle text-[11px] text-text-muted flex justify-between shrink-0">
            <span>{entries.length} items · <span className="opacity-60">node_modules, .git, target excluded</span></span>
            <span>Total: {fmt(total)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
