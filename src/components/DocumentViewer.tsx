import { convertFileSrc } from "@tauri-apps/api/core";
import { renderAsync } from "docx-preview";
import { Ban, FileText, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";

export const DOC_EXTS = ["pdf", "doc", "docx", "odt", "rtf"];

const TYPE_LABELS: Record<string, string> = {
  pdf: "PDF", doc: "Word", docx: "Word", odt: "OpenDocument", rtf: "Rich Text",
};

export function DocumentViewer() {
  const { openedFile, closeFile } = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ext = openedFile?.extension.toLowerCase() ?? "";
  const isDocx = ext === "docx" || ext === "doc";
  const isPdf = ext === "pdf";

  useEffect(() => {
    if (!openedFile || !isDocx || !containerRef.current) return;
    setLoading(true);
    setError(null);

    const url = convertFileSrc(openedFile.path);
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (!containerRef.current) return;
        containerRef.current.innerHTML = "";
        return renderAsync(buf, containerRef.current, undefined, {
          inWrapper: false,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          useBase64URL: true,
        });
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openedFile?.path]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeFile();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeFile]);

  if (!openedFile) return null;

  const typeLabel = TYPE_LABELS[ext] ?? ext.toUpperCase();
  const url = convertFileSrc(openedFile.path);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-surface-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-10 bg-surface-1 border-b border-border-subtle shrink-0">
        <FileText size={13} className="text-blue-400 shrink-0" />
        <span className="text-[12px] text-text-primary font-medium truncate flex-1 min-w-0">
          {openedFile.name}
        </span>
        <span className="text-[10px] text-text-muted bg-surface-3 px-1.5 py-0.5 rounded shrink-0">
          {typeLabel}
        </span>
        <button
          onClick={closeFile}
          className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors shrink-0"
          title="Fermer (Échap)"
        >
          <X size={13} />
        </button>
      </div>

      {/* Content */}
      {isPdf ? (
        <iframe
          key={openedFile.path}
          src={url}
          className="flex-1 w-full"
          style={{ border: "none" }}
          title={openedFile.name}
        />
      ) : isDocx ? (
        <div className="flex-1 overflow-y-auto bg-white relative">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-white text-gray-500 text-[12px] animate-pulse z-10">
              Chargement…
            </div>
          )}
          {error && (
            <div className="p-4 text-red-500 text-[12px]">{error}</div>
          )}
          <div
            ref={containerRef}
            className="p-6"
            style={{ fontFamily: "serif", minHeight: "100%" }}
          />
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted">
          <Ban size={28} className="opacity-20" />
          <span className="text-[12px]">Aperçu non disponible pour ce format</span>
          <span className="text-[10px] opacity-50">{typeLabel}</span>
        </div>
      )}
    </div>
  );
}
