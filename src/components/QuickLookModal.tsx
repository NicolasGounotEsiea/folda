import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ListEntry } from "../types";
import { FileIcon } from "./FileList";

const IMAGE_EXTS = new Set(["png","jpg","jpeg","gif","webp","svg","ico","bmp","avif"]);
const VIDEO_EXTS = new Set(["mp4","mkv","avi","mov","webm","m4v"]);
const AUDIO_EXTS = new Set(["mp3","wav","flac","ogg","m4a","aac","opus"]);
const TEXT_EXTS  = new Set(["ts","tsx","js","jsx","rs","py","go","java","c","cpp","h","hpp",
  "css","html","xml","json","toml","yaml","yml","sh","bat","md","txt","log","csv","ini","env"]);
// PDF gets the WebView2 native viewer via <embed>. Zero JS cost — no pdfjs load
// for the QuickLook path (DocumentViewer still uses pdfjs when the user really
// opens the file).
const PDF_EXTS = new Set(["pdf"]);
// Office-ish formats — backend's preview_file returns extracted plain text (up
// to MAX_EXTRACT=3000 chars). Good enough for a Space-bar peek; double-click
// opens the full DocumentViewer with styling.
const DOC_TEXT_EXTS = new Set(["docx","odt","xlsx","ods","pptx","odp"]);
const NOTEBOOK_EXTS = new Set(["ipynb"]);
// Hard cap on the JS-side JSON.parse for ipynb. A 50 MB notebook with base64
// image outputs would lock up the UI thread for seconds. Above this, we show a
// "too large" hint and ask the user to double-click for the full viewer.
const NOTEBOOK_MAX_BYTES = 2 * 1024 * 1024;

interface NotebookCell {
  cell_type: "markdown" | "code" | "raw" | string;
  source: string;
  execution_count?: number | null;
}

function parseNotebook(raw: string): NotebookCell[] | null {
  try {
    const nb = JSON.parse(raw);
    if (!Array.isArray(nb?.cells)) return null;
    return nb.cells.map((c: { cell_type?: string; source?: string | string[]; execution_count?: number | null }) => ({
      cell_type: c.cell_type ?? "raw",
      source: Array.isArray(c.source) ? c.source.join("") : (c.source ?? ""),
      execution_count: c.execution_count ?? null,
    }));
  } catch {
    return null;
  }
}

function formatSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

