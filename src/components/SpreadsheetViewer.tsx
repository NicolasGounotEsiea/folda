import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import { ArrowDown, ArrowUp, ArrowUpDown, Filter, History, ListFilter, Save, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useViewerFindStore } from "../store/useViewerFindStore";
import * as XLSX from "xlsx";
import { useStore } from "../store/useStore";
import { useTranslation } from "../utils/i18n";
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

function fmtNum(n: number, lang: string) {
  // "fr" → French digit grouping (1 234), "en" → English (1,234). Default to user-locale.
  const tag = lang === "fr" ? "fr-FR" : lang === "en" ? "en-US" : undefined;
  return n.toLocaleString(tag);
}

export function SpreadsheetViewer({ path, ext, onSaved, onRestored }: Props) {
  const { settings } = useStore();
  const t = useTranslation();
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

  // ── View controls (header-row, sort, filter) ──────────────────────────────
  // Auto-on by default. Most CSVs and small spreadsheets have a header row.
  const [useHeader, setUseHeader] = useState(true);
  // sortCol: column index in DISPLAYED columns (matches header order). null = no sort.
  const [sortCol, setSortCol] = useState<number | null>(null);
  // null = ascending, "desc" = descending. Click cycles asc → desc → off.
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filter, setFilter] = useState("");
  const [showFilter, setShowFilter] = useState(false);
  // Edit-mode Find: scroll-to-match instead of filter (which would drop edited
  // rows from the DOM and lose their changes). `findHit` is the current row idx;
  // null means no result yet for the current query. `findEditQuery` is the input.
  const [showFindEdit, setShowFindEdit] = useState(false);
  const [findEditQuery, setFindEditQuery] = useState("");
  const [findHit, setFindHit] = useState<number | null>(null);
  // Per-column filters: keyed by column index, value is the substring to match.
  // Multiple column filters are AND'd; the global filter (above) is also AND'd.
  // Empty / whitespace-only entries are ignored.
  const [columnFilters, setColumnFilters] = useState<Record<number, string>>({});
  const [showColumnFilters, setShowColumnFilters] = useState(false);

  // Ctrl+F → route to the right find UI for the current mode.
  // View mode: open the global filter (current behavior, hides non-matching rows).
  // Edit mode: open the find-in-edit overlay which scrolls to matches WITHOUT
  //   hiding rows — critical because edit mode reads contentEditable values
  //   from the DOM, and a hidden row's edits would be lost on save.
  // The ref+inline-check pattern lets the handler read the latest editMode
  // without re-registering on every mode toggle.
  const editModeRef = useRef(editMode);
  editModeRef.current = editMode;
  useEffect(() => {
    useViewerFindStore.getState().setHandler(() => {
      if (editModeRef.current) {
        setShowFindEdit(true);
      } else {
        setShowFilter(true);
      }
    });
    return () => useViewerFindStore.getState().setHandler(null);
  }, []);

  // Reset view controls when switching sheet
  useEffect(() => {
    setSortCol(null); setSortDir("asc");
    setColumnFilters({});
  }, [activeIdx]);

  const activeColumnFilters = useMemo(
    () => Object.entries(columnFilters).filter(([, v]) => v.trim().length > 0),
    [columnFilters]
  );

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
  const totalRows = sheet?.rows.length ?? 0;
  const numCols = sheet ? Math.max(0, ...sheet.rows.map((r) => r.length)) : 0;

  // ── Header detection ─────────────────────────────────────────────────────
  // When useHeader is on AND the sheet has at least one row, use row[0] as labels.
  // Edit mode always shows the original column letters and ALL rows, so the user
  // can't accidentally save reordered data.
  const headerActive = useHeader && !editMode && totalRows > 0;
  const headerLabels: string[] = useMemo(() => {
    if (!sheet) return [];
    if (headerActive) {
      const first = sheet.rows[0];
      return Array.from({ length: numCols }, (_, i) => {
        const v = first?.[i];
        const s = v == null ? "" : String(v).trim();
        return s || COL_LETTER(i); // fallback to A/B/C for empty header cells
      });
    }
    return Array.from({ length: numCols }, (_, i) => COL_LETTER(i));
  }, [sheet, headerActive, numCols]);

  // ── Displayed body rows (after header strip + filter + sort) ─────────────
  // We keep the ORIGINAL row index alongside each row so the leftmost column
  // shows the file's true row number, even when sorted/filtered.
  type IndexedRow = { idx: number; row: CellValue[] };
  const bodyRows: IndexedRow[] = useMemo(() => {
    if (!sheet) return [];
    if (editMode) {
      // Edit mode: untouched order, no filter, no sort. All rows.
      return sheet.rows.map((row, i) => ({ idx: i, row }));
    }
    const start = headerActive ? 1 : 0;
    let rows: IndexedRow[] = sheet.rows.slice(start).map((row, i) => ({ idx: start + i, row }));
    // Global filter (case-insensitive, any column)
    const q = filter.trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) => r.row.some((c) => c != null && String(c).toLowerCase().includes(q)));
    }
    // Per-column filters (case-insensitive substring on the targeted column only).
    // Only applied while the column filter row is visible — otherwise the user
    // would see rows disappear with no UI hint why.
    if (showColumnFilters && activeColumnFilters.length) {
      rows = rows.filter((r) =>
        activeColumnFilters.every(([colStr, q]) => {
          const col = Number(colStr);
          const v = r.row[col];
          return v != null && String(v).toLowerCase().includes(q.trim().toLowerCase());
        })
      );
    }
    // Sort
    if (sortCol !== null) {
      const dir = sortDir === "asc" ? 1 : -1;
      const sample = rows.find((r) => r.row[sortCol] != null);
      const tryNum = sample ? Number(sample.row[sortCol]) : NaN;
      const numericMode = !isNaN(tryNum) && rows.every((r) => {
        const v = r.row[sortCol];
        if (v == null || v === "") return true;
        return !isNaN(Number(v));
      });
      rows = [...rows].sort((a, b) => {
        const av = a.row[sortCol]; const bv = b.row[sortCol];
        // Empties go last regardless of direction
        const aEmpty = av == null || av === "";
        const bEmpty = bv == null || bv === "";
        if (aEmpty && bEmpty) return 0;
        if (aEmpty) return 1;
        if (bEmpty) return -1;
        if (numericMode) return (Number(av) - Number(bv)) * dir;
        return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" }) * dir;
      });
    }
    return rows;
  }, [sheet, editMode, headerActive, filter, sortCol, sortDir, showColumnFilters, activeColumnFilters]);

  const numRows = bodyRows.length;

  // Find-in-edit: search forward from `from` for a row whose any cell matches
  // `query` (case-insensitive substring). Returns the index in bodyRows or null.
  // Wraps to the start if nothing past `from`. Direction=-1 searches backward.
  const findNextEdit = (query: string, from: number, direction: 1 | -1 = 1): number | null => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const n = bodyRows.length;
    if (n === 0) return null;
    for (let step = 1; step <= n; step++) {
      const i = ((from + step * direction) % n + n) % n;
      const matched = bodyRows[i].row.some((c) => c != null && String(c).toLowerCase().includes(q));
      if (matched) return i;
    }
    return null;
  };

  // Scroll the row at `idx` (in bodyRows) into view. Edit mode renders all rows
  // so a simple scrollTop = idx * ROW_HEIGHT works — no virtualization offset to
  // account for.
  const scrollToRow = (idx: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const target = idx * ROW_HEIGHT;
    // Centre the row in the viewport when possible.
    const offset = Math.max(0, target - el.clientHeight / 2 + ROW_HEIGHT / 2);
    el.scrollTo({ top: offset, behavior: "smooth" });
  };

  const handleFindEditNext = (direction: 1 | -1 = 1) => {
    const from = findHit ?? -1;
    const next = findNextEdit(findEditQuery, from, direction);
    setFindHit(next);
    if (next !== null) scrollToRow(next);
  };

  // Virtual window (disabled in edit mode — need all rows in DOM to collect values)
  const startIdx = editMode ? 0 : Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIdx = editMode ? numRows : Math.min(numRows, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const padTop = startIdx * ROW_HEIGHT;
  const padBottom = Math.max(0, (numRows - endIdx) * ROW_HEIGHT);

  const cycleSort = (col: number) => {
    if (sortCol !== col) { setSortCol(col); setSortDir("asc"); return; }
    if (sortDir === "asc") { setSortDir("desc"); return; }
    // Already desc → turn sort off
    setSortCol(null); setSortDir("asc");
  };

  return (
    <div className="flex-1 flex overflow-hidden min-h-0">
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden relative">
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

        {/* View controls — hidden while editing because they don't apply.
            Filter would hide rows that the user might still want to edit, and
            the edit-mode save logic reads contentEditable values from the DOM
            — hidden rows would lose their edits. Edit mode gets its own
            scroll-to-match Find overlay instead (see FindInEditOverlay below). */}
        {!editMode && !loading && !error && sheet && (
          <>
            <button
              onClick={() => setUseHeader((v) => !v)}
              title={useHeader ? t.sheetHeaderToggleOn : t.sheetHeaderToggleOff}
              className={clsx(
                "flex items-center gap-1 px-2 h-6 text-[11px] rounded transition-colors shrink-0",
                useHeader ? "bg-accent/15 text-accent" : "bg-surface-3 border border-border text-text-secondary hover:bg-surface-4"
              )}
            >
              <ListFilter size={11} /> {t.sheetHeader}
            </button>

            {/* Global filter — collapsed by default; click or Ctrl+F to open */}
            {showFilter ? (
              <div className="flex items-center gap-1 h-6 px-1.5 rounded bg-surface-3 border border-border shrink-0">
                <Filter size={11} className="text-text-muted" />
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={t.sheetFilterPlaceholder}
                  autoFocus
                  className="bg-transparent text-[11px] text-text-primary placeholder-text-muted outline-none w-32"
                />
                {filter && (
                  <button
                    onClick={() => setFilter("")}
                    className="text-text-muted hover:text-text-primary"
                    title={t.sheetClearFilter}
                  >
                    <X size={11} />
                  </button>
                )}
                <button
                  onClick={() => { setShowFilter(false); setFilter(""); }}
                  className="text-text-muted hover:text-text-primary"
                  title={t.sheetCloseFilter}
                >
                  <X size={11} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowFilter(true)}
                title={t.sheetFilter}
                className="flex items-center gap-1 px-2 h-6 text-[11px] rounded bg-surface-3 border border-border text-text-secondary hover:text-text-primary hover:bg-surface-4 transition-colors shrink-0"
              >
                <Filter size={11} /> {t.sheetFilter}
              </button>
            )}

            {/* Per-column filter row toggle */}
            <button
              onClick={() => setShowColumnFilters((v) => !v)}
              title={showColumnFilters ? t.sheetColumnFiltersHide : t.sheetColumnFiltersShow}
              className={clsx(
                "flex items-center gap-1 px-2 h-6 text-[11px] rounded transition-colors shrink-0",
                showColumnFilters
                  ? "bg-accent/15 text-accent"
                  : "bg-surface-3 border border-border text-text-secondary hover:bg-surface-4"
              )}
            >
              <Filter size={11} /> {t.sheetColumnFilters}
              {activeColumnFilters.length > 0 && (
                <span className="ml-1 min-w-[15px] h-[14px] px-1 rounded-full bg-accent text-[9px] font-bold text-white flex items-center justify-center">
                  {activeColumnFilters.length}
                </span>
              )}
            </button>

            {sortCol !== null && (
              <button
                onClick={() => { setSortCol(null); setSortDir("asc"); }}
                title={t.sheetSortClear}
                className="flex items-center gap-1 px-2 h-6 text-[11px] rounded bg-accent/15 text-accent hover:bg-accent/25 transition-colors shrink-0"
              >
                <ArrowUpDown size={11} /> {t.sheetSortActive}
              </button>
            )}
          </>
        )}

        {isCSV && !editMode && !loading && (
          <button
            onClick={() => setEditMode(true)}
            className="flex items-center gap-1 px-2 h-6 text-[11px] rounded bg-surface-3 border border-border text-text-secondary hover:text-text-primary hover:bg-surface-4 transition-colors shrink-0"
          >
            {t.sheetEdit}
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
              {saving ? "…" : t.sheetSave}
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

      {/* Find-in-edit overlay — floats over the top-right of the editor area.
          Distinct from the global filter: it scrolls to matching cells without
          hiding rows, so DOM-based edit collection stays intact on save. */}
      {showFindEdit && editMode && (
        <div className="absolute right-4 top-12 z-20 flex items-center gap-1 h-7 px-2 rounded bg-surface-2 border border-border shadow-lg">
          <input
            autoFocus
            type="text"
            value={findEditQuery}
            onChange={(e) => {
              setFindEditQuery(e.target.value);
              setFindHit(null); // reset hit so next press starts fresh
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleFindEditNext(e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setShowFindEdit(false);
                setFindEditQuery("");
                setFindHit(null);
              }
            }}
            placeholder={t.sheetFindEditPlaceholder}
            className="bg-transparent text-[11px] text-text-primary placeholder-text-muted outline-none w-40"
          />
          {findEditQuery && (
            <span className="text-[10px] text-text-muted shrink-0">
              {findHit !== null ? `${findHit + 1}/${bodyRows.length}` : "—"}
            </span>
          )}
          <button
            onClick={() => handleFindEditNext(-1)}
            disabled={!findEditQuery}
            title={t.sheetFindPrev}
            className="text-text-muted hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ↑
          </button>
          <button
            onClick={() => handleFindEditNext(1)}
            disabled={!findEditQuery}
            title={t.sheetFindNext}
            className="text-text-muted hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ↓
          </button>
          <button
            onClick={() => { setShowFindEdit(false); setFindEditQuery(""); setFindHit(null); }}
            className="text-text-muted hover:text-text-primary ml-1"
            title={t.sheetCloseFilter}
          >
            <X size={11} />
          </button>
        </div>
      )}

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
                {t.sheetTruncatedTo.replace("{n}", fmtNum(MAX_ROWS, settings.language))}
              </div>
            )}
            {editMode && (
              <div className="px-3 py-1 text-[10px] text-accent bg-accent/5 border-b border-accent/20">
                {t.sheetEditingHint}
              </div>
            )}

            <table className="spreadsheet-table border-collapse text-[12px] select-text">
              <thead>
                <tr>
                  <th className="spreadsheet-row-num" />
                  {Array.from({ length: numCols }, (_, i) => {
                    const isSorted = sortCol === i;
                    const Icon = !isSorted ? ArrowUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
                    const clickable = !editMode;
                    return (
                      <th
                        key={i}
                        className={clsx(
                          "spreadsheet-col-header",
                          clickable && "cursor-pointer hover:bg-surface-4 transition-colors",
                          isSorted && "text-accent"
                        )}
                        onClick={clickable ? () => cycleSort(i) : undefined}
                        title={clickable ? t.sheetSortClick : undefined}
                      >
                        <span className="inline-flex items-center gap-1 truncate">
                          <span className="truncate">{headerLabels[i] ?? COL_LETTER(i)}</span>
                          {clickable && (
                            <Icon size={9} className={clsx(isSorted ? "opacity-100" : "opacity-30")} />
                          )}
                        </span>
                      </th>
                    );
                  })}
                </tr>
                {/* Per-column filter row — sits below the headers, sticky via thead */}
                {showColumnFilters && !editMode && (
                  <tr className="spreadsheet-filter-row">
                    <th className="spreadsheet-row-num spreadsheet-filter-corner">
                      {activeColumnFilters.length > 0 && (
                        <button
                          onClick={() => setColumnFilters({})}
                          title={t.sheetColumnFiltersClearAll}
                          className="w-3.5 h-3.5 flex items-center justify-center rounded text-text-muted hover:text-red-400"
                        >
                          <X size={9} />
                        </button>
                      )}
                    </th>
                    {Array.from({ length: numCols }, (_, i) => {
                      const value = columnFilters[i] ?? "";
                      return (
                        <th key={i} className="spreadsheet-filter-cell">
                          <input
                            type="text"
                            value={value}
                            onChange={(e) => setColumnFilters((m) => ({ ...m, [i]: e.target.value }))}
                            placeholder={t.sheetColumnFilterPlaceholder}
                            className={clsx(
                              "w-full h-5 px-1.5 text-[10px] outline-none rounded border bg-surface-2 transition-colors",
                              value
                                ? "border-accent/40 text-text-primary"
                                : "border-border text-text-secondary placeholder-text-muted focus:border-accent/40"
                            )}
                          />
                        </th>
                      );
                    })}
                  </tr>
                )}
              </thead>
              <tbody ref={tbodyRef}>
                {/* Top spacer */}
                {padTop > 0 && (
                  <tr aria-hidden>
                    <td colSpan={numCols + 1} style={{ height: padTop, padding: 0, border: "none" }} />
                  </tr>
                )}

                {bodyRows.slice(startIdx, endIdx).map((entry) => {
                  const { idx: ri, row } = entry;
                  // In edit mode, the find overlay highlights the current
                  // match. Comparison is against the bodyRows position. We
                  // peek through bodyRows to find which array index this is.
                  const isFindHit = editMode && findHit !== null
                    && bodyRows[findHit]?.idx === ri;
                  return (
                    <tr
                      key={ri}
                      className={clsx("hover:bg-accent/5", isFindHit && "bg-amber-400/20")}
                      style={{ height: ROW_HEIGHT }}
                    >
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
            {/* Body-rows count: shows filtered vs. total when a filter is active */}
            <span>
              {fmtNum(numRows, settings.language)} {numRows !== 1 ? t.sheetRowPlur : t.sheetRowSing}
              {!editMode && filter && numRows !== (headerActive ? totalRows - 1 : totalRows) && (
                <span className="text-text-muted/70"> / {fmtNum(headerActive ? totalRows - 1 : totalRows, settings.language)}</span>
              )}
            </span>
            <span className="text-border">·</span>
            <span>{fmtNum(numCols, settings.language)} {numCols !== 1 ? t.sheetColPlur : t.sheetColSing}</span>
            {sheets.length > 1 && (
              <>
                <span className="text-border">·</span>
                <span>{sheets.length} {t.sheetSheets}</span>
              </>
            )}
            {sheet.truncated && (
              <>
                <span className="text-border">·</span>
                <span className="text-amber-400">{t.sheetTruncatedStatus.replace("{n}", fmtNum(MAX_ROWS, settings.language))}</span>
              </>
            )}
            {!editMode && sortCol !== null && (
              <>
                <span className="text-border">·</span>
                <span className="text-accent">
                  {t.sheetSortedBy} {headerLabels[sortCol] ?? COL_LETTER(sortCol)} ({sortDir === "asc" ? "↑" : "↓"})
                </span>
              </>
            )}
            {!editMode && showColumnFilters && activeColumnFilters.length > 0 && (
              <>
                <span className="text-border">·</span>
                <span className="text-accent">
                  {t.sheetColumnFiltersActive.replace("{n}", String(activeColumnFilters.length))}
                </span>
              </>
            )}
            {editMode && (
              <>
                <span className="text-border">·</span>
                <span className="text-accent">{t.sheetEditing}</span>
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
