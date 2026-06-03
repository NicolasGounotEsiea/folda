import { invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import { FileText, X } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
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
}

// ── Safe intra-line marker renderer ──────────────────────────────────────────
//
// Identical pattern to GitPanel's renderInlineMarkers — kept LOCAL here to
// keep the two compare paths decoupled. If we ever extract a shared util,
// both sides will switch in one change.

function renderInline(line: string, side: "del" | "ins"): React.ReactNode {
  if (!line) return " "; // NBSP keeps the row from collapsing to 0 height
  const re = side === "del" ? /(<del>[\s\S]*?<\/del>)/g : /(<ins>[\s\S]*?<\/ins>)/g;
  const tagOpen = side === "del" ? "<del>" : "<ins>";
  const tagClose = side === "del" ? "</del>" : "</ins>";
  const cls = side === "del"
    ? "bg-red-500/50 text-red-50 rounded-sm"
    : "bg-emerald-500/50 text-emerald-50 rounded-sm";
  const parts = line.split(re);
  return parts.map((p, i) => {
    if (p.startsWith(tagOpen) && p.endsWith(tagClose)) {
      const inner = p.slice(tagOpen.length, p.length - tagClose.length);
      return <span key={i} className={cls}>{inner}</span>;
    }
    return <React.Fragment key={i}>{p}</React.Fragment>;
  });
}

// ── Single row (one line on each side) ───────────────────────────────────────
//
// Four kinds:
//   equal   — same content on both sides, neutral background
//   delete  — only left has content, red background spanning the row
//   insert  — only right has content, green background spanning the row
//   modify  — both have content, with intra-line <del>/<ins> highlights

function Row({ row }: { row: DiffRow }) {
  const leftBg = row.kind === "delete" || row.kind === "modify"
    ? "bg-red-500/10"
    : row.kind === "insert" ? "bg-surface-2/30" : "";
  const rightBg = row.kind === "insert" || row.kind === "modify"
    ? "bg-emerald-500/10"
    : row.kind === "delete" ? "bg-surface-2/30" : "";

  return (
    <tr className="leading-relaxed">
      {/* Left line number */}
      <td className={clsx(
        "px-2 text-right text-[10px] text-text-muted font-mono select-none w-12 shrink-0 border-r border-border-subtle",
        leftBg,
      )}>
        {row.left_no ?? ""}
      </td>
      {/* Left content */}
      <td className={clsx(
        "px-2 font-mono text-[11px] text-text-secondary whitespace-pre align-top",
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
        "px-2 font-mono text-[11px] text-text-secondary whitespace-pre align-top",
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

function HunkSeparator({ hunk }: { hunk: DiffHunk }) {
  return (
    <tr>
      <td colSpan={4} className="px-3 py-1 text-[10px] text-blue-400 bg-blue-500/10 font-mono">
        @@ −{hunk.old_start} / +{hunk.new_start} @@
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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setResult(null);
    invoke<DiffResult>("diff_files", { pathA, pathB })
      .then(setResult)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [pathA, pathB]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const nameA = pathA.split(/[\\/]/).pop() ?? pathA;
  const nameB = pathB.split(/[\\/]/).pop() ?? pathB;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        ref={ref}
        className="bg-surface-1 border border-border rounded-xl shadow-2xl w-[1400px] max-w-[96vw] max-h-[92vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border-subtle shrink-0">
          <FileText size={14} className="text-accent shrink-0" />
          <div className="flex-1 min-w-0 grid grid-cols-2 gap-3">
            <span className="text-red-400 truncate text-[12px]" title={pathA}>− {nameA}</span>
            <span className="text-emerald-400 truncate text-[12px]" title={pathB}>+ {nameB}</span>
          </div>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-surface-3 text-text-muted hover:text-text-primary"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
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
            <table className="w-full" style={{ tableLayout: "fixed" }}>
              <colgroup>
                <col style={{ width: "3rem" }} />
                <col style={{ width: "calc(50% - 3rem)" }} />
                <col style={{ width: "3rem" }} />
                <col style={{ width: "calc(50% - 3rem)" }} />
              </colgroup>
              <tbody>
                {result.hunks.map((hunk, hi) => (
                  <React.Fragment key={hi}>
                    {hi > 0 && <HunkSeparator hunk={hunk} />}
                    {hunk.rows.map((row, ri) => (
                      <Row key={ri} row={row} />
                    ))}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
