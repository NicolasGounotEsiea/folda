import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { clsx } from "clsx";
import { ChevronRight, Download, FilePlus, Folder, Loader2, Lock, Pencil, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
 * Sub-folders ARE supported: the index keys are `/`-separated relative paths, so
 * the folder tree is reconstructed here from `vault_list(sub_path)` while the
 * blobs stay flat on disk. `subPath` tracks the folder currently being viewed.
 *
 * Also supported: inline rename (files + whole folders, via `vault_rename` — just
 * re-keys the index, no blob touched) and "Extract to…" (decrypt a copy OUT to a
 * chosen folder via `vault_extract_file`, keeping the original in the vault).
 *
 * Deliberately NOT supported yet: native OS drag-and-drop OUT of the vault (would
 * need the tauri-plugin-drag JS binding; "Extract to…" covers the same need).
 */

interface VaultEntry {
  name: string;      // leaf name at the current level
  is_dir: boolean;
  size: number;      // file: bytes; folder: item count
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
  const [subPath, setSubPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteFileTarget, setDeleteFileTarget] = useState<string | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<string | null>(null);
  // Inline rename: which leaf is being edited (+ whether it's a folder, so a file
  // and folder sharing a name at the same level can't collide in the UI).
  const [renaming, setRenaming] = useState<{ name: string; isDir: boolean } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // Guards against commit firing twice (Enter then blur).
  const renameDoneRef = useRef(false);

  const folderName = vaultPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? vaultPath;

  // The full index key for a leaf at the current level.
  const keyFor = (leaf: string) => (subPath ? `${subPath}/${leaf}` : leaf);

  // Reset to the root whenever the vault itself changes (switching vaults).
  useEffect(() => { setSubPath(""); }, [vaultPath]);

  const load = useCallback(async () => {
    try {
      const list = await invoke<VaultEntry[]>("vault_list", { path: vaultPath, subPath });
      setEntries(list);
    } catch (e) {
      // The idle sweeper can lock the vault between renders — that is not an
      // error, it's the feature working. Show an empty state; App will route
      // away on the next vault refresh.
      setEntries([]);
      addToast({ type: "warning", message: t.vaultLockedNow, detail: String(e) });
      refreshVaults();
    }
  }, [vaultPath, subPath, addToast, t.vaultLockedNow]);

  useEffect(() => { load(); }, [load]);

  /** Decrypt to a temp file and hand it to the normal viewer pipeline. */
  const handleOpen = async (leaf: string) => {
    setBusy(true);
    try {
      const key = keyFor(leaf);
      const tmpPath = await invoke<string>("vault_read_file", { path: vaultPath, name: key });
      const dot = leaf.lastIndexOf(".");
      openFile({
        id: -1,
        path: tmpPath,
        name: leaf,
        extension: dot > 0 ? leaf.slice(dot + 1).toLowerCase() : "",
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

  /** Pick files from disk, encrypt them into the CURRENT folder, delete originals. */
  const handleAdd = async () => {
    const picked = await openDialog({ multiple: true, directory: false });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    setBusy(true);
    let ok = 0;
    for (const src of paths) {
      try {
        await invoke("vault_add_file", { path: vaultPath, src, destDir: subPath });
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

  const handleDeleteFile = async (leaf: string) => {
    setBusy(true);
    try {
      await invoke("vault_delete_file", { path: vaultPath, name: keyFor(leaf) });
      await load();
    } catch (e) {
      addToast({ type: "error", message: t.vaultDeleteFailed, detail: String(e) });
    } finally {
      setBusy(false);
      setDeleteFileTarget(null);
    }
  };

  const handleDeleteFolder = async (leaf: string) => {
    setBusy(true);
    try {
      await invoke("vault_delete_folder", { path: vaultPath, subPath: keyFor(leaf) });
      await load();
    } catch (e) {
      addToast({ type: "error", message: t.vaultDeleteFailed, detail: String(e) });
    } finally {
      setBusy(false);
      setDeleteFolderTarget(null);
    }
  };

  const handleLock = async () => {
    await invoke("vault_lock", { path: vaultPath }).catch(() => {});
    await refreshVaults();
    // App routes back to the normal file list once the vault is no longer
    // in the unlocked set.
  };

  /** Decrypt a file OUT to a user-chosen folder (keeps it in the vault too). */
  const handleExtract = async (leaf: string) => {
    const dest = await openDialog({ directory: true, multiple: false });
    if (!dest || Array.isArray(dest)) return;
    setBusy(true);
    try {
      await invoke("vault_extract_file", { path: vaultPath, name: keyFor(leaf), destDir: dest });
      addToast({ type: "success", message: t.vaultExtractedOne.replace("{name}", leaf) });
    } catch (e) {
      addToast({ type: "error", message: t.vaultExtractFailed, detail: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const startRename = (e: VaultEntry) => {
    setRenaming({ name: e.name, isDir: e.is_dir });
    setRenameValue(e.name);
    renameDoneRef.current = false;
  };
  const cancelRename = () => setRenaming(null);
  const commitRename = async () => {
    if (!renaming || renameDoneRef.current) return;
    renameDoneRef.current = true;
    const next = renameValue.trim();
    const { name: oldName, isDir } = renaming;
    setRenaming(null);
    if (!next || next === oldName) return;
    try {
      await invoke("vault_rename", {
        path: vaultPath, subPath, oldName, newName: next, isDir,
      });
      await load();
    } catch (err) {
      addToast({ type: "error", message: t.vaultRenameFailed, detail: String(err) });
    }
  };

  const nameCell = (e: VaultEntry) =>
    renaming?.name === e.name && renaming.isDir === e.is_dir ? (
      <input
        autoFocus
        value={renameValue}
        onChange={(ev) => setRenameValue(ev.target.value)}
        onClick={(ev) => ev.stopPropagation()}
        onDoubleClick={(ev) => ev.stopPropagation()}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") { ev.preventDefault(); commitRename(); }
          else if (ev.key === "Escape") { ev.preventDefault(); cancelRename(); }
        }}
        onBlur={commitRename}
        className="text-[12px] bg-surface-3 text-text-primary px-1 py-0.5 rounded outline-none ring-1 ring-accent min-w-0 w-full"
      />
    ) : (
      <span className="text-[12px] text-text-primary truncate">{e.name}</span>
    );

  const segments = subPath ? subPath.split("/") : [];

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {deleteFileTarget && (
        <ConfirmDialog
          message={t.vaultDeleteConfirm.replace("{name}", deleteFileTarget)}
          detail={t.vaultDeleteConfirmDetail}
          onConfirm={() => handleDeleteFile(deleteFileTarget)}
          onCancel={() => setDeleteFileTarget(null)}
        />
      )}
      {deleteFolderTarget && (
        <ConfirmDialog
          message={t.vaultDeleteFolderConfirm.replace("{name}", deleteFolderTarget)}
          detail={t.vaultDeleteConfirmDetail}
          onConfirm={() => handleDeleteFolder(deleteFolderTarget)}
          onCancel={() => setDeleteFolderTarget(null)}
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

      {/* Breadcrumb — always shows the vault root; segments are clickable */}
      <div className="flex items-center gap-0.5 px-4 h-8 border-b border-border-subtle shrink-0 text-[11px] overflow-x-auto">
        <button
          onClick={() => setSubPath("")}
          className={clsx(
            "px-1.5 py-0.5 rounded hover:bg-surface-3 transition-colors shrink-0",
            segments.length === 0 ? "text-text-primary font-medium" : "text-text-muted",
          )}
        >
          {t.vaultRoot}
        </button>
        {segments.map((seg, i) => {
          const target = segments.slice(0, i + 1).join("/");
          const isLast = i === segments.length - 1;
          return (
            <span key={target} className="flex items-center gap-0.5 shrink-0">
              <ChevronRight size={11} className="text-text-muted" />
              <button
                onClick={() => setSubPath(target)}
                className={clsx(
                  "px-1.5 py-0.5 rounded hover:bg-surface-3 transition-colors truncate max-w-[160px]",
                  isLast ? "text-text-primary font-medium" : "text-text-muted",
                )}
              >
                {seg}
              </button>
            </span>
          );
        })}
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
          entries.map((e) =>
            e.is_dir ? (
              <div
                key={`d:${e.name}`}
                onDoubleClick={() => setSubPath(keyFor(e.name))}
                className="group grid items-center gap-x-3 px-4 h-9 shrink-0 cursor-pointer select-none hover:bg-surface-2 transition-colors"
                style={{ gridTemplateColumns: "15px 1fr 80px auto" }}
              >
                <Folder size={14} className="text-accent" />
                {nameCell(e)}
                <span className="text-[11px] text-text-muted text-right tabular-nums">
                  {t.vaultItems.replace("{n}", String(e.size))}
                </span>
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={(ev) => { ev.stopPropagation(); startRename(e); }}
                    title={t.rename}
                    className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-all"
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    onClick={(ev) => { ev.stopPropagation(); setDeleteFolderTarget(e.name); }}
                    title={t.delete}
                    className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-red-400 hover:bg-surface-3 transition-all"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>
            ) : (
              <div
                key={`f:${e.name}`}
                onDoubleClick={() => handleOpen(e.name)}
                className="group grid items-center gap-x-3 px-4 h-9 shrink-0 cursor-pointer select-none hover:bg-surface-2 transition-colors"
                style={{ gridTemplateColumns: "15px 1fr 80px auto" }}
              >
                <FileIcon entry={iconEntryFor(e.name)} />
                {nameCell(e)}
                <span className="text-[11px] text-text-muted text-right tabular-nums">
                  {formatSize(e.size)}
                </span>
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={(ev) => { ev.stopPropagation(); handleExtract(e.name); }}
                    title={t.vaultExtract}
                    className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-all"
                  >
                    <Download size={11} />
                  </button>
                  <button
                    onClick={(ev) => { ev.stopPropagation(); startRename(e); }}
                    title={t.rename}
                    className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-all"
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    onClick={(ev) => { ev.stopPropagation(); setDeleteFileTarget(e.name); }}
                    title={t.delete}
                    className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-red-400 hover:bg-surface-3 transition-all"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>
            ),
          )
        )}
      </div>
    </div>
  );
}
