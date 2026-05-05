import { convertFileSrc } from "@tauri-apps/api/core";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

interface Props {
  path: string;
}

export function PdfViewer({ path }: Props) {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [scale, setScale] = useState(1.2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const rendering = useRef<Set<number>>(new Set());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  // Load PDF as ArrayBuffer (same pattern as docx-preview)
  useEffect(() => {
    setLoading(true);
    setError(null);
    setPdfDoc(null);
    setNumPages(0);
    setCurrentPage(1);
    setPageInput("1");
    rendering.current.clear();

    const url = convertFileSrc(path);
    let cancelled = false;

    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => pdfjsLib.getDocument({ data: buf }).promise)
      .then((doc) => {
        if (cancelled) return;
        setPdfDoc(doc);
        setNumPages(doc.numPages);
        setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) { setError(String(e)); setLoading(false); }
      });

    return () => { cancelled = true; };
  }, [path]);

  const renderPage = useCallback(async (doc: PDFDocumentProxy, pageNum: number, s: number) => {
    if (rendering.current.has(pageNum)) return;
    rendering.current.add(pageNum);
    try {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: s });
      const div = pageRefs.current[pageNum - 1];
      if (!div) return;

      let canvas = div.querySelector("canvas") as HTMLCanvasElement | null;
      if (!canvas) {
        canvas = document.createElement("canvas");
        div.appendChild(canvas);
      }
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      div.style.width = `${viewport.width}px`;
      div.style.height = `${viewport.height}px`;

      const ctx = canvas.getContext("2d");
      if (ctx) await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    } finally {
      rendering.current.delete(pageNum);
    }
  }, []);

  // Set up IntersectionObserver once pdf is loaded
  useEffect(() => {
    if (!pdfDoc || numPages === 0) return;

    observerRef.current?.disconnect();

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const n = parseInt(entry.target.getAttribute("data-page") ?? "1");
          renderPage(pdfDoc, n, scaleRef.current);
          if (entry.intersectionRatio >= 0.4) {
            setCurrentPage(n);
            setPageInput(String(n));
          }
        });
      },
      { root: containerRef.current, threshold: [0.1, 0.4] }
    );

    pageRefs.current.slice(0, numPages).forEach((div) => {
      if (div) observer.observe(div);
    });
    observerRef.current = observer;

    // Render first page immediately
    renderPage(pdfDoc, 1, scaleRef.current);

    return () => observer.disconnect();
  }, [pdfDoc, numPages, renderPage]);

  // Re-render when scale changes: clear canvases and let observer re-trigger
  useEffect(() => {
    if (!pdfDoc) return;
    rendering.current.clear();
    pageRefs.current.slice(0, numPages).forEach((div) => {
      div?.querySelector("canvas")?.remove();
      if (div) div.style.height = `${Math.round(841 * scale)}px`;
    });
    // Re-render currently visible pages
    for (let i = 1; i <= Math.min(3, numPages); i++) {
      renderPage(pdfDoc, i, scale);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  const scrollToPage = (p: number) => {
    const n = Math.max(1, Math.min(numPages, p));
    pageRefs.current[n - 1]?.scrollIntoView({ behavior: "smooth", block: "start" });
    setCurrentPage(n);
    setPageInput(String(n));
  };

  return (
    <div className="flex flex-col h-full">
      {/* Controls bar */}
      <div className="flex items-center gap-1.5 px-3 h-9 bg-surface-2 border-b border-border-subtle shrink-0 select-none">
        <button
          onClick={() => scrollToPage(currentPage - 1)}
          disabled={currentPage <= 1}
          className="w-6 h-6 flex items-center justify-center rounded disabled:opacity-30 hover:bg-surface-3 transition-colors"
        >
          <ChevronLeft size={13} />
        </button>

        <div className="flex items-center gap-1 text-[11px] text-text-secondary">
          <input
            type="text"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={() => scrollToPage(parseInt(pageInput) || 1)}
            onKeyDown={(e) => { if (e.key === "Enter") scrollToPage(parseInt(pageInput) || 1); }}
            className="w-9 text-center bg-surface-3 border border-border rounded text-[11px] px-1 py-0.5 outline-none focus:border-accent"
          />
          <span className="text-text-muted">/ {numPages}</span>
        </div>

        <button
          onClick={() => scrollToPage(currentPage + 1)}
          disabled={currentPage >= numPages}
          className="w-6 h-6 flex items-center justify-center rounded disabled:opacity-30 hover:bg-surface-3 transition-colors"
        >
          <ChevronRight size={13} />
        </button>

        <div className="w-px h-4 bg-border mx-1" />

        <button
          onClick={() => setScale((s) => Math.max(0.5, +(s - 0.2).toFixed(1)))}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-surface-3 transition-colors"
          title="Zoom out"
        >
          <ZoomOut size={13} />
        </button>
        <span className="text-[11px] text-text-muted w-10 text-center tabular-nums">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => setScale((s) => Math.min(3, +(s + 0.2).toFixed(1)))}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-surface-3 transition-colors"
          title="Zoom in"
        >
          <ZoomIn size={13} />
        </button>
      </div>

      {/* Pages scroll area */}
      <div ref={containerRef} className="flex-1 overflow-y-auto bg-[#404040]">
        {loading && (
          <div className="flex items-center justify-center h-full text-white/50 text-[12px] animate-pulse">
            Chargement…
          </div>
        )}
        {error && (
          <div className="flex items-center justify-center h-full text-red-400 text-[12px] px-4 text-center">
            {error}
          </div>
        )}

        {!loading && !error && numPages > 0 && (
          <div className="flex flex-col items-center gap-5 py-6 px-4">
            {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => (
              <div
                key={n}
                ref={(el) => { pageRefs.current[n - 1] = el; }}
                data-page={n}
                className="relative bg-white shadow-2xl overflow-hidden"
                style={{ minWidth: 300, minHeight: Math.round(841 * scale) }}
              >
                {/* Subtle page number */}
                <span className="absolute bottom-1.5 right-2 text-[9px] text-black/25 select-none z-10 pointer-events-none">
                  {n}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
