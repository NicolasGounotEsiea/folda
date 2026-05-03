import { clsx } from "clsx";
import { useEffect, useRef } from "react";

export interface ContextMenuAction {
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}
export type ContextMenuEntry = ContextMenuAction | { separator: true };

interface Props {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Adjust position so menu stays inside viewport
  const style: React.CSSProperties = { position: "fixed", zIndex: 9999 };
  const menuW = 220;
  const menuH = items.length * 28;
  style.left = x + menuW > window.innerWidth ? x - menuW : x;
  style.top = y + menuH > window.innerHeight ? y - menuH : y;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // Use capture so we intercept before bubbling stops
    window.addEventListener("mousedown", handler, true);
    window.addEventListener("keydown", keyHandler, true);
    return () => {
      window.removeEventListener("mousedown", handler, true);
      window.removeEventListener("keydown", keyHandler, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={style}
      className="bg-surface-2 border border-border rounded-lg shadow-2xl py-1 min-w-[200px] select-none"
    >
      {items.map((item, i) => {
        if ("separator" in item) {
          return <div key={i} className="h-px bg-border-subtle mx-2 my-1" />;
        }
        return (
          <button
            key={i}
            disabled={item.disabled}
            onClick={() => { onClose(); item.onClick(); }}
            className={clsx(
              "w-full flex items-center justify-between gap-4 px-3 h-7 text-left text-[12px] transition-colors",
              item.disabled
                ? "text-text-muted cursor-not-allowed opacity-40"
                : item.danger
                  ? "text-red-400 hover:bg-red-500/10"
                  : "text-text-secondary hover:bg-surface-3 hover:text-text-primary"
            )}
          >
            <span>{item.label}</span>
            {item.shortcut && (
              <span className="text-[10px] text-text-muted">{item.shortcut}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
