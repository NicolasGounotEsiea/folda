/**
 * nxs brand logo — Fluent (Windows 11) folder + nexus X.
 *
 * Two render modes:
 *
 *   - `accent` (default) — gradients pull from the user's accent CSS variables
 *     (`--color-accent`, `--color-accent-dim`, `--color-accent-glow`). The
 *     logo follows the theme. Use this for in-app surfaces (titlebar,
 *     onboarding, future about page) so the brand mark stays visually
 *     coherent with the rest of the chrome.
 *
 *   - `brand` — hard-coded Fluent blue palette, ignores the accent setting.
 *     Use this for "OS-facing" surfaces where the static brand identity
 *     matters (currently none in-app; the `public/nxs-icon.svg` file is the
 *     equivalent for taskbar/installer/favicon).
 *
 * Inline SVG so it picks up CSS variables synchronously and never waits on
 * a network/file fetch. IDs are namespaced with a stable `nxs-` prefix to
 * avoid collisions when multiple instances render on the same page.
 *
 * Source: keeps artwork verbatim from `public/nxs-icon.svg`. ViewBox tightened
 * to `48 96 416 416` so the logo doesn't read as visually smaller than
 * neighbor icons (VS Code etc.) at taskbar sizes — the original artwork only
 * occupied ~60% of a 512 canvas.
 */
export function NxsLogo({
  size = 64,
  variant = "accent",
  className,
}: {
  size?: number;
  /** `accent` follows --color-accent, `brand` stays Fluent blue. */
  variant?: "accent" | "brand";
  className?: string;
}) {
  const isBrand = variant === "brand";

  // Color stops resolve to either fixed Fluent blue (brand) or CSS variables
  // that follow the user's accent (accent). The accent variant maps the
  // existing --color-accent triplet (glow/main/dim) to the three points of
  // the folder gradient — every accent preset already defines these three
  // shades, so we get a coherent palette for free across all themes
  // (indigo, blue, emerald, amber, silver, etc.).
  const colors = isBrand
    ? {
        backFrom: "#1f6fe0",
        backTo:   "#0b46b8",
        frontFrom: "#5ad0ff",
        frontMid:  "#2f9bf2",
        frontTo:   "#1f7ae0",
        // Static dark-blue shadow for brand variant.
        shadowColor: "#06245c",
      }
    : {
        backFrom: "var(--color-accent)",
        backTo:   "var(--color-accent-dim)",
        frontFrom: "var(--color-accent-glow)",
        frontMid:  "var(--color-accent)",
        frontTo:   "var(--color-accent-dim)",
        // Accent-dim makes a tinted shadow that doesn't fight with the accent
        // body. For most presets it reads as a darkened version of the accent;
        // for silver it lands as a soft slate gray, still cohesive.
        shadowColor: "var(--color-accent-dim)",
      };

  return (
    <svg
      viewBox="48 96 416 416"
      width={size}
      height={size}
      className={className}
      aria-label="nxs"
      role="img"
    >
      <defs>
        <linearGradient id="nxs-folder-back" x1="20%" y1="0%" x2="80%" y2="100%">
          <stop offset="0%" stopColor={colors.backFrom} />
          <stop offset="100%" stopColor={colors.backTo} />
        </linearGradient>
        <linearGradient id="nxs-folder-front" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={colors.frontFrom} />
          <stop offset="55%" stopColor={colors.frontMid} />
          <stop offset="100%" stopColor={colors.frontTo} />
        </linearGradient>
        {/* Sheen + X stay white-ish regardless of variant — they're the
            "light" element of the design and need to read against any
            colored sheet. White-on-colored holds contrast across the whole
            accent palette (including silver, where the X picks up a subtle
            shadow from its own stroke to stay legible). */}
        <linearGradient id="nxs-front-sheen" x1="50%" y1="0%" x2="50%" y2="60%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="nxs-x-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#cdecff" />
        </linearGradient>
        <filter id="nxs-amb" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow
            dx="0"
            dy="14"
            stdDeviation="18"
            floodColor={colors.shadowColor}
            floodOpacity="0.45"
          />
        </filter>
        <filter id="nxs-soft" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
      </defs>

      <g filter="url(#nxs-amb)">
        {/* Back panel with folder tab (top-left) */}
        <path
          d="M 132 150 h 96 a 22 22 0 0 1 16 7 l 20 22 h 100 a 32 32 0 0 1 32 32 v 140 a 32 32 0 0 1 -32 32 h -252 a 32 32 0 0 1 -32 -32 v -169 a 32 32 0 0 1 32 -32 z"
          fill="url(#nxs-folder-back)"
        />

        {/* Front acrylic sheet */}
        <rect x="96" y="226" width="320" height="226" rx="34" ry="34" fill="url(#nxs-folder-front)" />
        <rect x="96" y="226" width="320" height="120" rx="34" ry="34" fill="url(#nxs-front-sheen)" />
        <path
          d="M 130 227 H 382"
          stroke="#ffffff"
          strokeOpacity="0.5"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </g>

      {/* Nexus X — faint glow echo + crisp main strokes */}
      <g fill="none" stroke="#ffffff" strokeLinecap="round" opacity="0.28" filter="url(#nxs-soft)">
        <path d="M 214 290 L 298 398" strokeWidth="16" />
        <path d="M 298 290 L 214 398" strokeWidth="16" />
      </g>
      <g fill="none" stroke="url(#nxs-x-grad)" strokeWidth="17" strokeLinecap="round">
        <path d="M 214 290 L 298 398" />
        <path d="M 298 290 L 214 398" />
      </g>
    </svg>
  );
}
