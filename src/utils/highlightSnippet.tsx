import React from "react";

/// Render an FTS5 snippet string (containing `<b>matched</b>` markers from the
/// backend) as a React fragment with `<mark>` elements around the matched terms.
///
/// Critical: we NEVER use `dangerouslySetInnerHTML`. The backend emits literal
/// `<b>` / `</b>` strings — we split on those markers and build the JSX manually.
/// If a malicious file's content somehow contained `<script>`, it would render
/// as literal text, not as HTML.
///
/// We capture an even number of `<b>...</b>` pairs only. A dangling `<b>` (which
/// can technically happen if the snippet truncates mid-match) renders as text.
export function highlightSnippet(snippet: string): React.ReactNode {
  if (!snippet) return null;
  // Split keeps the delimiters as separate parts. Pattern matches the FULL
  // `<b>...</b>` chunk so we can decide whether to wrap it in <mark>.
  const parts = snippet.split(/(<b>.*?<\/b>)/);
  return parts.map((part, i) => {
    if (part.startsWith("<b>") && part.endsWith("</b>")) {
      const inner = part.slice(3, -4);
      return (
        <mark
          key={i}
          className="bg-accent/30 text-text-primary rounded-sm px-0.5"
        >
          {inner}
        </mark>
      );
    }
    // Plain text — including any stray literal "<b>" without close tag.
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}
