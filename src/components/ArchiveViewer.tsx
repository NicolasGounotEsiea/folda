import { invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import {
  Archive, ChevronRight, File, FileCode, FileImage,
  FileText, Folder, FolderOpen, Loader2, Package, X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useStore } from "../store/useStore";
import { useTranslation } from "../utils/i18n";
import { FolderPickerModal } from "./FolderPickerModal";

export const ARCHIVE_EXTS = ["zip", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "7z", "rar"];

interface ArchiveEntry {
  path: string;
  name: string;
  is_dir: boolean;
  size: number;
  compressed_size: number;
}

function fmtSize(bytes: number): string {
  if (bytes === 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function entryIcon(entry: ArchiveEntry) {
  if (entry.is_dir) return <Folder size={14} className="text-yellow-400 shrink-0" />;
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  if (["png","jpg","jpeg","gif","webp","svg","bmp","avif","ico"].includes(ext))
    return <FileImage size={14} className="text-pink-400 shrink-0" />;
  if (["pdf","doc","docx","xls","xlsx","csv"].includes(ext))
    return <FileText size={14} className="text-blue-400 shrink-0" />;
  if (["js","ts","tsx","jsx","py","rs","go","java","c","cpp","h","css","html","json","toml","yaml","sh"].includes(ext))
    return <FileCode size={14} className="text-emerald-400 shrink-0" />;
  if (["zip","tar","gz","tgz","7z","rar"].includes(ext))
    return <Package size={14} className="text-orange-400 shrink-0" />;
  return <File size={14} className="text-text-muted shrink-0" />;
}

export function ArchiveViewer() {
  const t = useTranslation();
  const { openedFile, closeFile, currentPath } = useStore();
  const [allEntries, setAllEntries] = useState<ArchiveEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [virtualPath, setVirtualPath] = useState("");
  const [extractDone, setExtractDone] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const ext = openedFile?.extension.toLowerCase() ?? "";
  const isSupported = ["zip", "tar", "tgz", "gz"].includes(ext) ||
    (ext === "gz" && (openedFile?.name.toLowerCase().endsWith(".tar.gz") ?? false));

  useEffect(() => {
    if (!openedFile) return;
    setLoading(true);
    setError(null);
    setVirtualPath("");
    setExtractDone(null);
    if (!isSupported) { setLoading(false); return; }
    invoke<ArchiveEntry[]>("list_archive", { path: openedFile.path })
      .then(setAllEntries)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [openedFile?.path]);

  if (!openedFile) return null;

  const prefix = virtualPath ? `${virtualPath}/` : "";
  const visible = allEntries.filter((e) => {
    if (!e.path.startsWith(prefix)) return false;
    const rel = e.path.slice(prefix.length);
    return !rel.includes("/");
  });

  const sorted = [...visible].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const totalFiles = allEntries.filter((e) => !e.is_dir).length;
  const totalDirs = allEntries.filter((e) => e.is_dir).length;
  const totalSize = allEntries.reduce((s, e) => s + e.size, 0);
  const totalCompressed = allEntries.reduce((s, e) => s + e.compressed_size, 0);

  const breadcrumbParts = virtualPath ? virtualPath.split("/") : [];

  const navigateTo = (path: string) => {
    setVirtualPath(path);
    setExtractDone(null);
  };

  const extractHere = async () => {
    if (!openedFile || !currentPath) return;
    const archiveName = openedFile.name.replace(/\.(tar\.gz|tgz|tar|zip|gz)$/i, "");
    const dest = `${currentPath}\\${archiveName}`;
    setExtracting(true);
    setExtractDone(null);
    try {
      const count = await invoke<number>("extract_archive", { path: openedFile.path, dest });
      setExtractDone(`${count} ${t.archiveExtracted} "${archiveName}"`);
    } catch (e) {
      setError(String(e));
    } finally {
      setExtracting(false);
    }
  };

  const extractTo = async (dest: string) => {
    if (!openedFile) return;
    setPickerOpen(false);
    setExtracting(true);
    setExtractDone(null);
    try {
      const count = await invoke<number>("extract_archive", { path: openedFile.path, dest });
      setExtractDone(`${count} ${t.archiveExtracted}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setExtracting(false);
    }
  };

  const typeLabel = ext.toUpperCase();

  return (
    <>
    <div className="flex-1 flex flex-col overflow-hidden bg-surface-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-10 bg-surface-1 border-b border-border-subtle shrink-0">
        <Package size={13} className="text-orange-400 shrink-0" />
        <span className="text-[12px] text-text-primary font-medium truncate flex-1 min-w-0">
          {openedFile.name}
        </span>
        <span className="text-[10px] text-text-muted bg-surface-3 px-1.5 py-0.5 rounded shrink-0">
          {typeLabel}
        </span>

        {isSupported && !loading && !error && (
          <>
            <button
              onClick={extractHere}
              disabled={extracting}
              className="flex items-center gap-1 px-2.5 h-6 rounded text-[11px] bg-surface-3 border border-border text-text-secondary hover:text-text-primary hover:bg-surface-4 transition-colors shrink-0 disabled:opacity-40"
            >
              {extracting ? <Loader2 size={10} className="animate-spin" /> : <Archive size={10} />}
              {t.archiveExtractHere}
            </button>
            <button
              onClick={() => setPickerOpen(true)}
              disabled={extracting}
              className="flex items-center gap-1 px-2.5 h-6 rounded text-[11px] bg-accent text-white hover:bg-accent/80 transition-colors shrink-0 disabled:opacity-40"
            >
              {t.archiveExtractTo}
            </button>
          </>
        )}

        <button
          onClick={closeFile}
          className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors shrink-0"
          title={t.close}
        >
          <X size={13} />
        </button>
      </div>

      {/* Breadcrumb navigation */}
      {isSupported && !loading && !error && (
        <div className="flex items-center gap-0.5 px-3 h-7 bg-surface-1 border-b border-border-subtle shrink-0 overflow-x-auto">
          <button
            onClick={() => navigateTo("")}
            className={clsx(
              "text-[11px] shrink-0 transition-colors",
              virtualPath === "" ? "text-text-primary font-medium" : "text-text-muted hover:text-text-secondary"
            )}
          >
            {openedFile.name}
          </button>
          {breadcrumbParts.map((part, i) => {
            const partPath = breadcrumbParts.slice(0, i + 1).join("/");
            const isLast = i === breadcrumbParts.length - 1;
            return (
              <span key={partPath} className="flex items-center gap-0.5 shrink-0">
                <ChevronRight size={10} className="text-text-muted" />
                <button
                  onClick={() => navigateTo(partPath)}
                  className={clsx(
                    "text-[11px] transition-colors",
                    isLast ? "text-text-primary font-medium" : "text-text-muted hover:text-text-secondary"
                  )}
                >
                  {part}
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center gap-2 text-text-muted text-[12px] animate-pulse">
          <Loader2 size={14} className="animate-spin" />
          {t.archiveReading}
        </div>
      ) : error ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted">
          <Package size={28} className="opacity-20" />
          <span className="text-[12px] text-red-400">{error}</span>
          <span className="text-[10px] opacity-60">{t.archiveFormats}</span>
        </div>
      ) : !isSupported ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted">
          <Package size={28} className="opacity-20" />
          <span className="text-[12px]">{t.archiveUnsupported}</span>
          <span className="text-[10px] opacity-60">{t.archiveOpenWith}</span>
        </div>
      ) : (
        <>
          {extractDone && (
            <div className="px-3 py-1.5 bg-emerald-950/60 border-b border-emerald-900/50 text-emerald-400 text-[11px] shrink-0 flex items-center gap-2">
              <span>✓ {extractDone}</span>
              <button onClick={() => setExtractDone(null)} className="ml-auto text-emerald-600 hover:text-emerald-400">
                <X size={11} />
              </button>
            </div>
          )}

          {/* Go up */}
          {virtualPath !== "" && (
            <button
              onClick={() => {
                const parts = virtualPath.split("/");
                parts.pop();
                navigateTo(parts.join("/"));
              }}
              className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-muted hover:bg-surface-2 hover:text-text-primary transition-colors border-b border-border-subtle shrink-0"
            >
              <FolderOpen size={14} className="shrink-0" />
              ..
            </button>
          )}

          <div className="flex-1 overflow-y-auto">
            {sorted.length === 0 ? (
              <div className="flex items-center justify-center h-full text-text-muted text-[12px]">
                {t.emptyFolder}
              </div>
            ) : (
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-[10px] text-text-muted border-b border-border-subtle">
                    <th className="text-left px-3 py-1.5 font-normal">{t.name}</th>
                    <th className="text-right px-3 py-1.5 font-normal w-24">{t.size}</th>
                    <th className="text-right px-3 py-1.5 font-normal w-24">{t.archiveCompressed}</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((entry) => (
                    <tr
                      key={entry.path}
                      onClick={() => entry.is_dir && navigateTo(entry.path)}
                      className={clsx(
                        "border-b border-border-subtle/50 transition-colors group",
                        entry.is_dir
                          ? "cursor-pointer hover:bg-surface-2"
                          : "hover:bg-surface-1/50"
                      )}
                    >
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          {entryIcon(entry)}
                          <span className={clsx(
                            "truncate",
                            entry.is_dir ? "text-text-primary font-medium" : "text-text-secondary"
                          )}>
                            {entry.name}
                          </span>
                          {entry.is_dir && (
                            <ChevronRight size={11} className="text-text-muted shrink-0 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-1.5 text-right text-text-muted tabular-nums">
                        {entry.is_dir ? "—" : fmtSize(entry.size)}
                      </td>
                      <td className="px-3 py-1.5 text-right text-text-muted tabular-nums">
                        {entry.is_dir || entry.compressed_size === 0 ? "—" : fmtSize(entry.compressed_size)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Status bar */}
          <div className="flex items-center gap-3 px-3 h-6 bg-surface-1 border-t border-border-subtle shrink-0 text-[10px] text-text-muted select-none">
            <span>{totalFiles} {totalFiles !== 1 ? t.files.toLowerCase() : t.file}</span>
            {totalDirs > 0 && (
              <>
                <span className="text-border">·</span>
                <span>{totalDirs} {totalDirs !== 1 ? t.folders.toLowerCase() : t.folder}</span>
              </>
            )}
            <span className="text-border">·</span>
            <span>{fmtSize(totalSize)} {t.archiveUncompressed}</span>
            {totalCompressed > 0 && (
              <>
                <span className="text-border">·</span>
                <span>{fmtSize(totalCompressed)} {t.archiveCompressed.toLowerCase()}</span>
                <span className="text-border">·</span>
                <span className="text-emerald-500">
                  {Math.round((1 - totalCompressed / totalSize) * 100)}% {t.archiveSaved}
                </span>
              </>
            )}
          </div>
        </>
      )}
    </div>

    {pickerOpen && currentPath && (
      <FolderPickerModal
        title={t.archiveExtractTo}
        initialPath={currentPath}
        onSelect={extractTo}
        onClose={() => setPickerOpen(false)}
      />
    )}
    </>
  );
}
