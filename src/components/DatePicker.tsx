import { clsx } from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  /// Currently selected date in `YYYY-MM-DD` form, or empty string for none.
  value: string;
  /// Called when the user picks a date (`YYYY-MM-DD`) or clears it (empty string).
  onChange: (next: string) => void;
  /// Called when the popover should close without a change (outside click / Escape).
  onClose: () => void;
  /// Bounding rect of the trigger button — used to anchor the popover.
  anchor: DOMRect;
}

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isoFromDate(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/// Custom calendar popover styled to match the app's dark theme.
/// Mounted via portal so it can escape parent overflow constraints.
export function DatePicker({ value, onChange, onClose, anchor }: Props) {
  const today = todayIso();
  // Internal "viewed month" — starts on the selected date's month, or today.
  const initial = value || today;
  const [y0, m0] = initial.split("-").map(Number);
  const [viewY, setViewY] = useState(y0);
  const [viewM, setViewM] = useState(m0 - 1); // JS months are 0-indexed
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click + Escape
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Build the 6×7 grid of day cells for the current month view.
  const firstOfMonth = new Date(viewY, viewM, 1);
  // ISO weeks start Monday — getDay() returns 0=Sun, so shift it.
  const startOffset = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
  const prevMonthDays = new Date(viewY, viewM, 0).getDate();

  type Cell = { y: number; m: number; d: number; inMonth: boolean };
  const cells: Cell[] = [];
  // Leading cells from previous month
  for (let i = startOffset - 1; i >= 0; i--) {
    const d = prevMonthDays - i;
    const py = viewM === 0 ? viewY - 1 : viewY;
    const pm = viewM === 0 ? 11 : viewM - 1;
    cells.push({ y: py, m: pm, d, inMonth: false });
  }
  // This month
  for (let d = 1; d <= daysInMonth; d++) cells.push({ y: viewY, m: viewM, d, inMonth: true });
  // Trailing cells to fill 42 = 6 rows × 7 cols
  while (cells.length < 42) {
    const last = cells[cells.length - 1];
    let nd = last.d + 1;
    let nm = last.m;
    let ny = last.y;
    if (last.inMonth || last.m !== viewM) {
      // If we crossed into next month already, just keep incrementing
      const dim = new Date(ny, nm + 1, 0).getDate();
      if (nd > dim) { nd = 1; nm += 1; if (nm > 11) { nm = 0; ny += 1; } }
    } else {
      // Just left current month
      nd = 1;
      nm = viewM + 1;
      if (nm > 11) { nm = 0; ny += 1; }
    }
    cells.push({ y: ny, m: nm, d: nd, inMonth: false });
  }

  // Position popover under the anchor, clamped to the viewport
  const POPOVER_W = 252;
  const POPOVER_H = 280;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - POPOVER_W - 8));
  const top  = anchor.bottom + 4 + POPOVER_H > window.innerHeight
    ? Math.max(8, anchor.top - POPOVER_H - 4)
    : anchor.bottom + 4;

  const prevMonth = () => {
    if (viewM === 0) { setViewY(viewY - 1); setViewM(11); } else setViewM(viewM - 1);
  };
  const nextMonth = () => {
    if (viewM === 11) { setViewY(viewY + 1); setViewM(0); } else setViewM(viewM + 1);
  };

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", top, left, width: POPOVER_W, zIndex: 1000 }}
      className="bg-surface-2 border border-border rounded-lg shadow-2xl p-2 flex flex-col gap-1.5 select-none"
    >
      {/* Month / year header */}
      <div className="flex items-center justify-between px-1">
        <button
          onClick={prevMonth}
          className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
        >
          <ChevronLeft size={13} />
        </button>
        <span className="text-[12px] font-semibold text-text-primary">
          {MONTHS[viewM]} {viewY}
        </span>
        <button
          onClick={nextMonth}
          className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
        >
          <ChevronRight size={13} />
        </button>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 gap-0.5">
        {WEEKDAYS.map((w) => (
          <div key={w} className="text-[9px] text-text-muted text-center font-medium uppercase tracking-wider py-0.5">
            {w}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((c, i) => {
          const iso = isoFromDate(c.y, c.m, c.d);
          const isSelected = iso === value;
          const isToday = iso === today;
          return (
            <button
              key={i}
              onClick={() => onChange(iso)}
              className={clsx(
                "h-7 rounded text-[11px] transition-colors",
                isSelected
                  ? "bg-accent text-white font-semibold"
                  : isToday
                    ? "text-accent bg-accent/10 hover:bg-accent/20 font-semibold"
                    : c.inMonth
                      ? "text-text-primary hover:bg-surface-3"
                      : "text-text-muted/50 hover:bg-surface-3"
              )}
            >
              {c.d}
            </button>
          );
        })}
      </div>

      {/* Quick actions */}
      <div className="flex gap-1 pt-1 mt-1 border-t border-border-subtle">
        <button
          onClick={() => onChange(today)}
          className="flex-1 h-6 rounded bg-surface-3 hover:bg-surface-4 text-[10px] text-text-secondary transition-colors"
        >
          Today
        </button>
        {value && (
          <button
            onClick={() => onChange("")}
            className="flex-1 h-6 rounded bg-surface-3 hover:bg-red-500/20 text-[10px] text-text-secondary hover:text-red-400 transition-colors"
          >
            Clear
          </button>
        )}
      </div>
    </div>,
    document.body
  );
}