export function QuickLookModal({
  entry,
  siblings,
  onClose,
}: {
  entry: ListEntry;
  siblings: ListEntry[];
  onClose: () => void;
}) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [notebookCells, setNotebookCells] = useState<NotebookCell[] | null>(null);
  const [notebookTooLarge, setNotebookTooLarge] = useState(false);

  const siblingFiles = siblings.filter((s) => !s.is_dir);

  const [current, setCurrent] = useState(entry);

  useEffect(() => {
    setCurrent(entry);
  }, [entry]);

  // Derived from `current` (the displayed file), NOT from `entry` (the prop the
  // modal was opened with). With entry-based indexing every keyboard ArrowRight
  // repeatedly landed on the SAME next sibling because entry doesn't change while
  // the modal is open — the user saw "it doesn't advance / goes back to the first".
  const curIdx = siblingFiles.findIndex((s) => s.path === current.path);

  const currentExt = current.name.split(".").pop()?.toLowerCase() ?? "";
  const currentSrc = convertFileSrc(current.path);

  useEffect(() => {
    setTextContent(null);
    setNotebookCells(null);
    setNotebookTooLarge(false);

    if (TEXT_EXTS.has(currentExt)) {
      setTextLoading(true);
      invoke<string>("read_file_full", { path: current.path })
        .then((t) => setTextContent(t.slice(0, 16384)))
        .catch(() => setTextContent(null))
        .finally(() => setTextLoading(false));
    } else if (DOC_TEXT_EXTS.has(currentExt)) {
      // preview_file returns cached extraction if the indexer already touched the
      // file; otherwise extracts on-demand (fast for DOCX, slower for big PDFs —
      // but PDFs go through the native <embed> branch below, not here).
      setTextLoading(true);
      invoke<string>("preview_file", { path: current.path })
        .then((t) => setTextContent(t))
        .catch(() => setTextContent(null))
        .finally(() => setTextLoading(false));
    } else if (NOTEBOOK_EXTS.has(currentExt)) {
      // Guard: a notebook stuffed with base64 image outputs can be tens of MB.
      // Parsing on the UI thread would freeze the modal — bail with a hint.
      if (current.size > 0 && current.size > NOTEBOOK_MAX_BYTES) {
        setNotebookTooLarge(true);
        return;
      }
      setTextLoading(true);
      invoke<string>("read_file_full", { path: current.path })
        .then((raw) => {
          const cells = parseNotebook(raw);
          setNotebookCells(cells);
        })
        .catch(() => setNotebookCells(null))
        .finally(() => setTextLoading(false));
    }
    // PDF needs no fetch — <embed> handles it via the asset URL directly.
  }, [current.path, currentExt, current.size]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === " ") { e.preventDefault(); onClose(); }
      if (e.key === "ArrowRight") {
        const next = siblingFiles[curIdx + 1];
        if (next) setCurrent(next);
      }
      if (e.key === "ArrowLeft") {
        const prev = siblingFiles[curIdx - 1];
        if (prev) setCurrent(prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, curIdx, siblingFiles]);

  const navigateTo = (dir: -1 | 1) => {
    const next = siblingFiles[curIdx + dir];
    if (next) setCurrent(next);
  };

  return (
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center bg-black/70"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative bg-surface-1 border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ maxWidth: "min(900px, 90vw)", maxHeight: "85vh", minWidth: 320 }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-subtle shrink-0">
          <FileIcon entry={current} />
          <span className="text-[13px] font-medium text-text-primary truncate flex-1">{current.name}</span>
          {current.size > 0 && (
            <span className="text-[11px] text-text-muted shrink-0">{formatSize(current.size)}</span>
          )}
          <button onClick={onClose} className="ml-2 text-text-muted hover:text-text-primary transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto flex items-center justify-center bg-surface-0 min-h-0">
          {IMAGE_EXTS.has(currentExt) && (
            <img
              src={currentSrc}
              alt={current.name}
              className="max-w-full max-h-full object-contain"
              style={{ maxHeight: "calc(85vh - 100px)" }}
            />
          )}
          {VIDEO_EXTS.has(currentExt) && (
            <video
              src={currentSrc}
              controls
              autoPlay
              className="max-w-full max-h-full"
              style={{ maxHeight: "calc(85vh - 100px)" }}
            />
          )}
          {AUDIO_EXTS.has(currentExt) && (
            <div className="flex flex-col items-center gap-4 p-8">
              <div className="w-20 h-20 rounded-2xl bg-surface-3 flex items-center justify-center">
                <span className="text-3xl">🎵</span>
              </div>
              <p className="text-[13px] text-text-primary">{current.name}</p>
              <audio src={currentSrc} controls autoPlay />
            </div>
          )}
          {TEXT_EXTS.has(currentExt) && (
            textLoading
              ? <span className="text-text-muted text-[12px] p-8">Loading…</span>
              : textContent !== null
                ? (
                  <pre className="text-[11px] leading-relaxed text-text-secondary overflow-auto w-full h-full p-4 font-mono whitespace-pre-wrap break-all">
                    {textContent}
                    {textContent.length >= 16384 && (
                      <span className="text-text-muted">… (truncated)</span>
                    )}
                  </pre>
                )
                : <span className="text-text-muted text-[12px] p-8">Could not read file</span>
          )}
          {PDF_EXTS.has(currentExt) && (
            // WebView2's built-in PDF viewer. Has its own toolbar (page nav, zoom,
            // print) so we don't reimplement those. Instant first paint; the PDF
            // streams in as bytes arrive.
            <embed
              src={currentSrc}
              type="application/pdf"
              className="w-full h-full"
              style={{ minHeight: "calc(85vh - 100px)" }}
            />
          )}
          {DOC_TEXT_EXTS.has(currentExt) && (
            textLoading
              ? <span className="text-text-muted text-[12px] p-8">Loading…</span>
              : textContent !== null && textContent.length > 0
                ? (
                  <pre className="text-[11px] leading-relaxed text-text-secondary overflow-auto w-full h-full p-4 whitespace-pre-wrap break-words">
                    {textContent}
                    {textContent.length >= 3000 && (
                      <span className="text-text-muted">{"\n\n"}… (extract truncated — double-click to open the full document)</span>
                    )}
                  </pre>
                )
                : <span className="text-text-muted text-[12px] p-8">No text could be extracted — double-click to open in the document viewer</span>
          )}
          {NOTEBOOK_EXTS.has(currentExt) && (
            notebookTooLarge
              ? (
                <div className="flex flex-col items-center gap-2 p-8 text-text-muted text-center">
                  <p className="text-[12px]">Notebook is too large for a quick preview ({formatSize(current.size)})</p>
                  <p className="text-[11px] opacity-70">Double-click to open it in the full viewer</p>
                </div>
              )
              : textLoading
                ? <span className="text-text-muted text-[12px] p-8">Loading…</span>
                : notebookCells === null
                  ? <span className="text-text-muted text-[12px] p-8">Could not parse the notebook</span>
                  : (
                    <div className="w-full h-full overflow-auto p-3 flex flex-col gap-2">
                      {notebookCells.map((cell, i) => (
                        <div
                          key={i}
                          className={clsx(
                            "rounded border text-[11px] leading-relaxed",
                            cell.cell_type === "code"
                              ? "bg-surface-2 border-border"
                              : cell.cell_type === "markdown"
                                ? "bg-transparent border-border-subtle"
                                : "bg-surface-2/50 border-border-subtle"
                          )}
                        >
                          <div className="px-2 py-0.5 text-[9px] uppercase tracking-wider text-text-muted border-b border-border-subtle flex items-center gap-2">
                            <span>{cell.cell_type}</span>
                            {cell.cell_type === "code" && cell.execution_count != null && (
                              <span className="opacity-60">[{cell.execution_count}]</span>
                            )}
                          </div>
                          <pre className={clsx(
                            "px-3 py-2 overflow-auto whitespace-pre-wrap break-words",
                            cell.cell_type === "code"
                              ? "font-mono text-text-secondary"
                              : "text-text-primary",
                          )}>
                            {cell.source}
                          </pre>
                        </div>
                      ))}
                    </div>
                  )
          )}
          {!IMAGE_EXTS.has(currentExt) && !VIDEO_EXTS.has(currentExt) && !AUDIO_EXTS.has(currentExt)
            && !TEXT_EXTS.has(currentExt) && !PDF_EXTS.has(currentExt)
            && !DOC_TEXT_EXTS.has(currentExt) && !NOTEBOOK_EXTS.has(currentExt) && (
            <div className="flex flex-col items-center gap-3 p-8 text-text-muted">
              <FileIcon entry={current} />
              <p className="text-[12px]">{current.name}</p>
              {current.size > 0 && <p className="text-[11px]">{formatSize(current.size)}</p>}
              <p className="text-[11px] opacity-60">No preview available</p>
            </div>
          )}
        </div>

        {/* Nav arrows */}
        {siblingFiles.length > 1 && (
          <>
            <button
              onClick={() => navigateTo(-1)}
              disabled={curIdx === 0}
              className={clsx(
                "absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center rounded-full bg-surface-3/80 text-text-primary transition-opacity",
                curIdx === 0 ? "opacity-20 pointer-events-none" : "hover:bg-surface-4"
              )}
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => navigateTo(1)}
              disabled={curIdx === siblingFiles.length - 1}
              className={clsx(
                "absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center rounded-full bg-surface-3/80 text-text-primary transition-opacity",
                curIdx === siblingFiles.length - 1 ? "opacity-20 pointer-events-none" : "hover:bg-surface-4"
              )}
            >
              <ChevronRight size={16} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
