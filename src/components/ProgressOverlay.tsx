import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

interface OpProgress {
  op: "copy" | "move" | "delete";
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

function ProgressCard({ op }: { op: OpProgress }) {
  const pct = op.total > 0 ? Math.round((op.done / op.total) * 100) : 0;
  const label = op.finished ? "Done" : OP_LABEL[op.op];
  return (
    <div className="bg-surface-2 border border-border rounded-xl shadow-2xl p-3 w-64 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-text-primary font-medium truncate flex-1">
          {label}… {op.name}
        </span>
        <span className="text-[10px] text-text-muted shrink-0">{pct}%</span>
      </div>
      <div className="h-1.5 bg-surface-4 rounded-full overflow-hidden">
        <div
          className="h-full bg-accent rounded-full transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function ProgressOverlay() {
  const [ops, setOps] = useState<Record<string, OpProgress>>({});

  const handleEvent = (opType: OpProgress["op"]) => (payload: Omit<OpProgress, "op">) => {
    const key = `${opType}:${payload.name}`;
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

  const visible = Object.values(ops);
  if (!visible.length) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[300] flex flex-col gap-2">
      {visible.map((op) => (
        <ProgressCard key={`${op.op}:${op.name}`} op={op} />
      ))}
    </div>
  );
}
