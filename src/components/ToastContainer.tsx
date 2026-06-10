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

/// Per-type visual identity. All four properties are literal Tailwind classes
/// so the JIT scanner picks them up — don't compose dynamically. Each toast
/// gets a colored 3px left strip (the dominant "this is a {type}" cue), a
/// matching icon, and a glow shadow keyed off the same hue for a polished
/// feel without flooding the message area with color.
const VARIANTS: Record<Toast["type"], {
  Icon: typeof CheckCircle;
  iconClass: string;
  stripBg: string;       // colored bar on the left edge
  glow: string;          // box-shadow tint
}> = {
  success: {
    Icon: CheckCircle,
    iconClass: "text-green-400",
    stripBg: "bg-green-500",
    glow: "shadow-[0_4px_18px_-4px_rgba(34,197,94,0.35)]",
  },
  error: {
    Icon: AlertCircle,
    iconClass: "text-red-400",
    stripBg: "bg-red-500",
    glow: "shadow-[0_4px_18px_-4px_rgba(239,68,68,0.4)]",
  },
  warning: {
    Icon: AlertTriangle,
    iconClass: "text-amber-400",
    stripBg: "bg-amber-500",
    glow: "shadow-[0_4px_18px_-4px_rgba(245,158,11,0.35)]",
  },
  info: {
    Icon: Info,
    iconClass: "text-blue-400",
    stripBg: "bg-blue-500",
    glow: "shadow-[0_4px_18px_-4px_rgba(59,130,246,0.35)]",
  },
};

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismissToast);
  const variant = VARIANTS[toast.type];

  useEffect(() => {
    const ms = DURATIONS[toast.type];
    if (!ms) return;
    const t = setTimeout(() => dismiss(toast.id), ms);
    return () => clearTimeout(t);
  }, [toast.id, toast.type, dismiss]);

  return (
    <div
      className={clsx(
        // The entrance animation. One-shot, GPU-only (transform + opacity).
        "toast-in",
        // The card itself. The left strip is rendered as a sibling so the
        // border doesn't constrain layout — keeps the content area cleanly
        // padded regardless of strip width.
        "relative flex items-start gap-2.5 pl-4 pr-3 py-2.5 bg-surface-2 border border-border-subtle rounded-lg w-72 text-[12px]",
        variant.glow,
      )}
    >
      {/* Colored accent strip on the left edge — the dominant identity cue. */}
      <div
        className={clsx(
          "absolute left-0 top-0 bottom-0 w-[3px] rounded-l-lg",
          variant.stripBg,
        )}
      />

      <div className="mt-0.5">
        <variant.Icon size={14} className={clsx("shrink-0", variant.iconClass)} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-text-primary leading-snug">{toast.message}</p>
        {toast.detail && (
          // line-clamp-3 (was: truncate) lets longer explanations like the
          // automation rate-limit detail wrap to 3 lines instead of being cut.
          // Existing short-detail toasts still fit in 1-2 lines, no regression.
          <p className="text-text-muted mt-0.5 leading-snug line-clamp-3">{toast.detail}</p>
        )}
        {toast.action && (
          <button
            onClick={() => {
              toast.action!.onClick();
              dismiss(toast.id);
            }}
            className="mt-1.5 px-2 h-6 rounded bg-surface-3 hover:bg-surface-1 text-text-primary text-[11px] font-medium border border-border transition-colors"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        onClick={() => dismiss(toast.id)}
        className="shrink-0 mt-0.5 text-text-muted hover:text-text-primary transition-colors"
        aria-label="Dismiss"
      >
        <X size={12} />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  if (!toasts.length) return null;

  // Bottom-right is the industry standard for transient notifications and
  // doesn't collide with the sidebar (left) or main file list (center).
  // pointer-events-none on the wrapper lets clicks pass through to whatever
  // is behind; toast cards individually opt back into pointer events.
  return (
    <div className="fixed bottom-4 right-4 z-[400] flex flex-col-reverse gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem toast={t} />
        </div>
      ))}
    </div>
  );
}
