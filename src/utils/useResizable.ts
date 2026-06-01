import { useEffect, useRef, useState } from "react";

export interface UseResizableOptions {
  defaultWidth: number;
  min?: number;
  max?: number;
  /// `"left"` — the panel sits at the LEFT edge (drag handle on its right
  /// side; mouse moving RIGHT increases width). Use for Sidebar.
  /// `"right"` — the panel sits at the RIGHT edge (drag handle on its left
  /// side; mouse moving LEFT increases width). Use for PreviewPanel.
  side?: "left" | "right";
  /// When provided, the width is persisted to `localStorage` and restored on
  /// mount. `reset()` clears it. Omit to make the resize ephemeral.
  storageKey?: string;
}

/// Drag-to-resize hook. Generic enough to drive a left-aligned panel (Sidebar)
/// or a right-aligned one (PreviewPanel). The returned `onDragStart` should be
/// wired to a thin handle's `onMouseDown`; `reset` to its `onDoubleClick` if
/// you want the classic "double-click to restore default" affordance.
///
/// We capture mouse-move on the window so the user can drag past the handle
/// without losing focus — same UX as standard split-panel implementations.
export function useResizable({
  defaultWidth,
  min = 200,
  max = 560,
  side = "right",
  storageKey,
}: UseResizableOptions) {
  const [width, setWidth] = useState<number>(() => {
    if (storageKey) {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const n = Number(saved);
        if (Number.isFinite(n) && n >= min && n <= max) return n;
      }
    }
    return defaultWidth;
  });

  // Mirror state into a ref so the window listeners can read the latest width
  // without re-binding on every change (and without becoming stale closures).
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const rawDelta = e.clientX - dragRef.current.startX;
      // Left-aligned panel: moving right grows it. Right-aligned: moving left grows it.
      const delta = side === "left" ? rawDelta : -rawDelta;
      setWidth(Math.max(min, Math.min(max, dragRef.current.startW + delta)));
    };
    const onUp = () => {
      // Persist only at drag end — 60 writes/sec to localStorage during a drag
      // would be wasteful and synchronous on the main thread.
      if (dragRef.current && storageKey) {
        try { localStorage.setItem(storageKey, String(widthRef.current)); } catch { /* quota */ }
      }
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [min, max, side, storageKey]);

  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: widthRef.current };
  };

  const reset = () => {
    setWidth(defaultWidth);
    if (storageKey) {
      try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
    }
  };

  return { width, onDragStart, reset };
}
