import { convertFileSrc } from "@tauri-apps/api/core";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { ChevronLeft, ChevronRight, Search, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useViewerFindStore } from "../store/useViewerFindStore";
import { useTranslation } from "../utils/i18n";

import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

interface Props {
  path: string;
}

/// One occurrence of the search query in the document. `pageNum` is 1-based.
/// `itemIdx` indexes into the per-page text-item arrays produced by pdfjs's
/// TextLayer (both `textContentItemsStr` and `textDivs`, which are 1:1 by
/// construction in pdfjs's #processItems loop). `startInItem` / `endInItem`
/// are character offsets within that single item's string — guaranteed to
/// match `textDivs[itemIdx].firstChild.textContent` exactly because pdfjs
/// sets `textDiv.textContent = item.str` directly (pdf.mjs line 14575).
interface FindHit {
  pageNum: number;
  itemIdx: number;
  startInItem: number;
  endInItem: number;
}

export function PdfViewer({ path }: Props) {
  const t = useTranslation();
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [scale, setScale] = useState(1.2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Find state. `findHits` is null while we haven't searched yet; an empty
  // array means "searched, no results". `activeHit` is the index into hits
  // we're currently focused on.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findHits, setFindHits] = useState<FindHit[] | null>(null);
  const [activeHit, setActiveHit] = useState(0);
  const [findLoading, setFindLoading] = useState(false);
  const findInputRef = useRef<HTMLInputElement>(null);
  // Mirror find state into refs. `renderPage` is a useCallback with [] deps
  // (intentional — we don't want to recreate it on every state change),
  // which means it captures its closure at mount and re-uses it for the
  // lifetime of the component. When renderPage calls applyFindHighlightsToPage
  // — typically when a previously-unrendered page scrolls into view during
  // an active search — that function must read CURRENT findHits/activeHit,
  // not the null/0 values they had at mount. Using refs sidesteps the stale
  // closure entirely: the ref object is stable across renders and its
  // `.current` always reflects the latest committed state.
  const findHitsRef = useRef<FindHit[] | null>(null);
  findHitsRef.current = findHits;
  const activeHitRef = useRef(0);
  activeHitRef.current = activeHit;

  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const rendering = useRef<Set<number>>(new Set());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  // Per-page text-item strings, ORIGINAL case preserved. Populated by
  // `renderPage` (visible) and `ensureAllPagesTextExtracted` (offscreen) —
  // both go through pdfjs's TextLayer so the strings match what the DOM
  // will contain. Index `i` here ↔ index `i` in `pageItemDivsRef` (when
  // that page is visibly rendered). Used both as the search source
  // (lowercased on the fly in searchAllPages) and as the verbatim text to
  // re-insert into a textDiv when clearing or rebuilding its marks.
  const pageItemStrsRef = useRef<Map<number, string[]>>(new Map());
  // Per-page DOM elements for each text item. pdfjs `TextLayer` exposes these
  // via `textDivs` after `render()` — guaranteed 1:1 with `textContentItemsStr`
  // by construction (pushed together in #processItems). Only populated when
  // the page is visibly rendered.
  const pageItemDivsRef = useRef<Map<number, HTMLElement[]>>(new Map());

  // Load PDF as ArrayBuffer (same pattern as docx-preview)
  useEffect(() => {
    setLoading(true);
    setError(null);
    setPdfDoc(null);
    setNumPages(0);
    setCurrentPage(1);
    setPageInput("1");
    rendering.current.clear();
    // Reset find state — caches are per-document, hits become stale on doc change.
    setFindOpen(false);
    setFindQuery("");
    setFindHits(null);
    setActiveHit(0);
    pageItemStrsRef.current.clear();
    pageItemDivsRef.current.clear();

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

      // Text layer — transparent HTML overlay with positioned spans. Enables
      // native text selection (drag-select + Ctrl+C) on top of the canvas, and
      // serves as our search target for the find feature below.
      let textLayerDiv = div.querySelector(".pdf-text-layer") as HTMLDivElement | null;
      if (!textLayerDiv) {
        textLayerDiv = document.createElement("div");
        textLayerDiv.className = "pdf-text-layer";
        textLayerDiv.setAttribute("data-page", String(pageNum));
        div.appendChild(textLayerDiv);
      }
      textLayerDiv.style.width = `${viewport.width}px`;
      textLayerDiv.style.height = `${viewport.height}px`;
      // pdfjs computes textDiv font-size as `calc(var(--text-scale-factor)
      // * var(--font-height))` where --text-scale-factor depends on
      // --total-scale-factor. Without setting this, the calc is invalid and
      // text renders at the browser-default 16px, which breaks both visual
      // alignment and Range.getClientRects() positions used for find
      // highlights. The value matches the viewport scale we just rendered at.
      textLayerDiv.style.setProperty("--total-scale-factor", String(s));
      // Clear any prior text-layer content (re-render on zoom change).
      textLayerDiv.replaceChildren();

      try {
        const textContent = await page.getTextContent();
        const textLayer = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport,
        });
        await textLayer.render();

        // Store the ORIGINAL per-item strings (case preserved). We need them
        // verbatim to restore textDiv content when clearing marks, and so the
        // re-inserted text matches what pdfjs originally placed via
        // `textDiv.textContent = item.str`. Case-insensitive search lowercases
        // on the fly in searchAllPages. The textDivs array from pdfjs is 1:1
        // with textContentItemsStr by construction (#processItems loop).
        const itemStrs = textLayer.textContentItemsStr;
        const itemDivs = textLayer.textDivs;
        if (itemStrs.length === itemDivs.length) {
          pageItemStrsRef.current.set(pageNum, [...itemStrs]);
          pageItemDivsRef.current.set(pageNum, itemDivs);
        }

        // Apply existing find highlights — itemStrs here is the same array
        // (by content) as whatever was captured by `ensureAllPagesTextExtracted`
        // for this page, so any FindHit's (itemIdx, startInItem, endInItem)
        // still points at the correct character range in the new divs.
        applyFindHighlightsToPage(pageNum);
      } catch (e) {
        // Text layer is non-critical — if extraction fails, canvas still works.
        console.warn(`pdf text layer failed for page ${pageNum}:`, e);
      }
    } finally {
      rendering.current.delete(pageNum);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // ── Find: ensure all pages' text is extracted ────────────────────────────
  //
  // For pages NOT yet visibly rendered we still need their per-item strings
  // so the user's query can find matches across the whole document. We run
  // a real TextLayer render into a DETACHED container — this guarantees the
  // item array we capture matches what the visible render will produce
  // later (same filtering of marked-content items, same EOL handling). The
  // detached div and the textDivs inside it are eligible for GC as soon as
  // this function returns; we keep only the strings.
  const ensureAllPagesTextExtracted = useCallback(async (doc: PDFDocumentProxy) => {
    for (let n = 1; n <= doc.numPages; n++) {
      if (pageItemStrsRef.current.has(n)) continue;
      try {
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale: scaleRef.current });
        const textContent = await page.getTextContent();

        // Run TextLayer.render() into a detached container so we capture the
        // EXACT `textContentItemsStr` pdfjs will produce when this page is
        // later rendered visibly. The divs themselves are about to be GC'd —
        // we only keep the strings. The visible render (renderPage) processes
        // the same items in the same order, so its `textDivs` array aligns
        // index-for-index with what we store here.
        const detached = document.createElement("div");
        const tl = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: detached,
          viewport,
        });
        await tl.render();
        pageItemStrsRef.current.set(n, [...tl.textContentItemsStr]);
      } catch {
        pageItemStrsRef.current.set(n, []);
      }
    }
  }, []);

  // ── Find: search per text-item and return all hits ──────────────────────
  //
  // KEY INVARIANT: we search each text item INDEPENDENTLY. A hit's position
  // is always within a single item — never spans a boundary. This guarantees
  // that the (itemIdx, startInItem) tuple maps 1:1 to a DOM range built from
  // `divs[itemIdx].firstChild` because pdfjs sets `textDiv.textContent =
  // item.str` directly (no normalization, no wrapping). Multi-item matches
  // (e.g. a query split across two items in the PDF stream) are intentionally
  // not surfaced — they're rare for word-level search and would require
  // cross-element highlighting that adds complexity for marginal benefit.
  const searchAllPages = useCallback((query: string): FindHit[] => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: FindHit[] = [];
    pageItemStrsRef.current.forEach((strs, pageNum) => {
      for (let i = 0; i < strs.length; i++) {
        // Lowercase on the fly. For ASCII (the vast majority of PDF text)
        // positions in the lowercased string are identical to positions in
        // the original, so `found` is a valid char offset for the original
        // string too — which is what we use later to slice for the mark.
        const text = strs[i].toLowerCase();
        let idx = 0;
        while (true) {
          const found = text.indexOf(q, idx);
          if (found === -1) break;
          hits.push({
            pageNum,
            itemIdx: i,
            startInItem: found,
            endInItem: found + q.length,
          });
          idx = found + q.length;
        }
      }
    });
    hits.sort((a, b) => {
      if (a.pageNum !== b.pageNum) return a.pageNum - b.pageNum;
      if (a.itemIdx !== b.itemIdx) return a.itemIdx - b.itemIdx;
      return a.startInItem - b.startInItem;
    });
    return hits;
  }, []);

  // ── Find: highlights via INLINE <mark> elements inside each textDiv ─────
  //
  // We do NOT compute coordinates ourselves. For each hit, we mutate the
  // matching textDiv's children: replace its single text node with a
  // sequence of [pre-text, <mark>match</mark>, post-text]. The browser
  // positions the <mark> automatically because it's an INLINE child of the
  // textDiv — it inherits the textDiv's font-size, transform (scaleX,
  // rotate, scale(1/min-font-size)) and transform-origin. The mark's
  // background paints at exactly the same pixels where the textDiv's text
  // sits, which is exactly where the canvas underneath has the equivalent
  // characters. Pixel-perfect alignment is GUARANTEED by the layout engine
  // — there is no coordinate math anywhere in this function that could
  // drift relative to the canvas.
  //
  // For divs with no hits we restore the original text content (clears any
  // marks left over from a previous query).
  function applyFindHighlightsToPage(
    pageNum: number,
    hitsOverride?: FindHit[] | null,
    activeHitOverride?: number,
  ) {
    // Read via refs, not state — see the findHitsRef comment up top. State
    // captured by closure is stale when this is called from inside the
    // frozen renderPage useCallback.
    const effectiveHits = hitsOverride !== undefined ? hitsOverride : findHitsRef.current;
    const effectiveActiveHit = activeHitOverride !== undefined ? activeHitOverride : activeHitRef.current;

    const divs = pageItemDivsRef.current.get(pageNum);
    const strs = pageItemStrsRef.current.get(pageNum);
    if (!divs || !strs) return;

    // Group hits by item so each div is mutated at most once per call.
    const hitsByItem = new Map<number, Array<{ hit: FindHit; globalIdx: number }>>();
    if (effectiveHits) {
      for (let g = 0; g < effectiveHits.length; g++) {
        const h = effectiveHits[g];
        if (h.pageNum !== pageNum) continue;
        let arr = hitsByItem.get(h.itemIdx);
        if (!arr) { arr = []; hitsByItem.set(h.itemIdx, arr); }
        arr.push({ hit: h, globalIdx: g });
      }
      for (const arr of hitsByItem.values()) {
        arr.sort((a, b) => a.hit.startInItem - b.hit.startInItem);
      }
    }

    for (let i = 0; i < divs.length; i++) {
      const div = divs[i];
      if (!div) continue;
      const orig = strs[i] ?? "";
      const itemHits = hitsByItem.get(i);

      if (!itemHits || itemHits.length === 0) {
        // No hits on this item — make sure its content is the original
        // (clears marks from a previous query, no-op if already clean).
        if (div.textContent !== orig) div.textContent = orig;
        continue;
      }

      // Rebuild the div's children: alternating text nodes and <mark>s.
      div.replaceChildren();
      let cursor = 0;
      for (const { hit, globalIdx } of itemHits) {
        // Defensive clamp — should hold by construction (hit positions came
        // from indexOf on the same string we're slicing now).
        const s = Math.max(0, Math.min(orig.length, hit.startInItem));
        const e = Math.max(s, Math.min(orig.length, hit.endInItem));
        if (s > cursor) div.appendChild(document.createTextNode(orig.slice(cursor, s)));
        const mark = document.createElement("mark");
        mark.className = globalIdx === effectiveActiveHit
          ? "pdf-find-mark pdf-find-mark-active"
          : "pdf-find-mark";
        mark.textContent = orig.slice(s, e);
        div.appendChild(mark);
        cursor = e;
      }
      if (cursor < orig.length) div.appendChild(document.createTextNode(orig.slice(cursor)));
    }
  }

  // Re-apply highlights to all currently-rendered pages whenever the hits
  // or active index changes (e.g. user navigates next/prev).
  useEffect(() => {
    for (let n = 1; n <= numPages; n++) {
      applyFindHighlightsToPage(n);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findHits, activeHit, numPages]);

  // ── Find: navigate to a specific hit ─────────────────────────────────────
  const navigateToHit = useCallback(async (hitIdx: number) => {
    if (!findHits || findHits.length === 0 || !pdfDoc) return;
    const idx = ((hitIdx % findHits.length) + findHits.length) % findHits.length;
    const hit = findHits[idx];
    setActiveHit(idx);

    // Make sure the target page is rendered (its text layer too) so we can
    // scroll-to-hit and the highlight class lands on a real span.
    if (!pageRefs.current[hit.pageNum - 1]?.querySelector("canvas")) {
      await renderPage(pdfDoc, hit.pageNum, scaleRef.current);
    }
    scrollToPage(hit.pageNum);
    // Brief delay to let the scroll settle, then re-apply highlight (the
    // useEffect will fire from activeHit change too, but explicit call here
    // covers the case where the page just rendered.)
    setTimeout(() => applyFindHighlightsToPage(hit.pageNum), 150);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findHits, pdfDoc, renderPage]);

  // ── Find: run search when query changes ──────────────────────────────────
  const runSearch = useCallback(async (query: string) => {
    setFindQuery(query);
    if (!pdfDoc || !query.trim()) {
      setFindHits(null);
      setActiveHit(0);
      return;
    }
    setFindLoading(true);
    try {
      await ensureAllPagesTextExtracted(pdfDoc);
      const hits = searchAllPages(query);
      setFindHits(hits);
      setActiveHit(0);
      if (hits.length > 0) {
        // Auto-jump to first hit.
        const firstHit = hits[0];
        if (!pageRefs.current[firstHit.pageNum - 1]?.querySelector("canvas")) {
          await renderPage(pdfDoc, firstHit.pageNum, scaleRef.current);
        }
        scrollToPage(firstHit.pageNum);
      }
    } finally {
      setFindLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, ensureAllPagesTextExtracted, searchAllPages, renderPage]);

  // ── Ctrl+F integration via the global viewer-find store ─────────────────
  useEffect(() => {
    useViewerFindStore.getState().setHandler(() => {
      setFindOpen(true);
      // Focus after the render flush — the input is mounted conditionally.
      setTimeout(() => findInputRef.current?.focus(), 0);
    });
    return () => useViewerFindStore.getState().setHandler(null);
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Text layer CSS — scoped to PdfViewer to avoid bleeding into the rest
          of the app. pdfjs's TextLayer renders spans positioned absolutely
          with their text content; we make them invisible (color transparent)
          so they overlay the canvas without obscuring it. Native browser
          selection works because the spans are real DOM. Find highlights are
          injected as inline <mark> children of the matching textDivs (see
          applyFindHighlightsToPage). */}
      <style>{`
        /* Adapted from pdfjs's canonical text_layer_builder.css. The text
           layer is a transparent overlay where every span paints invisible
           text at the same position/size as the canvas rendering — enabling
           native selection and our find feature. CRITICAL: pdfjs does NOT
           set font-size or transform inline on textDivs; it only sets the
           CSS custom properties --font-height, --scale-x, --rotate, and
           expects the host page to provide rules like:
             font-size: calc(var(--text-scale-factor) * var(--font-height))
             transform: rotate(var(--rotate)) scaleX(var(--scale-x)) ...
           Without these the textDivs render at the browser default 16px
           with no horizontal scaling, so their bounding boxes (and the
           result of Range.getClientRects() used for find highlights) land
           at totally wrong pixel positions relative to the canvas. */
        .pdf-text-layer {
          position: absolute;
          inset: 0;
          overflow: hidden;
          line-height: 1;
          z-index: 2;
          opacity: 1;
          forced-color-adjust: none;
          transform-origin: 0 0;
          user-select: text;
          -webkit-user-select: text;
          --min-font-size: 1;
          --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
          --min-font-size-inv: calc(1 / var(--min-font-size));
        }
        /* markedContent containers must disappear from layout so their
           children position relative to .pdf-text-layer, not to a 0×0
           static box. pdfjs uses display:contents for this. */
        .pdf-text-layer .markedContent {
          display: contents;
        }
        .pdf-text-layer span,
        .pdf-text-layer br {
          color: transparent;
          position: absolute;
          white-space: pre;
          cursor: text;
          transform-origin: 0% 0%;
        }
        /* Direct text spans AND text spans inside markedContent — both
           paths get the font sizing and transform that pdfjs's #layout
           computes into the inline --font-height / --scale-x / --rotate
           custom properties. */
        .pdf-text-layer > :not(.markedContent),
        .pdf-text-layer .markedContent span:not(.markedContent) {
          --font-height: 0;
          font-size: calc(var(--text-scale-factor) * var(--font-height));
          --scale-x: 1;
          --rotate: 0deg;
          transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
        }
        .pdf-text-layer ::selection {
          background: rgba(99, 102, 241, 0.35);
          color: transparent;
        }
        .pdf-text-layer ::-moz-selection {
          background: rgba(99, 102, 241, 0.35);
          color: transparent;
        }
        /* Find highlights are <mark> elements injected INLINE inside the
           textDivs. They inherit the span's font-size + transform stack, so
           the browser paints their background at the exact same pixels as
           the underlying canvas text — no coordinate math, no drift. We
           neutralize the browser's default mark styling (yellow background,
           inherited text color) and replace with our subtle amber, then
           override with a stronger orange for the active hit. The 0 1px
           padding with -1px margin widens the background a touch so it
           doesn't visually crop the glyph edges. */
        .pdf-text-layer mark.pdf-find-mark {
          background: rgba(251, 191, 36, 0.4);
          color: transparent;
          padding: 0 1px;
          margin: 0 -1px;
          border-radius: 1px;
          box-decoration-break: clone;
          -webkit-box-decoration-break: clone;
        }
        .pdf-text-layer mark.pdf-find-mark-active {
          background: rgba(249, 115, 22, 0.65);
        }
      `}</style>
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

        <div className="w-px h-4 bg-border mx-1" />

        {/* Find bar — collapsed by default, expands when Ctrl+F is pressed
            (via useViewerFindStore) or the button is clicked. The whole UI
            lives in the controls bar to stay out of the way of the rendered
            pages and keep the document area maximally usable. */}
        {findOpen ? (
          <div className="flex items-center gap-1 h-6 px-1.5 rounded bg-surface-3 border border-border shrink-0">
            <Search size={11} className="text-text-muted" />
            <input
              ref={findInputRef}
              type="text"
              value={findQuery}
              onChange={(e) => runSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (findHits && findHits.length > 0) {
                    navigateToHit(activeHit + (e.shiftKey ? -1 : 1));
                  }
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setFindOpen(false);
                  setFindQuery("");
                  setFindHits(null);
                }
              }}
              placeholder={t.pdfFindPlaceholder}
              className="bg-transparent text-[11px] text-text-primary placeholder-text-muted outline-none w-40"
            />
            {findLoading ? (
              <span className="text-[10px] text-text-muted shrink-0 animate-pulse">…</span>
            ) : findQuery && findHits !== null ? (
              <span className="text-[10px] text-text-muted shrink-0 tabular-nums">
                {findHits.length === 0 ? "0/0" : `${activeHit + 1}/${findHits.length}`}
              </span>
            ) : null}
            <button
              onClick={() => navigateToHit(activeHit - 1)}
              disabled={!findHits || findHits.length === 0}
              title={t.pdfFindPrev}
              className="text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
            >
              ↑
            </button>
            <button
              onClick={() => navigateToHit(activeHit + 1)}
              disabled={!findHits || findHits.length === 0}
              title={t.pdfFindNext}
              className="text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
            >
              ↓
            </button>
            <button
              onClick={() => {
                setFindOpen(false);
                setFindQuery("");
                setFindHits(null);
              }}
              className="text-text-muted hover:text-text-primary ml-1"
              title={t.pdfFindClose}
            >
              <X size={11} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => {
              setFindOpen(true);
              setTimeout(() => findInputRef.current?.focus(), 0);
            }}
            title={t.pdfFindOpen}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-surface-3 transition-colors"
          >
            <Search size={13} />
          </button>
        )}
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
