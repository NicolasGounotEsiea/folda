import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import { History, Save, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { useStore } from "../store/useStore";
import { SnapshotPanel } from "./SnapshotPanel";

const MAX_ROWS = 50_000;
const ROW_HEIGHT = 22; // px — must match CSS
const OVERSCAN = 20;

const COL_LETTER = (n: number) => {
  let s = "";
  while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
  return s;
};

type CellValue = string | number | boolean | null;

interface SheetData {
  name: string;
  rows: CellValue[][];
  truncated: boolean;
}

interface Props {
  path: string;
  ext: string;
  onSaved?: () => void;
  onRestored?: () => void;
}

function serializeCSV(rows: string[][]): string {
  return rows.map((row) =>
    row.map((cell) => {
      if (cell.includes(",") || cell.includes('"') || cell.includes("\n")) {
        return '"' + cell.replace(/"/g, '""') + '"';
      }
      return cell;
    }).join(",")
  ).join("\n");
}

function fmtNum(n: number) {
  return n.toLocaleString("fr-FR");
}

export function SpreadsheetViewer({ path, ext, onSaved, onRestored }: Props) {
  const { settings } = useStore();
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [snapshotKey, setSnapshotKey] = useState(0);
  const [rawContent, setRawContent] = useState<string>("");

  // Virtual scroll state
  const scrollRef = useRef<HTMLDivElement>(null);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(500);

  const isCSV = ext === "csv";

  useEffect(() => {
    setLoading(true);
    setError(null);
    setEditMode(false);
    setSheets([]);
    setActiveIdx(0);
    setScrollTop(0);

    if (isCSV) {
      invoke<string>("read_file_full", { path })
        .then((text) => setRawContent(text))
        .catch(() => setRawContent(""));
    }

    const url = convertFileSrc(path);
    let cancelled = false;

    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (cancelled) return;
        const wb = XLSX.read(buf, { type: "array", cellDates: true });
        const parsed: SheetData[] = wb.SheetNames.map((name) => {
          const ws = wb.Sheets[name];
          const raw: CellValue[][] = XLSX.utils.sheet_to_json(ws, {
            header: 1,
            defval: null,
            raw: false,
          }) as CellValue[][];
          const truncated = raw.length > MAX_ROWS;
          return { name, rows: raw.slice(0, MAX_ROWS), truncated };
        });
        setSheets(parsed);
        setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) { setError(String(e)); setLoading(false); }
      });

    return () => { cancelled = true; };
  }, [path]);

  // Track viewport height via ResizeObserver
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);

  const handleSave = async () => {
    if (!tbodyRef.current) return;
    setSaving(true);
    try {
      // In edit mode all rows are rendered, collect from DOM
      const rows: string[][] = [];
      tbodyRef.current.querySelectorAll("tr").forEach((tr) => {
        const cells: string[] = [];
        tr.querySelectorAll(".csv-editable-cell").forEach((td) => {
          cells.push((td as HTMLElement).innerText ?? "");
        });
        if (cells.length > 0) rows.push(cells);
      });
      const newContent = serializeCSV(rows);
      if (settings.snapshotMode === "auto") {
        invoke("create_snapshot", { filePath: path, maxCount: settings.snapshotMaxCount }).catch(() => {});
      }
      await invoke("write_file", { path, content: newContent });
      setRawContent(newContent);
      setEditMode(false);
      setSnapshotKey((k) => k + 1);
      onSaved?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const sheet = sheets[activeIdx];
  const numRows = sheet?.rows.length ?? 0;
  const numCols = sheet ? Math.max(0, ...sheet.rows.map((r) => r.length)) : 0;

  // Virtual window (disabled in edit mode — need all rows in DOM to collect values)
  const startIdx = editMode ? 0 : Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIdx = editMode ? numRows : Math.min(numRows, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const padTop = startIdx * ROW_HEIGHT;
  const padBottom = Math.max(0, (numRows - endIdx) * ROW_HEIGHT);

  return (
    <div className="flex-1 flex overflow-hidden min-h-0">
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Tab bar + controls */}
      <div className="flex items-center gap-1 px-2 py-1 bg-surface-2 border-b border-border-subtle shrink-0 overflow-x-auto">
        {sheets.length > 1 && sheets.map((s, i) => (
          <button
            key={s.name}
            onClick={() => setActiveIdx(i)}
            className={clsx(
              "px-2.5 py-0.5 text-[11px] rounded transition-colors shrink-0 whitespace-nowrap",
              activeIdx === i ? "bg-accent text-white" : "text-text-muted hover:bg-surface-3"
            )}
          >
            {s.name}
          </button>
        ))}

        <div className="flex-1" />

        {isCSV && !editMode && !loading && (
          <button
            onClick={() => setEditMode(true)}
            className="flex items-center gap-1 px-2 h-6 text-[11px] rounded bg-surface-3 border border-border text-text-secondary hover:text-text-primary hover:bg-surface-4 transition-colors shrink-0"
          >
            Éditer
          </button>
        )}
        {isCSV && editMode && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1 px-2 h-6 text-[11px] rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
            >
              <Save size={11} />
              {saving ? "…" : "Sauvegarder"}
            </button>
            <button
              onClick={() => setEditMode(false)}
              className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
            >
              <X size={11} />
            </button>
          </div>
        )}

        <button
          onClick={() => setSnapshotOpen((v) => !v)}
          title="Snapshots"
          className={clsx(
            "w-6 h-6 flex items-center justify-center rounded transition-colors shrink-0",
            snapshotOpen ? "text-accent bg-accent/10" : "text-text-muted hover:text-text-secondary hover:bg-surface-3"
          )}
        >
          <History size={12} />
        </button>
      </div>

      {/* Loading / error */}
      {loading && (
        <div className="flex-1 flex items-center justify-center text-text-muted text-[12px] animate-pulse">
          Chargement…
        </div>
      )}
      {error && (
        <div className="flex-1 flex items-center justify-center text-red-400 text-[12px] px-4 text-center">
          {error}
        </div>
      )}

      {/* Table */}
      {!loading && !error && sheet && (
        <>
          <div
            ref={scrollRef}
            className="flex-1 overflow-auto"
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            {sheet.truncated && (
              <div className="px-3 py-1.5 text-[10px] text-amber-400 bg-amber-400/10 border-b border-amber-400/20">
                Affichage limité aux {fmtNum(MAX_ROWS)} premières lignes
              </div>
            )}
            {editMode && (
              <div className="px-3 py-1 text-[10px] text-accent bg-accent/5 border-b border-accent/20">
                Mode édition — cliquez une cellule pour modifier
              </div>
            )}

            <table className="spreadsheet-table border-collapse text-[12px] select-text">
              <thead>
                <tr>
                  <th className="spreadsheet-row-num" />
                  {Array.from({ length: numCols }, (_, i) => (
                    <th key={i} className="spreadsheet-col-header">{COL_LETTER(i)}</th>
                  ))}
                </tr>
              </thead>
              <tbody ref={tbodyRef}>
                {/* Top spacer */}
                {padTop > 0 && (
                  <tr aria-hidden>
                    <td colSpan={numCols + 1} style={{ height: padTop, padding: 0, border: "none" }} />
                  </tr>
                )}

                {sheet.rows.slice(startIdx, endIdx).map((row, i) => {
                  const ri = startIdx + i;
                  return (
                    <tr key={ri} className="hover:bg-accent/5" style={{ height: ROW_HEIGHT }}>
                      <td className="spreadsheet-row-num">{ri + 1}</td>
                      {Array.from({ length: numCols }, (_, ci) => (
                        <td
                          key={ci}
                          className={clsx("spreadsheet-cell", editMode && "csv-editable-cell")}
                          contentEditable={editMode || undefined}
                          suppressContentEditableWarning
                          onKeyDown={editMode ? (e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              const cells = tbodyRef.current?.querySelectorAll<HTMLElement>(".csv-editable-cell");
                              if (!cells) return;
                              const idx = Array.from(cells).indexOf(e.currentTarget as HTMLElement);
                              cells[idx + numCols]?.focus();
                            } else if (e.key === "Tab") {
                              e.preventDefault();
                              const cells = tbodyRef.current?.querySelectorAll<HTMLElement>(".csv-editable-cell");
                              if (!cells) return;
                              const idx = Array.from(cells).indexOf(e.currentTarget as HTMLElement);
                              cells[e.shiftKey ? idx - 1 : idx + 1]?.focus();
                            }
                          } : undefined}
                        >
                          {row[ci] != null ? String(row[ci]) : ""}
                        </td>
                      ))}
                    </tr>
                  );
                })}

                {/* Bottom spacer */}
                {padBottom > 0 && (
                  <tr aria-hidden>
                    <td colSpan={numCols + 1} style={{ height: padBottom, padding: 0, border: "none" }} />
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Status bar */}
          <div className="flex items-center gap-3 px-3 h-6 bg-surface-2 border-t border-border-subtle shrink-0 text-[10px] text-text-muted select-none">
            <span>{fmtNum(numRows)} ligne{numRows !== 1 ? "s" : ""}</span>
            <span className="text-border">·</span>
            <span>{fmtNum(numCols)} colonne{numCols !== 1 ? "s" : ""}</span>
            {sheets.length > 1 && (
              <>
                <span className="text-border">·</span>
                <span>{sheets.length} feuilles</span>
              </>
            )}
            {sheet.truncated && (
              <>
                <span className="text-border">·</span>
                <span className="text-amber-400">tronqué à {fmtNum(MAX_ROWS)}</span>
              </>
            )}
            {editMode && (
              <>
                <span className="text-border">·</span>
                <span className="text-accent">édition en cours</span>
              </>
            )}
          </div>
        </>
      )}
    </div>

    {snapshotOpen && (
      <SnapshotPanel
        key={snapshotKey}
        filePath={path}
        isBinary={!isCSV}
        currentContent={isCSV ? rawContent : undefined}
        onClose={() => setSnapshotOpen(false)}
        onRestored={() => {
          setSnapshotOpen(false);
          onRestored?.();
        }}
      />
    )}
    </div>
  );
}
