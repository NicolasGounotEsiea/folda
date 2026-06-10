import { invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import {
  File, Folder, Loader2, RefreshCw, RotateCcw, Trash2, X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "../utils/i18n";
import { EmptyState } from "./EmptyState";

interface TrashEntry {
  id: string;
  original_path: string;
  name: string;
  is_dir: boolean;
  deleted_at: number;
  size: number;
}

function fmtSize(bytes: number): string {
  if (bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDate(unixSecs: number, today: string, yesterday: string): string {
  const d = new Date(unixSecs * 1000);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffDays === 0) return `${today} ${time}`;
  if (diffDays === 1) return `${yesterday} ${time}`;
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

function parentDir(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const parts = norm.split("/");
  parts.pop();
  return parts.join("\\") || path;
}

export function TrashModal({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const [items, setItems] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await invoke<TrashEntry[]>("list_trash");
      setItems(data);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const handleRestore = async (id: string) => {
    setBusyId(id);
    try {
      await invoke("restore_from_trash", { id });
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (e) { console.error(e); }
    setBusyId(null);
  };

  const handleDelete = async (id: string) => {
    setBusyId(id);
    try {
      await invoke("delete_permanently", { id });
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (e) { console.error(e); }
    setBusyId(null);
  };

  const handleEmpty = async () => {
    setConfirmEmpty(false);
    setLoading(true);
    try {
      await invoke("empty_trash");
      setItems([]);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const totalSize = items.reduce((s, i) => s + i.size, 0);

  return (
    <div className="modal-backdrop-in fixed inset-0 z-[300] flex items-center justify-center bg-black/60">
      <div className="modal-content-in bg-surface-1 border border-border rounded-xl shadow-2xl flex flex-col w-[640px] max-w-[95vw] h-[520px] max-h-[85vh]">

        {/* Header */}
        <div className="flex items-center gap-2 px-4 h-11 border-b border-border-subtle shrink-0">
          <Trash2 size={13} className="text-text-muted shrink-0" />
          <span className="text-[12px] font-medium text-text-primary flex-1">{t.trash}</span>
          {items.length > 0 && (
            <span className="text-[10px] text-text-muted bg-surface-3 px-1.5 py-0.5 rounded">
              {items.length} {items.length !== 1 ? t.elements : t.element} · {fmtSize(totalSize)}
            </span>
          )}
          <button
            onClick={load}
            title={t.refresh}
            className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
          >
            <RefreshCw size={11} />
          </button>
          <button
            onClick={onClose}
            title={t.close}
            className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
          >
            <X size={13} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-full gap-2 text-text-muted animate-pulse">
              <Loader2 size={14} className="animate-spin" />
              <span className="text-[12px]">{t.loading}</span>
            </div>
          ) : items.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <EmptyState
                icon={Trash2}
                title={t.emptyTrashTitle}
                hint={t.emptyTrashHint}
              />
            </div>
          ) : (
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-[10px] text-text-muted border-b border-border-subtle sticky top-0 bg-surface-1 z-10">
                  <th className="text-left px-4 py-2 font-normal">{t.name}</th>
                  <th className="text-left px-3 py-2 font-normal">{t.trashOriginalLocation}</th>
                  <th className="text-right px-3 py-2 font-normal w-36">{t.trashDeletedOn}</th>
                  <th className="text-right px-3 py-2 font-normal w-20">{t.size}</th>
                  <th className="w-20 px-3" />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const busy = busyId === item.id;
                  return (
                    <tr
                      key={item.id}
                      className={clsx(
                        "border-b border-border-subtle/50 group transition-colors",
                        busy ? "opacity-40" : "hover:bg-surface-2"
                      )}
                    >
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {item.is_dir
                            ? <Folder size={13} className="text-yellow-400 shrink-0" />
                            : <File size={13} className="text-text-muted shrink-0" />}
                          <span className="truncate text-text-primary font-medium max-w-[160px]" title={item.name}>
                            {item.name}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-text-muted">
                        <span className="truncate block max-w-[180px] text-[11px]" title={parentDir(item.original_path)}>
                          {parentDir(item.original_path)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-text-muted text-[11px] whitespace-nowrap">
                        {fmtDate(item.deleted_at, t.today, t.yesterday)}
                      </td>
                      <td className="px-3 py-2 text-right text-text-muted tabular-nums text-[11px]">
                        {item.is_dir ? "—" : fmtSize(item.size)}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => handleRestore(item.id)}
                            disabled={busy}
                            title={t.trashRestore}
                            className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-emerald-400 hover:bg-surface-3 transition-colors"
                          >
                            {busy ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                          </button>
                          <button
                            onClick={() => handleDelete(item.id)}
                            disabled={busy}
                            title={t.trashDeletePermanently}
                            className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-red-400 hover:bg-surface-3 transition-colors"
                          >
                            <X size={11} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-border-subtle shrink-0">
          {confirmEmpty ? (
            <>
              <span className="text-[11px] text-text-muted flex-1">
                {t.trashDeletePermanently} {items.length} {items.length !== 1 ? t.elements : t.element} ?
              </span>
              <button
                onClick={() => setConfirmEmpty(false)}
                className="px-3 h-7 rounded text-[12px] text-text-secondary hover:bg-surface-3 transition-colors"
              >
                {t.cancel}
              </button>
              <button
                onClick={handleEmpty}
                className="px-3 h-7 rounded text-[12px] bg-red-600 text-white hover:bg-red-500 transition-colors"
              >
                {t.emptyVerb}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setConfirmEmpty(true)}
                disabled={items.length === 0}
                className="flex items-center gap-1.5 px-3 h-7 rounded text-[12px] text-red-400 hover:text-red-300 hover:bg-surface-3 transition-colors disabled:opacity-30"
              >
                <Trash2 size={11} />
                {t.trashEmptyAction}
              </button>
              <div className="flex-1" />
              <button
                onClick={onClose}
                className="px-3 h-7 rounded text-[12px] text-text-secondary hover:bg-surface-3 transition-colors"
              >
                {t.close}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
