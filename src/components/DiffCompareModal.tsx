import { invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import { ChevronDown, ChevronsDown, ChevronsUp, ChevronsUpDown, ChevronUp, FileText, Minus, X } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../utils/i18n";

// ── Backend type mirrors ─────────────────────────────────────────────────────

interface DiffRow {
  kind: "equal" | "delete" | "insert" | "modify";
  left_no: number | null;
  right_no: number | null;
  left: string;   // may contain <del>...</del> markers for "modify"
  right: string;  // may contain <ins>...</ins> markers for "modify"
}

interface DiffHunk {
  old_start: number;
  new_start: number;
  rows: DiffRow[];
}

interface DiffResult {
  identical: boolean;
  hunks: DiffHunk[];
  total_lines: number;
}

// ── Safe intra-line marker renderer ──────────────────────────────────────────
//
// Intra-line markers use Private Use Area codepoints — see the matching
// `MARK_*` constants in src-tauri/src/commands/files.rs. These can never
// appear in normal text files, so they never collide with content that
// happens to contain HTML-looking tags (e.g. comparing two .html files
// where the actual content is `<del>...</del>`).
const MARK_DEL_OPEN = "";
const MARK_DEL_CLOSE = "";
const MARK_INS_OPEN = "";
const MARK_INS_CLOSE = "";

// Render whitespace characters as visible glyphs. Only called for the inner
// content of a marker span (the part that actually changed), so unchanged
// whitespace stays invisible — only the diff highlights show whitespace
// edits, which is when the user really needs to see them (trailing space
// added/removed, tab→space conversion, etc.). opacity-50 keeps the glyphs
// hinted, not dominant.
function renderWithVisibleWhitespace(content: string): React.ReactNode {
  if (!content) return null;
  const out: React.ReactNode[] = [];
  let buf = "";
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === " " || ch === "\t") {
      if (buf) { out.push(<React.Fragment key={`t${i}`}>{buf}</React.Fragment>); buf = ""; }
      out.push(<span key={i} className="opacity-50">{ch === " " ? "·" : "→"}</span>);
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(<React.Fragment key="tail">{buf}</React.Fragment>);
  return out;
}

function renderInline(line: string, side: "del" | "ins"): React.ReactNode {
  if (!line) return " "; // NBSP keeps the row from collapsing to 0 height
  const tagOpen = side === "del" ? MARK_DEL_OPEN : MARK_INS_OPEN;
  const tagClose = side === "del" ? MARK_DEL_CLOSE : MARK_INS_CLOSE;
  const cls = side === "del"
    ? "bg-red-500/50 text-red-50 rounded-sm"
    : "bg-emerald-500/50 text-emerald-50 rounded-sm";

  // Manual scan instead of RegExp — keeps the PUA marker chars from
  // bumping into any subtle regex-escaping behavior, and the walk is
  // dead-simple to reason about: find an open, find the matching close,
  // emit text+span; repeat.
  const out: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  while (cursor < line.length) {
    const openIdx = line.indexOf(tagOpen, cursor);
    if (openIdx === -1) {
      out.push(<React.Fragment key={key++}>{line.slice(cursor)}</React.Fragment>);
      break;
    }
    if (openIdx > cursor) {
      out.push(<React.Fragment key={key++}>{line.slice(cursor, openIdx)}</React.Fragment>);
    }
    const closeIdx = line.indexOf(tagClose, openIdx + tagOpen.length);
    if (closeIdx === -1) {
      // Malformed (open without close) — render rest as plain text so we
      // never accidentally show the PUA glyphs as garbled boxes.
      out.push(<React.Fragment key={key++}>{line.slice(openIdx + tagOpen.length)}</React.Fragment>);
      break;
    }
    const inner = line.slice(openIdx + tagOpen.length, closeIdx);
    out.push(<span key={key++} className={cls}>{renderWithVisibleWhitespace(inner)}</span>);
    cursor = closeIdx + tagClose.length;
  }
  return out;
}

// ── Single row (one line on each side) ───────────────────────────────────────
//
// Four kinds:
//   equal   — same content on both sides, neutral background
//   delete  — only left has content, red background spanning the row
//   insert  — only right has content, green background spanning the row
//   modify  — both have content, with intra-line <del>/<ins> highlights

function Row({ row, isActiveDiff, diffAnchor }: {
  row: DiffRow;
  // Whether this row is part of the currently-active diff GROUP (a maximal
  // run of consecutive non-equal rows). True for every row in that group.
  isActiveDiff?: boolean;
  // Set to the diff index ONLY on the first row of each diff group. That's
  // the scroll-to anchor goToDiff queries. Other rows in the same group
  // don't carry it.
  diffAnchor?: number;
}) {
  const leftBg = row.kind === "delete" || row.kind === "modify"
    ? "bg-red-500/10"
    : row.kind === "insert" ? "bg-surface-2/30" : "";
  const rightBg = row.kind === "insert" || row.kind === "modify"
    ? "bg-emerald-500/10"
    : row.kind === "delete" ? "bg-surface-2/30" : "";

  // Active-diff tint goes on the <tr>: cell backgrounds are translucent so
  // the row's tint shows through them as an accent wash across the row.
  // Every row of the active group gets tinted so a multi-line block reads
  // as a single highlighted unit. Using /20 so the tint is visible on top
  // of the row's own red/green base bg-*-500/10.
  return (
    <tr
      className={clsx("leading-relaxed", isActiveDiff && "bg-accent/20")}
      data-diff={diffAnchor}
    >
      {/* Left line number */}
      <td className={clsx(
        "px-2 text-right text-[10px] text-text-muted font-mono select-none w-12 shrink-0 border-r border-border-subtle",
        leftBg,
      )}>
        {row.left_no ?? ""}
      </td>
      {/* Left content */}
      <td className={clsx(
        "px-2 font-mono text-[11px] text-text-secondary whitespace-pre align-top select-text cursor-text",
        leftBg,
      )}>
        {row.kind === "modify"
          ? renderInline(row.left, "del")
          : row.left || " "}
      </td>
      {/* Right line number */}
      <td className={clsx(
        "px-2 text-right text-[10px] text-text-muted font-mono select-none w-12 shrink-0 border-l border-border-subtle",
        rightBg,
      )}>
        {row.right_no ?? ""}
      </td>
      {/* Right content */}
      <td className={clsx(
        "px-2 font-mono text-[11px] text-text-secondary whitespace-pre align-top select-text cursor-text",
        rightBg,
      )}>
        {row.kind === "modify"
          ? renderInline(row.right, "ins")
          : row.right || " "}
      </td>
    </tr>
  );
}

// ── Hunk header (separator between non-contiguous diff regions) ───────────────
//
// Shows the unified-diff style `@@ -X / +Y @@` header plus, when there are
// still hidden context lines between this hunk and the previous one, a
// clickable button to fetch more of them via the backend `get_text_lines`
// command. Clicking repeatedly keeps revealing more (up to the natural
// boundary of the next hunk).

// Shared expand / collapse cluster for any gap (leading, between, trailing).
// `remaining` is the count of file lines still hidden; `expandedCount` is
// what has already been revealed via clicks (controls whether the collapse
// button appears). Caller wires onExpand/onCollapse to the right state.

function GapControls({
  remaining, expandedCount, onExpand, onCollapse,
}: {
  remaining: number;
  expandedCount: number;
  onExpand: (count: number) => void;
  onCollapse: () => void;
}) {
  const chunked = Math.min(10, remaining);
  return (
    <>
      {remaining > 0 && (
        <button
          onClick={(e) => onExpand(e.shiftKey ? remaining : chunked)}
          title={`Show ${chunked} more line${chunked === 1 ? "" : "s"} of context  •  Shift-click: show all ${remaining}`}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-blue-300 hover:text-blue-100 hover:bg-blue-500/20 transition-colors"
        >
          <ChevronsUpDown size={11} />
          <span className="tabular-nums">+{chunked}</span>
        </button>
      )}
      {remaining > chunked && (
        <button
          onClick={() => onExpand(remaining)}
          title={`Show all ${remaining} hidden lines`}
          className="inline-flex items-center px-1.5 py-0.5 rounded text-blue-300 hover:text-blue-100 hover:bg-blue-500/20 transition-colors text-[10px]"
        >
          <span className="tabular-nums">all ({remaining})</span>
        </button>
      )}
      {expandedCount > 0 && (
        <button
          onClick={onCollapse}
          title={`Collapse ${expandedCount} expanded line${expandedCount === 1 ? "" : "s"}`}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-blue-300 hover:text-blue-100 hover:bg-blue-500/20 transition-colors"
        >
          <Minus size={11} />
          <span className="tabular-nums">−{expandedCount}</span>
        </button>
      )}
    </>
  );
}

function HunkSeparator({
  hunk, remainingLines, expandedCount, onExpand, onCollapse,
}: {
  hunk: DiffHunk;
  remainingLines: number;
  expandedCount: number;
  onExpand: (count: number) => void;
  onCollapse: () => void;
}) {
  return (
    <tr>
      <td colSpan={4} className="px-3 py-1 text-[10px] text-blue-400 bg-blue-500/10 font-mono">
        <div className="flex items-center gap-2">
          <GapControls
            remaining={remainingLines}
            expandedCount={expandedCount}
            onExpand={onExpand}
            onCollapse={onCollapse}
          />
          <span>@@ −{hunk.old_start} / +{hunk.new_start} @@</span>
        </div>
      </td>
    </tr>
  );
}

// Edge separator: same controls as HunkSeparator but without the `@@`
// header. Used at the very top (before first hunk) and very bottom (after
// last hunk) of the diff — those edges have no hunk header to anchor.

function EdgeSeparator({
  remainingLines, expandedCount, onExpand, onCollapse,
}: {
  remainingLines: number;
  expandedCount: number;
  onExpand: (count: number) => void;
  onCollapse: () => void;
}) {
  if (remainingLines === 0 && expandedCount === 0) return null;
  return (
    <tr>
      <td colSpan={4} className="px-3 py-1 text-[10px] text-blue-400 bg-blue-500/10 font-mono">
        <div className="flex items-center gap-2">
          <GapControls
            remaining={remainingLines}
            expandedCount={expandedCount}
            onExpand={onExpand}
            onCollapse={onCollapse}
          />
        </div>
      </td>
    </tr>
  );
}

// Row for a context line that the user explicitly expanded. Renders like a
// regular "equal" Row but is decoupled from the DiffHunk structure — it lives
// in its own state slice (expandedBeforeHunk).

function ExpandedRow({ leftLineNo, rightLineNo, content }: {
  leftLineNo: number;
  rightLineNo: number;
  content: string;
}) {
  return (
    <tr className="leading-relaxed">
      <td className="px-2 text-right text-[10px] text-text-muted font-mono select-none w-12 shrink-0 border-r border-border-subtle">
        {leftLineNo}
      </td>
      <td className="px-2 font-mono text-[11px] text-text-secondary whitespace-pre align-top select-text cursor-text">
        {content || " "}
      </td>
      <td className="px-2 text-right text-[10px] text-text-muted font-mono select-none w-12 shrink-0 border-l border-border-subtle">
        {rightLineNo}
      </td>
      <td className="px-2 font-mono text-[11px] text-text-secondary whitespace-pre align-top select-text cursor-text">
        {content || " "}
      </td>
    </tr>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────────────

export function DiffCompareModal({
  pathA, pathB, onClose,
}: {
  pathA: string;
  pathB: string;
  onClose: () => void;
}) {
  const t = useTranslation();
  const [result, setResult] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeDiffIdx, setActiveDiffIdx] = useState(0);
  // Lines fetched on-demand via the "Expand" buttons. Three buckets so the
  // three placements stay decoupled:
  //   - leading   = lines before the very first hunk (file's true start)
  //   - between   = lines between two consecutive hunks (existing behavior)
  //   - trailing  = lines after the very last hunk (file's true end)
  // Every entry stores BOTH sides' line numbers so similar-aligned diffs
  // (where A and B drift apart) still render correctly.
  type ExpandedRowData = { leftLineNo: number; rightLineNo: number; content: string };
  const [expandedLeading, setExpandedLeading] = useState<ExpandedRowData[]>([]);
  const [expandedBetween, setExpandedBetween] = useState<Record<number, ExpandedRowData[]>>({});
  const [expandedTrailing, setExpandedTrailing] = useState<ExpandedRowData[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setResult(null);
    setActiveDiffIdx(0);
    setExpandedLeading([]);
    setExpandedBetween({});
    setExpandedTrailing([]);
    invoke<DiffResult>("diff_files", { pathA, pathB })
      .then(setResult)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [pathA, pathB]);

  // ── Gap geometry helpers ────────────────────────────────────────────────
  //
  // Three placements: leading (before first hunk), between (between two
  // hunks), trailing (after last hunk). Each helper reports `remaining` so
  // the separator knows whether to show the Expand button, plus where the
  // NEXT fetch should start on each file's numbering. Leading reveals
  // bottom-up (each click adds older lines at the TOP of the leading
  // block); between and trailing reveal top-down (each click appends).

  const leadingGapInfo = (): { remaining: number; nextStartA: number; nextStartB: number } | null => {
    if (!result || result.hunks.length === 0) return null;
    const first = result.hunks[0];
    const firstRow = first.rows[0];
    const limitA = (firstRow.left_no ?? firstRow.right_no ?? 1) - 1;
    const limitB = (firstRow.right_no ?? firstRow.left_no ?? 1) - 1;
    const expanded = expandedLeading.length;
    const remaining = Math.max(0, limitA - expanded);
    // First click reveals the lines just before the hunk — we work backward
    // by `expanded`, then back by the new batch's count when fetching.
    return {
      remaining,
      nextStartA: limitA - expanded,
      nextStartB: limitB - expanded,
    };
  };

  const betweenGapInfo = (hi: number): { remaining: number; nextStartA: number; nextStartB: number } | null => {
    if (!result || hi <= 0 || hi >= result.hunks.length) return null;
    const prev = result.hunks[hi - 1];
    const next = result.hunks[hi];
    const prevLast = prev.rows[prev.rows.length - 1];
    const nextFirst = next.rows[0];
    const baseStartA = (prevLast.left_no ?? prevLast.right_no ?? 0) + 1;
    const baseStartB = (prevLast.right_no ?? prevLast.left_no ?? 0) + 1;
    const limitEndA = (nextFirst.left_no ?? nextFirst.right_no ?? 0) - 1;
    const consumed = (expandedBetween[hi] ?? []).length;
    const remaining = Math.max(0, limitEndA - (baseStartA + consumed) + 1);
    return {
      remaining,
      nextStartA: baseStartA + consumed,
      nextStartB: baseStartB + consumed,
    };
  };

  const trailingGapInfo = (): { remaining: number; nextStartA: number; nextStartB: number } | null => {
    if (!result || result.hunks.length === 0) return null;
    const last = result.hunks[result.hunks.length - 1];
    const lastRow = last.rows[last.rows.length - 1];
    const baseStartA = (lastRow.left_no ?? lastRow.right_no ?? 0) + 1;
    const baseStartB = (lastRow.right_no ?? lastRow.left_no ?? 0) + 1;
    const consumed = expandedTrailing.length;
    const remaining = Math.max(0, result.total_lines - (baseStartA + consumed) + 1);
    return {
      remaining,
      nextStartA: baseStartA + consumed,
      nextStartB: baseStartB + consumed,
    };
  };

  // Shared fetch loop with batching against the backend's 200-line cap. The
  // caller supplies a place-anchor `apply` that knows how to merge the new
  // rows into the correct expansion bucket (prepend for leading, append for
  // between / trailing).
  const fetchLines = async (
    startA: number,
    startB: number,
    wanted: number,
    apply: (additions: ExpandedRowData[]) => void,
  ) => {
    const batchSize = 200;
    let fetchedSoFar = 0;
    while (fetchedSoFar < wanted) {
      const batch = Math.min(batchSize, wanted - fetchedSoFar);
      try {
        const lines = await invoke<string[]>("get_text_lines", {
          path: pathA, startLine: startA + fetchedSoFar, count: batch,
        });
        if (lines.length === 0) break;
        const additions = lines.map((c, idx) => ({
          leftLineNo: startA + fetchedSoFar + idx,
          rightLineNo: startB + fetchedSoFar + idx,
          content: c,
        }));
        apply(additions);
        fetchedSoFar += lines.length;
        if (lines.length < batch) break; // hit EOF early
      } catch {
        break;
      }
    }
  };

  const expandLeading = async (requestedCount: number) => {
    const info = leadingGapInfo();
    if (!info || info.remaining === 0) return;
    const wanted = Math.min(requestedCount, info.remaining);
    // Leading reveals OLDER lines (lower numbers) each click. nextStartA is
    // the LAST line we'll reveal (closest to the hunk); the fetched range
    // starts `wanted - 1` lines earlier on each side.
    const startA = info.nextStartA - wanted + 1;
    const startB = info.nextStartB - wanted + 1;
    await fetchLines(startA, startB, wanted, (additions) => {
      setExpandedLeading((prev) => [...additions, ...prev]);
    });
  };

  const expandBetween = async (hi: number, requestedCount: number) => {
    const info = betweenGapInfo(hi);
    if (!info || info.remaining === 0) return;
    const wanted = Math.min(requestedCount, info.remaining);
    await fetchLines(info.nextStartA, info.nextStartB, wanted, (additions) => {
      setExpandedBetween((prev) => ({ ...prev, [hi]: [...(prev[hi] ?? []), ...additions] }));
    });
  };

  const expandTrailing = async (requestedCount: number) => {
    const info = trailingGapInfo();
    if (!info || info.remaining === 0) return;
    const wanted = Math.min(requestedCount, info.remaining);
    await fetchLines(info.nextStartA, info.nextStartB, wanted, (additions) => {
      setExpandedTrailing((prev) => [...prev, ...additions]);
    });
  };

  const collapseLeading = () => setExpandedLeading([]);
  const collapseBetween = (hi: number) => setExpandedBetween((prev) => {
    const next = { ...prev };
    delete next[hi];
    return next;
  });
  const collapseTrailing = () => setExpandedTrailing([]);

  // Walk every (hi, ri) once and build:
  // - `rowDiffIdx`: which diff GROUP this row belongs to. Equal rows absent.
  // - `firstRowKeyOfDiff`: the first row of each diff group — the data-diff
  //   anchor goToDiff queries for the scroll target.
  // - `totalDiffs`: the navigator counter denominator.
  // - `stats`: per-kind LINE totals shown in the header (these stay per-line
  //   so the user knows the actual edit volume).
  //
  // A DIFF (group) here is a maximal run of consecutive non-equal rows. This
  // matches the convention used by VSCode/Notepad++ Compare/IntelliJ for
  // "next change" navigation: a contiguous block of edited lines counts as
  // one change, even if it spans many lines. Lines separated by ANY equal
  // context row start a new group. The user reads each visually-distinct
  // colored block as one diff.
  const { rowDiffIdx, firstRowKeyOfDiff, totalDiffs, stats } = useMemo(() => {
    const rowMap = new Map<string, number>();
    const firstOfDiff = new Map<number, string>();
    let ins = 0, del = 0, mod = 0;
    if (!result) {
      return { rowDiffIdx: rowMap, firstRowKeyOfDiff: firstOfDiff, totalDiffs: 0, stats: { ins, del, mod } };
    }
    let diffIdx = -1;
    let prevWasChange = false;
    for (let hi = 0; hi < result.hunks.length; hi++) {
      const rows = result.hunks[hi].rows;
      for (let ri = 0; ri < rows.length; ri++) {
        const kind = rows[ri].kind;
        const isChange = kind !== "equal";
        if (isChange) {
          if (!prevWasChange) {
            diffIdx++;
            firstOfDiff.set(diffIdx, `${hi}-${ri}`);
          }
          rowMap.set(`${hi}-${ri}`, diffIdx);
          if (kind === "insert") ins++;
          else if (kind === "delete") del++;
          else mod++;
        }
        prevWasChange = isChange;
      }
    }
    return {
      rowDiffIdx: rowMap,
      firstRowKeyOfDiff: firstOfDiff,
      totalDiffs: diffIdx + 1,
      stats: { ins, del, mod },
    };
  }, [result]);

  // Scroll the chosen change row into view inside the modal body. The
  // target is looked up by `data-diff` attribute (set on every change row
  // by the Row component). Manual offset math instead of scrollIntoView so
  // the scroll stays confined to bodyRef. Top padding of 8px keeps the row
  // visible just below the modal header's bottom border.
  const goToDiff = (idx: number) => {
    if (totalDiffs === 0) return;
    const clamped = ((idx % totalDiffs) + totalDiffs) % totalDiffs;
    setActiveDiffIdx(clamped);
    const body = bodyRef.current;
    if (!body) return;
    const target = body.querySelector(`tr[data-diff="${clamped}"]`) as HTMLElement | null;
    if (!target) return;
    const elTop = target.getBoundingClientRect().top;
    const bodyTop = body.getBoundingClientRect().top;
    body.scrollBy({ top: elTop - bodyTop - 8, behavior: "smooth" });
  };

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (totalDiffs === 0) return;
      if (e.key === "F3") {
        // F3 / Shift+F3 — same convention as browser find next/prev.
        e.preventDefault();
        goToDiff(activeDiffIdx + (e.shiftKey ? -1 : 1));
      } else if (e.key === "Home" && !e.ctrlKey && !e.metaKey) {
        // Home / End jump straight to the first / last diff. Skip when
        // a modifier is held so the user can still use Ctrl+Home etc. in
        // their OS / shell if the modal somehow loses focus to another
        // surface — keeps the shortcut purely additive.
        e.preventDefault();
        goToDiff(0);
      } else if (e.key === "End" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        goToDiff(totalDiffs - 1);
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  // goToDiff closes over activeDiffIdx and totalDiffs via this dep list so
  // F3 always jumps from the current position.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, activeDiffIdx, totalDiffs]);

  const nameA = pathA.split(/[\\/]/).pop() ?? pathA;
  const nameB = pathB.split(/[\\/]/).pop() ?? pathB;
  const hasNav = !loading && !error && result && !result.identical && totalDiffs > 0;

  return (
    <div className="modal-backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        ref={ref}
        className="modal-content-in bg-surface-1 border border-border rounded-xl shadow-2xl w-[1400px] max-w-[96vw] max-h-[92vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border-subtle shrink-0">
          <FileText size={14} className="text-accent shrink-0" />
          <div className="flex-1 min-w-0 grid grid-cols-2 gap-3">
            <span className="text-red-400 truncate text-[12px]" title={pathA}>− {nameA}</span>
            <span className="text-emerald-400 truncate text-[12px]" title={pathB}>+ {nameB}</span>
          </div>
          {hasNav && (
            <div className="flex items-center gap-1.5 shrink-0">
              {/* Per-kind line counters: green +, red −, amber ~ for modified.
                  Hidden when 0 to keep the header uncluttered for simple diffs. */}
              {stats.ins > 0 && (
                <span className="text-[11px] text-emerald-400 tabular-nums">+{stats.ins}</span>
              )}
              {stats.del > 0 && (
                <span className="text-[11px] text-red-400 tabular-nums">−{stats.del}</span>
              )}
              {stats.mod > 0 && (
                <span className="text-[11px] text-amber-400 tabular-nums">~{stats.mod}</span>
              )}
              <div className="w-px h-4 bg-border mx-1" />
              <span className="text-[11px] text-text-muted tabular-nums select-none">
                {activeDiffIdx + 1}/{totalDiffs}
              </span>
              <button
                onClick={() => goToDiff(0)}
                title={t.diffFirstHunk}
                className="w-6 h-6 flex items-center justify-center rounded hover:bg-surface-3 text-text-muted hover:text-text-primary"
              >
                <ChevronsUp size={13} />
              </button>
              <button
                onClick={() => goToDiff(activeDiffIdx - 1)}
                title={t.diffPrevHunk}
                className="w-6 h-6 flex items-center justify-center rounded hover:bg-surface-3 text-text-muted hover:text-text-primary"
              >
                <ChevronUp size={13} />
              </button>
              <button
                onClick={() => goToDiff(activeDiffIdx + 1)}
                title={t.diffNextHunk}
                className="w-6 h-6 flex items-center justify-center rounded hover:bg-surface-3 text-text-muted hover:text-text-primary"
              >
                <ChevronDown size={13} />
              </button>
              <button
                onClick={() => goToDiff(totalDiffs - 1)}
                title={t.diffLastHunk}
                className="w-6 h-6 flex items-center justify-center rounded hover:bg-surface-3 text-text-muted hover:text-text-primary"
              >
                <ChevronsDown size={13} />
              </button>
              <div className="w-px h-4 bg-border mx-1" />
            </div>
          )}
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-surface-3 text-text-muted hover:text-text-primary"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body — `min-h-0` is critical here. Without it, flex items default
            to `min-height: auto` which means the body grows to fit its
            content instead of respecting the parent modal's max-h-[92vh].
            That makes overflow-auto useless: the body never overflows
            because it just keeps growing, so scrolling never engages.
            With min-h-0 the body is allowed to shrink below content size,
            so its own overflow-auto kicks in as expected. */}
        <div ref={bodyRef} className="flex-1 min-h-0 overflow-auto">
          {loading && (
            <p className="px-5 py-4 text-[12px] text-text-muted">{t.diffComparing}</p>
          )}
          {error && (
            <p className="px-5 py-4 text-[12px] text-red-400 whitespace-pre-wrap">{error}</p>
          )}
          {!loading && !error && result?.identical && (
            <p className="px-5 py-8 text-[12px] text-text-muted text-center italic">
              {t.diffIdentical}
            </p>
          )}
          {!loading && !error && result && !result.identical && (
            // Two columns of equal width; the line-number columns are fixed
            // small to leave most space for content. table-layout: fixed makes
            // each column claim its share regardless of content width — text
            // overflows via whitespace-pre + horizontal scroll on the container.
            // Each hunk gets its own <tbody>: HTML allows multiple tbodies per
            // table and React's reconciler can diff them independently when a
            // file change reshuffles the diff. Diff navigation works at the
            // row level via the data-diff attribute Row sets on every change
            // row — independent of how rows are grouped into tbodies; the
            // grouping is purely for HunkSeparator placement between hunks.
            <table className="w-full" style={{ tableLayout: "fixed" }}>
              <colgroup>
                <col style={{ width: "3rem" }} />
                <col style={{ width: "calc(50% - 3rem)" }} />
                <col style={{ width: "3rem" }} />
                <col style={{ width: "calc(50% - 3rem)" }} />
              </colgroup>
              {/* Leading edge: lines before the very first hunk. The
                  separator appears at the top; expanded rows then follow.
                  Leading expansion fills bottom-up (rows closest to the
                  hunk are revealed first), so prev state is rendered in
                  ascending line order as-is. */}
              {(() => {
                const lead = leadingGapInfo();
                if (!lead || (lead.remaining === 0 && expandedLeading.length === 0)) return null;
                return (
                  <tbody>
                    <EdgeSeparator
                      remainingLines={lead.remaining}
                      expandedCount={expandedLeading.length}
                      onExpand={expandLeading}
                      onCollapse={collapseLeading}
                    />
                    {expandedLeading.map((er, idx) => (
                      <ExpandedRow
                        key={`lead-${idx}`}
                        leftLineNo={er.leftLineNo}
                        rightLineNo={er.rightLineNo}
                        content={er.content}
                      />
                    ))}
                  </tbody>
                );
              })()}
              {result.hunks.map((hunk, hi) => {
                const gap = betweenGapInfo(hi);
                const expanded = expandedBetween[hi] ?? [];
                return (
                  <tbody key={hi}>
                    {/* For all but the first hunk: expanded context lines
                        come BEFORE the @@ separator (they fill in from the
                        previous hunk's tail), and the separator carries the
                        +N expand button when there's still room to grow. */}
                    {hi > 0 && expanded.map((er, idx) => (
                      <ExpandedRow
                        key={`exp-${idx}`}
                        leftLineNo={er.leftLineNo}
                        rightLineNo={er.rightLineNo}
                        content={er.content}
                      />
                    ))}
                    {hi > 0 && (
                      <HunkSeparator
                        hunk={hunk}
                        remainingLines={gap?.remaining ?? 0}
                        expandedCount={expanded.length}
                        onExpand={(count) => expandBetween(hi, count)}
                        onCollapse={() => collapseBetween(hi)}
                      />
                    )}
                    {hunk.rows.map((row, ri) => {
                      const key = `${hi}-${ri}`;
                      const diffIdx = rowDiffIdx.get(key);
                      // diffAnchor → data-diff attribute. ONLY set on the first
                      // row of each diff group; that's what goToDiff queries to
                      // scroll. Other rows in the same group don't need it.
                      const diffAnchor = diffIdx !== undefined
                        && firstRowKeyOfDiff.get(diffIdx) === key
                        ? diffIdx
                        : undefined;
                      return (
                        <Row
                          key={ri}
                          row={row}
                          isActiveDiff={diffIdx === activeDiffIdx}
                          diffAnchor={diffAnchor}
                        />
                      );
                    })}
                  </tbody>
                );
              })}
              {/* Trailing edge: lines after the very last hunk. Mirror of
                  leading — separator at the top of the trailing block,
                  expanded rows follow it filling top-down toward EOF. */}
              {(() => {
                const tail = trailingGapInfo();
                if (!tail || (tail.remaining === 0 && expandedTrailing.length === 0)) return null;
                return (
                  <tbody>
                    <EdgeSeparator
                      remainingLines={tail.remaining}
                      expandedCount={expandedTrailing.length}
                      onExpand={expandTrailing}
                      onCollapse={collapseTrailing}
                    />
                    {expandedTrailing.map((er, idx) => (
                      <ExpandedRow
                        key={`tail-${idx}`}
                        leftLineNo={er.leftLineNo}
                        rightLineNo={er.rightLineNo}
                        content={er.content}
                      />
                    ))}
                  </tbody>
                );
              })()}
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
