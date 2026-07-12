import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import { useEffect, useState } from "react";

interface OpProgress {
  op: "copy" | "move" | "delete";
  /// Transfer id assigned by the frontend caller (FileList paste/drop). When
  /// present, the card shows a cancel button wired to `cancel_transfer`.
  /// Absent for delete events and AI-initiated copies (no cancel there).
  id?: number | null;
  name: string;
  done: number;
  total: number;
  finished: boolean;
}

const OP_LABEL: Record<OpProgress["op"], string> = {
  copy: "Copying",
  move: "Moving",
  delete: "Deleting",
};

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function ProgressCard({ op, onCancel }: { op: OpProgress; onCancel?: () => void }) {
  // Clamped: `done` can legitimately overshoot `total` when a file grows
  // during the copy, or when a directory contains symlinked content that the
  // pre-scan (which doesn't follow links) didn't count.
  const pct = op.total > 0 ? Math.min(100, Math.round((op.done / op.total) * 100)) : 0;
  const label = op.finished ? "Done" : OP_LABEL[op.op];
  // Byte counts only make sense for the byte-based copy/move events; the
  // delete event counts entries, where "X / Y" reads better raw.
  const isBytes = op.op !== "delete";
  return (
    <div className="bg-surface-2 border border-border rounded-xl shadow-2xl p-3 w-72 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-text-primary font-medium truncate flex-1">
          {label}… {op.name}
        </span>
        <span className="text-[10px] text-text-muted shrink-0 tabular-nums">{pct}%</span>
        {!op.finished && op.id != null && onCancel && (
          <button
            onClick={onCancel}
            title="Cancel"
            className="w-4 h-4 flex items-center justify-center shrink-0 rounded text-text-muted hover:text-red-400 hover:bg-surface-3 transition-colors"
          >
            <X size={10} />
          </button>
        )}
      </div>
      <div className="h-1.5 bg-surface-4 rounded-full overflow-hidden">
        <div
          className="h-full bg-accent rounded-full transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      {isBytes && op.total > 0 && !op.finished && (
        <span className="text-[10px] text-text-muted tabular-nums">
          {fmtBytes(op.done)} / {fmtBytes(op.total)}
        </span>
      )}
    </div>
  );
}

export function ProgressOverlay() {
  const [ops, setOps] = useState<Record<string, OpProgress>>({});

  const handleEvent = (opType: OpProgress["op"]) => (payload: Omit<OpProgress, "op">) => {
    // Key by transfer id when available — two same-named files copied in a
    // row would otherwise share (and fight over) one card. Name is the
    // fallback for id-less events (delete, AI copies).
    const key = payload.id != null ? `${opType}:#${payload.id}` : `${opType}:${payload.name}`;
    setOps((prev) => ({ ...prev, [key]: { op: opType, ...payload } }));
    if (payload.finished) {
      setTimeout(() => setOps((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      }), 1500);
    }
  };

  useEffect(() => {
    const unlisteners = [
      listen<Omit<OpProgress, "op">>("copy-progress", (e) => handleEvent("copy")(e.payload)),
      listen<Omit<OpProgress, "op">>("move-progress", (e) => handleEvent("move")(e.payload)),
      listen<Omit<OpProgress, "op">>("delete-progress", (e) => handleEvent("delete")(e.payload)),
    ];
    return () => { unlisteners.forEach((p) => p.then((f) => f())); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancelOp = (op: OpProgress) => {
    if (op.id != null) {
      invoke("cancel_transfer", { id: op.id }).catch(() => {});
    }
  };

  const visible = Object.entries(ops);
  if (!visible.length) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[300] flex flex-col gap-2">
      {visible.map(([key, op]) => (
        <ProgressCard key={key} op={op} onCancel={() => cancelOp(op)} />
      ))}
    </div>
  );
}
