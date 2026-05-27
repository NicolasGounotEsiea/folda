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

  const siblingFiles = siblings.filter((s) => !s.is_dir);
  const curIdx = siblingFiles.findIndex((s) => s.path === entry.path);

  const [current, setCurrent] = useState(entry);

  useEffect(() => {
    setCurrent(entry);
  }, [entry]);

  const currentExt = current.name.split(".").pop()?.toLowerCase() ?? "";
  const currentSrc = convertFileSrc(current.path);

  useEffect(() => {
    setTextContent(null);
    if (!TEXT_EXTS.has(currentExt)) return;
    setTextLoading(true);
    invoke<string>("read_file_full", { path: current.path })
      .then((t) => setTextContent(t.slice(0, 16384)))
      .catch(() => setTextContent(null))
      .finally(() => setTextLoading(false));
  }, [current.path, currentExt]);

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
    const idx = siblingFiles.findIndex((s) => s.path === current.path);
    const next = siblingFiles[idx + dir];
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
          {!IMAGE_EXTS.has(currentExt) && !VIDEO_EXTS.has(currentExt) && !AUDIO_EXTS.has(currentExt) && !TEXT_EXTS.has(currentExt) && (
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
              disabled={siblingFiles.findIndex((s) => s.path === current.path) === 0}
              className={clsx(
                "absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center rounded-full bg-surface-3/80 text-text-primary transition-opacity",
                siblingFiles.findIndex((s) => s.path === current.path) === 0 ? "opacity-20 pointer-events-none" : "hover:bg-surface-4"
              )}
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => navigateTo(1)}
              disabled={siblingFiles.findIndex((s) => s.path === current.path) === siblingFiles.length - 1}
              className={clsx(
                "absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center rounded-full bg-surface-3/80 text-text-primary transition-opacity",
                siblingFiles.findIndex((s) => s.path === current.path) === siblingFiles.length - 1 ? "opacity-20 pointer-events-none" : "hover:bg-surface-4"
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
