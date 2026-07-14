import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { clsx } from "clsx";
import { FilePlus, Loader2, Lock, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "./EmptyState";
import { ConfirmDialog } from "./ConfirmDialog";
import { FileIcon } from "./FileList";
import { useStore } from "../store/useStore";
import { useToastStore } from "../store/useToastStore";
import { refreshVaults } from "../store/useVaultStore";
import type { ListEntry } from "../types";
import { useTranslation } from "../utils/i18n";

/**
 * The inside of an UNLOCKED vault.
 *
 * A dedicated view rather than a branch inside `FileList`, on purpose. Vault
 * entries are not real files on disk — they are rows in an encrypted index — and
 * feeding them through FileList would drag them into every pipeline that
 * component owns: tags, git status, drag-and-drop to arbitrary destinations,
 * the indexer's `index_file_by_path`, snapshots. Any one of those leaking a
 * decrypted name or byte into `contextual.db` would silently defeat the vault.
 *
 * Keeping them apart makes that leak *structurally impossible* rather than
 * merely avoided — and it gives the user an honest signal that they are in a
 * different, protected space.
 *
 * Deliberately NOT supported in V1 (each would need its own care):
 *   - sub-folders inside a vault (the index is flat)
 *   - renaming inside a vault
 *   - drag-and-drop out of a vault
 */

interface VaultEntry {
  name: string;
  size: number;
  modified_at: number;
}

/** Reuse FileList's icon mapping without pulling in its row machinery. */
function iconEntryFor(name: string): ListEntry {
  const dot = name.lastIndexOf(".");
  return {
    is_dir: false,
    name,
    path: name,
    size: 0,
    created_at: 0,
    modified_at: 0,
    extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
    id: null,
    tags: [],
  };
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function VaultView({ vaultPath }: { vaultPath: string }) {
  const t = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const openFile = useStore((s) => s.openFile);

  const [entries, setEntries] = useState<VaultEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const folderName = vaultPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? vaultPath;

  const load = useCallback(async () => {
    try {
      const list = await invoke<VaultEntry[]>("vault_list", { path: vaultPath });
      setEntries(list);
    } catch (e) {
      // The idle sweeper can lock the vault between renders — that is not an
      // error, it's the feature working. Show an empty state; App will route
      // away on the next vault refresh.
      setEntries([]);
      addToast({ type: "warning", message: t.vaultLockedNow, detail: String(e) });
      refreshVaults();
    }
  }, [vaultPath, addToast, t.vaultLockedNow]);

  useEffect(() => { load(); }, [load]);

  /** Decrypt to a temp file and hand it to the normal viewer pipeline. */
  const handleOpen = async (name: string) => {
    setBusy(true);
    try {
      const tmpPath = await invoke<string>("vault_read_file", { path: vaultPath, name });
      const dot = name.lastIndexOf(".");
      openFile({
        id: -1,
        path: tmpPath,
        name,
        extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
        size: 0,
        created_at: 0,
        modified_at: 0,
        accessed_at: 0,
        tags: [],
      });
    } catch (e) {
      addToast({ type: "error", message: t.vaultOpenFailed, detail: String(e) });
    } finally {
      setBusy(false);
    }
  };

  /** Pick files from disk, encrypt them in, and delete the originals. */
  const handleAdd = async () => {
    const picked = await openDialog({ multiple: true, directory: false });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    setBusy(true);
    let ok = 0;
    for (const src of paths) {
      try {
        await invoke("vault_add_file", { path: vaultPath, src });
        ok++;
      } catch (e) {
        addToast({ type: "error", message: t.vaultAddFailed, detail: String(e) });
      }
    }
    setBusy(false);
    if (ok > 0) {
      addToast({ type: "success", message: t.vaultAdded.replace("{n}", String(ok)) });
      await load();
    }
  };

  const handleDelete = async (name: string) => {
    setBusy(true);
    try {
      await invoke("vault_delete_file", { path: vaultPath, name });
      await load();
    } catch (e) {
      addToast({ type: "error", message: t.vaultDeleteFailed, detail: String(e) });
    } finally {
      setBusy(false);
      setDeleteTarget(null);
    }
  };

  const handleLock = async () => {
    await invoke("vault_lock", { path: vaultPath }).catch(() => {});
    await refreshVaults();
    // App routes back to the normal file list once the vault is no longer
    // in the unlocked set.
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {deleteTarget && (
        <ConfirmDialog
          message={t.vaultDeleteConfirm.replace("{name}", deleteTarget)}
          detail={t.vaultDeleteConfirmDetail}
          onConfirm={() => handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Header — the "you are in a protected space" signal */}
      <div className="flex items-center gap-2 px-4 h-10 bg-emerald-500/5 border-b border-emerald-500/20 shrink-0">
        <ShieldCheck size={14} className="text-emerald-400 shrink-0" />
        <span className="text-[12px] text-text-primary font-medium truncate">{folderName}</span>
        <span className="text-[11px] text-emerald-400 shrink-0">{t.vaultUnlockedLabel}</span>
        <div className="flex-1" />
        <button
          onClick={handleAdd}
          disabled={busy}
          className="flex items-center gap-1.5 h-7 px-2.5 rounded text-[11px] text-text-secondary border border-border bg-surface-2 hover:bg-surface-3 hover:text-text-primary disabled:opacity-40 transition-colors"
        >
          <FilePlus size={11} /> {t.vaultAddFiles}
        </button>
        <button
          onClick={load}
          disabled={busy}
          title={t.refresh}
          className="w-7 h-7 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 disabled:opacity-40 transition-colors"
        >
          <RefreshCw size={11} />
        </button>
        <button
          onClick={handleLock}
          className="flex items-center gap-1.5 h-7 px-2.5 rounded text-[11px] text-white bg-accent hover:bg-accent/80 transition-colors"
        >
          <Lock size={11} /> {t.vaultLock}
        </button>
      </div>

      {/* Contents */}
      <div className="flex-1 overflow-y-auto flex flex-col">
        {entries === null ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 size={16} className="animate-spin text-text-muted" />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState
              icon={ShieldCheck}
              title={t.vaultEmpty}
              hint={t.vaultEmptyHint}
              action={
                <button onClick={handleAdd} className="text-[11px] text-accent hover:underline">
                  {t.vaultAddFiles}
                </button>
              }
            />
          </div>
        ) : (
          entries.map((e) => (
            <div
              key={e.name}
              onDoubleClick={() => handleOpen(e.name)}
              className={clsx(
                "group grid items-center gap-x-3 px-4 h-9 shrink-0 cursor-pointer select-none",
                "hover:bg-surface-2 transition-colors",
              )}
              style={{ gridTemplateColumns: "15px 1fr 80px 28px" }}
            >
              <FileIcon entry={iconEntryFor(e.name)} />
              <span className="text-[12px] text-text-primary truncate">{e.name}</span>
              <span className="text-[11px] text-text-muted text-right tabular-nums">
                {formatSize(e.size)}
              </span>
              <button
                onClick={(ev) => { ev.stopPropagation(); setDeleteTarget(e.name); }}
                title={t.delete}
                className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-red-400 hover:bg-surface-3 transition-all"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
