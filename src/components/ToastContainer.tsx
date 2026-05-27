import { useEffect } from "react";
import { clsx } from "clsx";
import { X, CheckCircle, AlertCircle, AlertTriangle, Info } from "lucide-react";
import { useToastStore, type Toast } from "../store/useToastStore";

const DURATIONS: Record<Toast["type"], number> = {
  success: 4000,
  info: 5000,
  warning: 7000,
  error: 0, // persistent — requires manual dismiss
};

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismissToast);

  useEffect(() => {
    const ms = DURATIONS[toast.type];
    if (!ms) return;
    const t = setTimeout(() => dismiss(toast.id), ms);
    return () => clearTimeout(t);
  }, [toast.id, toast.type, dismiss]);

  const icons = {
    success: <CheckCircle size={14} className="shrink-0 text-green-400" />,
    error: <AlertCircle size={14} className="shrink-0 text-red-400" />,
    warning: <AlertTriangle size={14} className="shrink-0 text-amber-400" />,
    info: <Info size={14} className="shrink-0 text-blue-400" />,
  };

  const borders = {
    success: "border-green-500/30",
    error: "border-red-500/30",
    warning: "border-amber-500/30",
    info: "border-blue-500/30",
  };

  return (
    <div
      className={clsx(
        "flex items-start gap-2.5 px-3 py-2.5 bg-surface-2 border rounded-lg shadow-xl w-72 text-[12px]",
        borders[toast.type],
      )}
    >
      <div className="mt-0.5">{icons[toast.type]}</div>
      <div className="flex-1 min-w-0">
        <p className="text-text-primary leading-snug">{toast.message}</p>
        {toast.detail && (
          <p className="text-text-muted mt-0.5 leading-snug truncate">{toast.detail}</p>
        )}
      </div>
      <button
        onClick={() => dismiss(toast.id)}
        className="shrink-0 mt-0.5 text-text-muted hover:text-text-primary transition-colors"
      >
        <X size={12} />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  if (!toasts.length) return null;

  return (
    <div className="fixed bottom-4 left-4 z-[400] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem toast={t} />
        </div>
      ))}
    </div>
  );
}
