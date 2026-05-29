import { clsx } from "clsx";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  /// Currently selected time in `HH:MM` form, or empty string for none.
  value: string;
  onChange: (next: string) => void;
  onClose: () => void;
  anchor: DOMRect;
}

// Quick presets covering common work-day moments. The user can also dial any time
// via the hour / minute steppers below.
const PRESETS: { label: string; time: string }[] = [
  { label: "Morning",   time: "09:00" },
  { label: "Noon",      time: "12:00" },
  { label: "Afternoon", time: "14:00" },
  { label: "End of day",time: "17:00" },
  { label: "Evening",   time: "19:00" },
];

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/// Custom time popover styled to match the app's dark theme.
/// Two number steppers + a row of common presets. Minutes step by 5 by default.
export function TimePicker({ value, onChange, onClose, anchor }: Props) {
  const initHour = value ? clamp(parseInt(value.slice(0, 2), 10) || 0, 0, 23) : 9;
  const initMin = value ? clamp(parseInt(value.slice(3, 5), 10) || 0, 0, 59) : 0;
  const [hour, setHour] = useState(initHour);
  const [minute, setMinute] = useState(initMin);
  const ref = useRef<HTMLDivElement>(null);

  // Live-commit pattern: each stepper edit fires `onChange` so the user sees
  // the chip update in real time. The "Clear" button still sends "" to remove the time.
  const commit = (h: number, m: number) => {
    onChange(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  };

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

  const POPOVER_W = 220;
  const POPOVER_H = 240;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - POPOVER_W - 8));
  const top  = anchor.bottom + 4 + POPOVER_H > window.innerHeight
    ? Math.max(8, anchor.top - POPOVER_H - 4)
    : anchor.bottom + 4;

  const adjustHour = (delta: number) => {
    const next = (hour + delta + 24) % 24;
    setHour(next); commit(next, minute);
  };
  const adjustMinute = (delta: number) => {
    // Step minutes by 5 via buttons. Direct typing in the input allows finer values.
    let next = minute + delta;
    while (next < 0) next += 60;
    next = next % 60;
    setMinute(next); commit(hour, next);
  };

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", top, left, width: POPOVER_W, zIndex: 1000 }}
      className="bg-surface-2 border border-border rounded-lg shadow-2xl p-3 flex flex-col gap-2 select-none"
    >
      {/* Steppers */}
      <div className="flex items-center justify-center gap-2 py-1">
        <Stepper
          value={hour}
          onInc={() => adjustHour(1)}
          onDec={() => adjustHour(-1)}
          onSet={(v) => { const c = clamp(v, 0, 23); setHour(c); commit(c, minute); }}
          max={23}
        />
        <span className="text-[18px] font-bold text-text-muted">:</span>
        <Stepper
          value={minute}
          onInc={() => adjustMinute(5)}
          onDec={() => adjustMinute(-5)}
          onSet={(v) => { const c = clamp(v, 0, 59); setMinute(c); commit(hour, c); }}
          max={59}
        />
      </div>

      {/* Presets */}
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.time}
            onClick={() => {
              const [h, m] = p.time.split(":").map(Number);
              setHour(h); setMinute(m); commit(h, m);
            }}
            className={clsx(
              "flex-1 min-w-[42%] h-6 rounded text-[10px] transition-colors px-2",
              value === p.time
                ? "bg-accent/20 text-accent border border-accent/40"
                : "bg-surface-3 hover:bg-surface-4 text-text-secondary border border-transparent"
            )}
          >
            {p.label}
            <span className="ml-1 text-[9px] opacity-70 font-mono">{p.time}</span>
          </button>
        ))}
      </div>

      {/* Quick actions */}
      <div className="flex gap-1 pt-1 mt-1 border-t border-border-subtle">
        <button
          onClick={() => {
            const t = nowHHMM();
            const [h, m] = t.split(":").map(Number);
            setHour(h); setMinute(m); commit(h, m);
          }}
          className="flex-1 h-6 rounded bg-surface-3 hover:bg-surface-4 text-[10px] text-text-secondary transition-colors"
        >
          Now
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

function Stepper({
  value, onInc, onDec, onSet, max,
}: {
  value: number;
  onInc: () => void;
  onDec: () => void;
  onSet: (v: number) => void;
  max: number;
}) {
  return (
    <div className="flex flex-col items-center">
      <button
        onClick={onInc}
        className="w-8 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors text-[12px]"
      >
        ▲
      </button>
      <input
        type="text"
        inputMode="numeric"
        value={String(value).padStart(2, "0")}
        onChange={(e) => {
          const n = parseInt(e.target.value.replace(/\D/g, ""), 10);
          if (!isNaN(n)) onSet(n);
        }}
        className="w-12 h-9 text-center text-[20px] font-mono font-bold bg-surface-3 border border-border rounded text-text-primary outline-none focus:border-accent transition-colors"
        maxLength={2}
        aria-label={`${max === 23 ? "hour" : "minute"} value`}
      />
      <button
        onClick={onDec}
        className="w-8 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors text-[12px]"
      >
        ▼
      </button>
    </div>
  );
}
