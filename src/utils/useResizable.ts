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
/// **Perf — React-bypass during drag.** A naive implementation would call
/// `setWidth()` on every mousemove (60 Hz). Each state change re-renders
/// the panel, which cascades into the neighbor pane (flex layout) and the
/// FileList rows beyond. On a folder with 100+ rows that's 6,000+ renders
/// per second, visibly stuttering the drag.
///
/// Instead, we write the new width DIRECTLY to the DOM via `containerRef`
/// during the drag — no React state changes, no reconciliation. The React
/// state (`width`) only updates on `mouseup`, which keeps persistence
/// (`localStorage`), the consumer's `style={{ width }}` initial render, and
/// the SSR-friendly "I know my width" semantics all intact.
///
/// Consumer side:
///   const { width, containerRef, onDragStart, reset } = useResizable(...);
///   return <div ref={containerRef} style={{ width }} ...>...</div>;
export function useResizable<E extends HTMLElement = HTMLDivElement>({
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

  // The panel element. Consumer attaches this to the resizable container's
  // ref prop. During drag we write `.style.width` here directly to avoid
  // React re-renders. When the drag ends we commit the final value to
  // React state so subsequent renders reflect the persisted layout.
  //
  // Generic element type — defaults to HTMLDivElement so most call sites
  // (PreviewPanel uses <div>) just work, but can be specialized to e.g.
  // HTMLElement for an <aside> (Sidebar) via `useResizable<HTMLElement>()`.
  const containerRef = useRef<E | null>(null);
  const dragRef = useRef<{ startX: number; startW: number; latest: number } | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current || !containerRef.current) return;
      const rawDelta = e.clientX - dragRef.current.startX;
      const delta = side === "left" ? rawDelta : -rawDelta;
      const next = Math.max(min, Math.min(max, dragRef.current.startW + delta));
      dragRef.current.latest = next;
      // Direct DOM write — bypass React. No re-render, no reconciliation
      // cascade. The browser still does a single layout + paint, which is
      // unavoidable and inexpensive compared to a full React tree update.
      containerRef.current.style.width = `${next}px`;
    };
    const onUp = () => {
      if (!dragRef.current) return;
      const final = dragRef.current.latest;
      dragRef.current = null;
      // Clear the global drag-mode class so transitions / hovers / animations
      // resume immediately. Doing this BEFORE setWidth so the next React
      // render lands without any visual side effects from the drag state.
      document.body.classList.remove("resize-dragging");
      // Commit to React state so persistence + subsequent renders see the
      // new width. The visual DOM is already at this width thanks to the
      // direct writes above; React's reconciliation here is a no-op for
      // the layout (the style attribute matches), it just syncs state.
      setWidth(final);
      if (storageKey) {
        try { localStorage.setItem(storageKey, String(final)); } catch { /* quota */ }
      }
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
    // Read the current width from the DOM rather than the React state, in
    // case a previous drag finished without React having committed yet
    // (shouldn't happen with the current code, but defensive).
    const startW = containerRef.current
      ? containerRef.current.getBoundingClientRect().width
      : width;
    dragRef.current = { startX: e.clientX, startW, latest: startW };
    // Tag the body so CSS can globally disable transitions / hovers / pointer
    // events / animations while the user is dragging. This kills the bulk of
    // the per-frame work the browser does that ISN'T the actual width change:
    // hover repaints across the file list, color transitions on the resize
    // handle, modal entrance animations, toast shimmers — all suppressed.
    document.body.classList.add("resize-dragging");
  };

  const reset = () => {
    setWidth(defaultWidth);
    if (containerRef.current) {
      containerRef.current.style.width = `${defaultWidth}px`;
    }
    if (storageKey) {
      try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
    }
  };

  return { width, containerRef, onDragStart, reset };
}
