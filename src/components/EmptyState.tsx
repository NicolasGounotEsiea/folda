import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { clsx } from "clsx";

/**
 * Reusable centered empty-state block. Three pieces of hierarchy:
 *
 *   1. A large soft-colored icon (or a custom illustration node) — gives
 *      visual identity per case without needing real artwork.
 *   2. A short title — what the user is currently looking at.
 *   3. A longer hint — what they can do about it. Keep it actionable.
 *
 * The optional `action` slot renders a small ghost button under the hint
 * for one-click recovery (Empty trash, Clear filters, Add folder, …).
 *
 * Styling stays tone-neutral and respects the app's theme tokens so it
 * works in dark, light, and any future accent.
 */
export function EmptyState({
  icon: Icon,
  customIcon,
  title,
  hint,
  action,
  className,
  compact = false,
}: {
  /** Lucide icon component. Mutually exclusive with `customIcon`. */
  icon?: LucideIcon;
  /** Custom JSX in place of a Lucide icon (e.g. an inline SVG illustration). */
  customIcon?: ReactNode;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
  /** When true, reduces spacing for use inside narrower panels. */
  compact?: boolean;
}) {
  return (
    <div
      className={clsx(
        "flex flex-col items-center justify-center text-center select-none",
        compact ? "gap-2 py-6" : "gap-3 py-10",
        className,
      )}
    >
      {/* Icon container with a soft accent halo. Uses bg-accent/5 so it picks
          up the current accent color subtly — including silver, which lights
          up nicely against this low-opacity background. */}
      <div
        className={clsx(
          "rounded-full flex items-center justify-center bg-accent/5 text-text-muted",
          compact ? "w-12 h-12" : "w-16 h-16",
        )}
      >
        {Icon ? <Icon size={compact ? 22 : 30} strokeWidth={1.5} /> : customIcon}
      </div>

      <div className="flex flex-col gap-1 max-w-[320px]">
        <h3 className={clsx("font-medium text-text-primary leading-snug", compact ? "text-[12px]" : "text-[13px]")}>
          {title}
        </h3>
        {hint && (
          <p className={clsx("text-text-muted leading-relaxed", compact ? "text-[11px]" : "text-[12px]")}>
            {hint}
          </p>
        )}
      </div>

      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
