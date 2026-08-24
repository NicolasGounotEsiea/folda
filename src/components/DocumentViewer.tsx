import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { renderAsync } from "docx-preview";
import { Ban, ExternalLink, FileText, History, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { useTranslation } from "../utils/i18n";
import { PdfViewer } from "./PdfViewer";
import { SnapshotPanel } from "./SnapshotPanel";
import { SpreadsheetViewer } from "./SpreadsheetViewer";

const TYPE_LABELS: Record<string, string> = {
  pdf: "PDF",
  doc: "Word", docx: "Word", odt: "OpenDocument", rtf: "Rich Text",
  xlsx: "Excel", xls: "Excel", csv: "CSV", ods: "Calc",
  pptx: "PowerPoint", ppt: "PowerPoint",
};

const SPREADSHEET_EXTS = new Set(["xlsx", "xls", "csv", "ods"]);
const PRESENTATION_EXTS = new Set(["pptx", "ppt"]);
const DOCX_EXTS = new Set(["docx", "doc"]);

// ── DOCX inline viewer ────────────────────────────────────────────────────────
function DocxViewer({ path }: { path: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    setLoading(true);
    setError(null);

    let cancelled = false;
    fetch(convertFileSrc(path))
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = "";
        return renderAsync(buf, containerRef.current, undefined, {
          inWrapper: false, ignoreWidth: false, ignoreHeight: false,
          ignoreFonts: false, breakPages: true, useBase64URL: true,
        });
      })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [path]);

  return (
    <div className="flex-1 overflow-y-auto bg-white relative">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white text-gray-400 text-[12px] animate-pulse z-10">
          Chargement…
        </div>
      )}
      {error && <div className="p-4 text-red-500 text-[12px]">{error}</div>}
      <div ref={containerRef} className="p-8" style={{ fontFamily: "serif" }} />
    </div>
  );
}

// ── "Not supported" fallback ──────────────────────────────────────────────────
function UnsupportedView({ label }: { label: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted">
      <Ban size={28} className="opacity-20" />
      <span className="text-[12px]">Aperçu non disponible pour ce format</span>
      <span className="text-[10px] opacity-50">{label}</span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function DocumentViewer() {
  const t = useTranslation();
  const { openedFile, closeFile } = useStore();
  const [reloadKey, setReloadKey] = useState(0);
  const [snapshotOpen, setSnapshotOpen] = useState(false);

  const ext = openedFile?.extension.toLowerCase() ?? "";
  const typeLabel = TYPE_LABELS[ext] ?? ext.toUpperCase();

  const isPdf = ext === "pdf";
  const isDocx = DOCX_EXTS.has(ext);
  const isSpreadsheet = SPREADSHEET_EXTS.has(ext);
  const isPresentation = PRESENTATION_EXTS.has(ext);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") closeFile(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeFile]);

  if (!openedFile) return null;

  const openWithDefault = () =>
    invoke("open_with_default", { path: openedFile.path }).catch(console.error);

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

        {/* Open with system app */}
        <button
          onClick={openWithDefault}
          title={t.openWithSystem}
          className="flex items-center gap-1 px-2 h-6 text-[11px] rounded border border-border text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors shrink-0"
        >
          <ExternalLink size={11} />
          Ouvrir avec…
        </button>

        {/* Snapshot history button — only for non-spreadsheet types (spreadsheet handles it internally) */}
        {!isSpreadsheet && (
          <button
            onClick={() => setSnapshotOpen((v) => !v)}
            title={t.snapshots}
            className={`w-7 h-7 flex items-center justify-center rounded transition-colors shrink-0 ${snapshotOpen ? "text-accent bg-accent/10" : "text-text-muted hover:text-text-secondary hover:bg-surface-3"}`}
          >
            <History size={13} />
          </button>
        )}

        <button
          onClick={closeFile}
          className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors shrink-0"
          title={t.close}
        >
          <X size={13} />
        </button>
      </div>

      {/* Content + optional snapshot panel */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden">
          {isPdf && <PdfViewer key={openedFile.path + reloadKey} path={openedFile.path} />}

          {isDocx && <DocxViewer key={openedFile.path + reloadKey} path={openedFile.path} />}

          {isSpreadsheet && (
            <SpreadsheetViewer
              key={openedFile.path + reloadKey}
              path={openedFile.path}
              ext={ext}
              onSaved={() => setReloadKey((k) => k + 1)}
              onRestored={() => setReloadKey((k) => k + 1)}
            />
          )}

          {isPresentation && <UnsupportedView label={typeLabel} />}

          {!isPdf && !isDocx && !isSpreadsheet && !isPresentation && (
            <UnsupportedView label={typeLabel} />
          )}
        </div>

        {snapshotOpen && !isSpreadsheet && (
          <SnapshotPanel
            filePath={openedFile.path}
            isBinary={true}
            onClose={() => setSnapshotOpen(false)}
            onRestored={() => {
              setReloadKey((k) => k + 1);
              setSnapshotOpen(false);
            }}
          />
        )}
      </div>
    </div>
  );
}
