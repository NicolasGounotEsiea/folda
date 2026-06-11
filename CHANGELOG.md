# Changelog

All notable changes to nxs are documented here.

## [0.1.13] - 2026-06-11

### Added

- **Illustrated empty states** across the FileList and TrashModal. The bare "Empty folder" text is replaced with a centered icon-halo + title + hint pattern, with a contextual action button where relevant: empty folder → drag/right-click hint; search with no matches → "Clear search" button (keeps the query in the hint via `{query}` placeholder); active tag filter excluding everything → "Clear filters" button; empty trash → restore/empty hint. New `EmptyState` component is the reusable primitive (icon halo, title, optional action slot, compact mode for narrower panels).
- **Status bar info-density boost**. The footer bar now shows live indexing progress for the current path (subscribes to `useIndexingStore` via a path-specific selector — re-renders only on that path's progress changes), the current sort column + direction (hidden during search where ordering is BM25-driven), and a `+hidden` badge when `showHidden` is on. Existing total + selection count + size stays in place on the left. Tabular numbers everywhere so digits don't jitter during updates.
- **Skeleton loaders during folder navigation**. When `panePath` changes and the new entries don't arrive within 100 ms (slow disk, remote share, large folder), 12 grey pulse rows shaped like real `EntryRow`s appear with the same `ROW_COLS`/`ROW_GRID` template so the eventual swap to real content is layout-shift-free. Each row pulses with a small per-index delay (60-90 ms cascade) for a soft wave rather than synchronized strobing. Grid mode gets its own square-tile skeleton variant. Cache hits never flash a skeleton (the timer is cancelled the moment paneEntries reference changes). A 4 s defensive fallback force-clears the skeleton if for any reason both useEffects miss — no eternal-skeleton bug.
- **Entry-row fade-up stagger** on initial folder mount. Every visible row enters with a 170 ms opacity+translateY-4px animation, staggered 12 ms per index, easing `cubic-bezier(0.16, 1, 0.3, 1)`. Animation only fires on element mount — re-renders from selection/tag changes don't re-trigger. All-or-nothing rule: folders ≥ 50 entries skip the animation entirely (was previously partial — first 40 only — but the seam between staggered and static rows read as visually broken; binary threshold avoids the seam and dodges the GPU layer cost of 500+ simultaneous animations on large folders).
- **Color-coded file icons by category**. 11 distinct categories (images, video, audio, code, data/config, documents, plain text, spreadsheets, presentations, archives, executables, fonts, settings-files) each with their own Lucide icon + Tailwind color shade. Lookup is a module-level `Map<string, IconCategory>` built once at load — O(1) per row, zero allocations on hot path. Executables get red as a "this runs code" caution cue; spreadsheets get emerald (distinct from documents-blue); data files (JSON/YAML/TOML/XML/INI) get sky.
- **Unified modal entrance animations**. New CSS classes `modal-backdrop-in` (200 ms fade) + `modal-content-in` (240 ms scale 0.96→1 + translate 8px→0, same ease-out-expo as onboarding) applied to **all 16 modals** in the app: Settings, Trash, BulkRename, ConfirmDialog, TagRules, DiskUsage, KeyboardShortcuts, FolderPicker, Snapshots, Editor close-confirm, CommandPalette, QuickLook, AutomationsModal, DiffCompareModal, ShareModal, JoinModal, TabBar close-confirm, FileList zip-name prompt. Pure CSS one-shot, GPU-only (transform + opacity), no JS state.
- **Toast notifications redesigned**. Position moved bottom-left → bottom-right (industry standard, doesn't collide with the sidebar). Replaced the all-around colored border with a 3 px accent strip on the left edge (cleaner visual identity, less noise in the message area). Added a soft glow shadow tinted to the toast type (success-green / error-red / warning-amber / info-blue). New `toast-in` animation: 220 ms slide-up + scale 0.96→1 + fade-in on mount. `flex-col-reverse` on the stack so new toasts appear at the bottom without pushing the older ones. No state-machine for exit animation or hover-pause (kept simple to avoid race conditions with the auto-dismiss timer).
- **`PreviewPanel` (and other `select-text` regions) can copy text via Ctrl+C**. The window-level keydown handler in `FileList` used to hijack Ctrl+C for the "copy selected file paths to clipboard" action whenever any file was selected — even if the user had text selected in the PreviewPanel. Now both Ctrl+C and Ctrl+X check `window.getSelection().toString().trim().length > 0` and silently pass through to the browser's native text-copy when text is selected. Selection in input/textarea was already handled; this closes the equivalent gap for divs with `select-text`.
- **Fluent (Windows 11) app icon** — replaces the previous "N-X-S letters with cyan glow" design. The new artwork is a front-facing folder with a deep blue back panel (vibrancy gradient #1f6fe0 → #0b46b8), a translucent cyan-blue acrylic front sheet (#5ad0ff → #2f9bf2 → #1f7ae0), the brand "X" centered on the sheet in white-to-ice gradient, plus a soft Fluent ambient shadow. ViewBox tightened from `0 0 512 512` to `48 96 416 416` after the first round of generation revealed the icon read as visually smaller than neighbors (VS Code, etc.) in the taskbar — the artwork only spans ~60% of a 512 canvas, so the crop scales it ~25% bigger on each axis without touching the coordinates or shadow tail.
- **New `<NxsLogo />` React component** with two variants:
  - `variant="accent"` (default) — gradients follow the user's accent color via CSS variables (`--color-accent`, `--color-accent-dim`, `--color-accent-glow`). Used in the in-app titlebar (replaces the static `<img src="/nxs-icon.svg">` that always rendered brand blue and clashed with non-blue accents) and the onboarding welcome step.
  - `variant="brand"` — hard-coded Fluent blue palette, mirrors the static `public/nxs-icon.svg` used at OS surfaces.
  - Onboarding welcome step also got its drop-shadow rgba() switched from a hardcoded `rgba(31,111,224,0.35)` to `rgba(var(--color-accent-rgb),0.35)` so the glow follows the accent too.
- **Brand identity / theme split**. OS-facing surfaces (Windows taskbar, installer .ico, Start menu, favicon) stay **brand-blue always** — recognizability is more important than theme matching outside the app. In-app surfaces (titlebar, onboarding, future about/splash) **follow the accent**. Same pattern as VS Code (always blue), Slack (always purple), Notion (always black).

### Improved

- **Search input no longer hijacks Ctrl+C** in any `select-text` region (covered by the PreviewPanel fix above — generalizes to every place in the app that uses `select-text` on a div, not just the PreviewPanel).
- **All new animations respect `prefers-reduced-motion: reduce`** (skeleton-pulse, row-fade-up, modal-backdrop-in, modal-content-in, toast-in). Users with motion-reduction enabled at the OS level see the same UI states but without the animations.
- **GitHub Actions release workflow** — the changelog extraction regex correctly captures multi-paragraph entries with code fences and nested lists (verified against the previous 0.1.11 and 0.1.12 sections at runtime). No change required this release.
- **All 42 OS icon files regenerated** from the new SVG via `npx tauri icon public/nxs-icon.svg`: `.ico` for Windows, `.icns` for macOS, 4 main PNGs (32/64/128/128@2x), 9 Windows Store tile logos (Square30 → Square310), 16 iOS AppIcon variants (AppIcon-20 → AppIcon-512), 15 Android mipmap variants (hdpi/mdpi/xhdpi/xxhdpi/xxxhdpi × launcher/launcher_round/launcher_foreground). Visual verification at 32×32 (taskbar size) and 128×128 confirmed crisp rendering, no antialiasing glitches, shadow preserved.

### Fixed

- **Skeleton stuck after navigation back/forward when entries arrive fast** (cache hit). The pre-fire timer (delays skeleton appearance by 100 ms to avoid flashing on instant nav) wasn't cancelled when entries landed before it fired. The timer then fired AFTER the new entries were already in the DOM, setting `skeletonVisible = true` and nothing else lowered it. Fixed by sharing a `skeletonTimerRef` across both useEffects: the `paneEntries`-change effect now also `clearTimeout`s the pending pre-fire. Added a 4 s defensive max-duration as a safety net.
- **Stagger animation pegged the GPU on big folders**. The cap at 40 rows worked but created a visible seam where the cascade abruptly met the static rows below. Replaced with an all-or-nothing rule keyed on `visibleEntries.length` vs `STAGGER_THRESHOLD = 50` — small folders animate everything, large ones skip animation entirely. No more seam, no more 500+ simultaneous compositor layers.
- **`Cargo.lock` version sync** — bumped to 0.1.13 alongside the other 3 version files (package.json, Cargo.toml, tauri.conf.json) so the GitHub Actions release workflow's manifest parsing doesn't drift.

### Internal

- `STAGGER_LIMIT = 40` → `STAGGER_THRESHOLD = 50` constant in `FileList.tsx`. Renamed because the new semantics is "above this count, no stagger at all" (binary), not "cap the staggered count" (partial).
- `EXT_TO_CATEGORY: Map<string, IconCategory>` is constructed at module load — not per-row — for the file icon lookup. The `mkCategory(exts, Icon, color)` helper widens per-category color literals into `string` so TypeScript can spread the per-category tuples into a single `Map<>` constructor without strict-tuple narrowing fights.
- New animation primitives in `index.css`: `skeleton-pulse`, `row-fade-up`, `modal-backdrop-in`, `modal-content-in`, `toast-in`. Each gets a corresponding `@media (prefers-reduced-motion: reduce) { animation: none; }` entry.
- `NxsLogo` IDs are namespaced (`nxs-folder-back`, `nxs-folder-front`, `nxs-front-sheen`, `nxs-x-grad`, `nxs-amb`, `nxs-soft`) to prevent gradient collisions if multiple instances render on the same page (e.g., titlebar + onboarding visible at once).
- `index.html` title updated from the legacy "Contextual Workspace" to `nxs`. Favicon switched from the default Vite `/vite.svg` to `/nxs-icon.svg`.

## [0.1.12] - 2026-06-10

### Added

- **Silver accent preset** — 9th option in Settings → Appearance → Accent. The accent color itself is slate-400 (a clean recognizable silver) but the picker swatch renders a polished-sphere radial gradient so it visually reads as metal in the picker, not just gray. Selecting it toggles a new `accent-metallic` class on `<html>` that propagates a polished-chrome look across every `bg-accent` surface in the app — diagonal linear gradient from accent-glow → accent → accent-dim plus inset shadows for a carved-from-metal feel. Extensible: any future preset with a `swatch` field auto-activates the metallic treatment.
- **Hover shimmer on metallic accent** — on Silver, when you hover any `bg-accent` button, a translucent white highlight band sweeps across in 1s (ease-out, single pass, fill-mode forwards so the band stays parked off the right edge after). Re-entering re-triggers. At rest: zero animation, zero CPU cost. Touch devices (no `:hover`) see only the static metallic look, no broken animation states.
- **Workspace switch pulse** — the workspace icon in the sidebar switcher gets a brief scale-up (1 → 1.22 → 1 with bezier overshoot) every time `activeContextId` changes. Driven by a `key` prop that forces a remount on switch — keyframe re-fires automatically. First mount also pulses, doubling as a small welcome cue. Works regardless of which accent color is selected.
- **Dual-pane file comparison** — in dual-pane mode, you can now compare a file from pane 1 against a file from pane 2 without having to move them into the same folder first. Two entry points:
  - **Context menu** "Compare with other pane" — shown only when dual-pane is active, the right-clicked file is non-dir, and the other pane has exactly one non-dir file selected. Hidden (not greyed) otherwise so single-pane users never see an action they couldn't use.
  - **Ctrl+D shortcut** with the same precondition check; silent no-op if conditions aren't met (no toast spam). Routes to the existing `DiffCompareModal` — no new UI was needed.

### Improved

- **File diff alignment on highly repetitive content** — comparing files made of hundreds of identical lines (config files with the same line repeating, generated text, etc.) used to scatter a single inserted line as several phantom delete+insert pairs in unrelated hunks because Myers' minimal-cost path has many valid alignments on such inputs. `diff_files` now runs a **4-way race**: forward Myers, backward Myers (inverted), forward Patience, backward Patience (inverted). Patience anchors on unique lines first, producing more visually coherent alignments; the backward+inverted variants fix a directional asymmetry where A→B and B→A produced different row counts on the same files. `pick_fewest_rows` picks whichever candidate has the fewest non-equal rows after our post-processing pairs adjacent delete+insert into modifies — guarantees the cleanest user-perceptible alignment wins.
- **New `invert_hunks` helper** swaps `left ↔ right` content + line numbers, `delete ↔ insert` kinds, and intra-line marker types (`MARK_DEL_*` ↔ `MARK_INS_*` via a tombstone-based 6-pass `replace` so the swap never ping-pongs). Lets us reuse a backward-direction diff as if it had been computed forward, restoring the left=red / right=green visual convention. A new test `diff_is_symmetric_on_repetitive_content` guards against future regression of the asymmetry bug.

### Internal

- New `AccentPreset.swatch?: string` field — optional CSS gradient used for the picker swatch only. Lets metallic / iridescent presets render with shine in the picker while the actual accent stays flat throughout the rest of the UI. The metallic CSS overrides are gated on the presence of this field via the `accent-metallic` class toggle, so a future Rose Gold / Aurora preset opts in without touching code.
- New CSS keyframes in `index.css`: `accent-shimmer` (hover sweep), `workspace-pulse` (icon scale on workspace switch). Both respect `prefers-reduced-motion: reduce`.

## [0.1.11] - 2026-06-09

### Added

- **Live scan progress counter** during folder import. The backend's `walk_phase` emits `scan-progress` Tauri events every 500 files (`SCAN_PROGRESS_INTERVAL`) carrying `{ path, scanned, done }`. The FileList's "Scanning…" overlay now shows a live `12,482 files` counter under the spinner via a global `scanProgress` slot in `useStore`, populated by a listener in `App.tsx` and cleared by the Sidebar's addFolder `.finally`. Replaces the opaque spinner that gave zero signal of progress on 50k-file imports.
- **Onboarding overhaul** — the modal is now genuinely dynamic instead of static text + icon. Animation primitives in `index.css` (`onboard-modal-in`, `onboard-icon-pop`, `onboard-blob-orbit`, `onboard-in-forward`/`backward`) drive: backdrop fade, modal scale+translate entrance, icon pop with bezier overshoot, slow-orbiting accent blob behind the icon, directional slide-in between steps (right when going forward, left when going back). Direction is tracked via state so direct dot-clicks also feel coherent.
- **3 new onboarding steps** — AI assistant (with mini chat demo), Automations (with trigger → action flow diagram), Git-aware browsing (with branch + status badges demo). Step count went from 6 to 9.
- **7 mini visual demos** for the meaningful onboarding steps replacing the previous single-icon framing. Each demo is a small inline mockup (~300×140px) of the feature: workspaces pills, file-rows with tag chips, search input with highlighted snippet, AI chat bubble exchange, automation flow with chevrons between cards, git branch + status letters, two laptops connected by pulsing dots with a share code. Welcome and "All set" framing steps keep the plain icon — the icon IS the moment.
- **Keyboard navigation in onboarding** — `←` previous, `→` next, `Esc` close. Direction inferred from the navigation type so the slide animation always matches.
- **Per-step accent color theming** in onboarding — the active step's color (indigo/blue/amber/emerald/violet/pink/orange/cyan/fuchsia) is carried through icon glow, floating blob, current progress dot, and the primary CTA button. Gives each screen its own identity. Color classes are stored as string literals in a typed `ACCENTS` constant so Tailwind JIT picks them all up.
- **Inline highlights in onboarding body text** — `<kbd>` for keyboard shortcuts, `<b>` accent for key terms, `<code>` for example extensions. Breaks up the wall-of-text feel.

### Improved

- **Folder import speed (massive — typically 10-20×)** on large folders. A "Documents" with ~50k files that previously took 2-5 minutes now completes in 5-15 seconds. Three layered changes:
  - **Inline text extraction removed from `scan_directory`**. The old behavior extracted text for every file ≤ 200 KB during the walk — for a Documents folder full of small DOCX/XLSX, that meant minutes of unzip + XML parse. Now `walk_phase` is pure stat work; all content extraction is deferred to Phase 2 (`index_directory_content`). Small text/code files are searchable by content a few seconds later instead of immediately, but the folder is browsable in seconds instead of minutes.
  - **Prepared statements + `RETURNING id`** in the new `insert_batch` helper. The old loop did `db.execute(SQL, params)` for each insert (SQL re-parsed every time) plus a separate `SELECT id FROM files WHERE path = ?` after each upsert. Now four prepared statements (`insert_dir`, `insert_file`, `insert_file_tag`, `insert_activity`) are reused across the whole batch, and the upsert uses `ON CONFLICT DO UPDATE … RETURNING id` to skip the lookup entirely. Roughly halves the SQLite work per file.
  - **DB mutex released before the final SELECT**. The old code held the mutex through Phase 2's `load_files_with_tags`, blocking every other DB-bound command (list_directory, get_tags, badge polling, etc.) for the full duration. Now the lock is dropped right after COMMIT and re-acquired only for the final read. Other commands can sneak in between phases.
- **`scan_directory` refactored into `walk_phase` + `insert_batch` helpers**. `walk_phase` is a pure collection step ready for rayon parallelization later; `insert_batch` is idempotent (safe to call with chunks) so chunked commits are a trivial follow-up. Both are documented inline with the migration path noted.
- **Tag-id cache in `insert_batch`** — `ensure_auto_tag` is now called at most once per distinct auto-tag name per batch instead of once per file. Small wins (1-2 ms on a 50k folder) but cleaner code.
- **Search input responsiveness** — typing in the global search bar no longer triggers a global store update per keystroke. Local React state (`searchInput`) is bound to the input; the global `searchQuery` updates 250 ms after the user stops typing, wrapped in `React.startTransition` so heavy result renders (FileList, Sidebar) are treated as low-priority and never block the next keystroke. The `runSearch` async callback also wraps its terminal `setListEntries` in `startTransition`. Side-effects of external changes (Escape → clear, navigateTo → reset) sync back to local via a `useEffect` watching `searchQuery`.
- **Bundle code-splitting** — `vite.config.ts` got a `manualChunks` function plus a bumped `chunkSizeWarningLimit` (500 → 1500). Heavy vendor libs each get their own chunk: `pdfjs` (457 KB), `codemirror` (733 KB), `docx` (174 KB), `xlsx` (333 KB), `markdown` (229 KB), `react-vendor` (143 KB). The critical-path main bundle dropped from **821 KB → 446 KB** (−46%, −117 KB gzipped). `DocumentViewer.js` dropped from 1 MB → 33 KB (opening a PDF no longer drags in docx-preview). Vendor chunks stay cached across releases when their deps don't change. No more "chunks larger than 500 kB" warning at build time.
- **GitHub Actions release workflow** is more robust and trigger-from-anywhere safe:
  - `workflow_dispatch` correctly checks out the **tagged commit** instead of the branch HEAD. Previously, manually re-triggering for tag `v0.1.10` from `main` would silently build whatever was at main's HEAD, not the tag — confusing and footgun-y.
  - Release notes are extracted from the matching `CHANGELOG.md` section (regex match on `## [VERSION]` header) instead of dumping the entire changelog into the GitHub release body. Falls back to the full file if no matching section is found.
  - New `Resolve tag` step centralizes tag/version/prerelease derivation so the rest of the workflow doesn't keep coalescing `inputs.tag_name || github.ref_name` in three different places.
  - New `Job summary` step writes a clean recap (artifact sizes + prerelease badge + trigger source) to `$GITHUB_STEP_SUMMARY` for quick at-a-glance verification in the Actions tab.
  - Stricter artifact collection: explicit error if MSI/NSIS installers are missing from the bundle output instead of silently failing later with an obscure `softprops/action-gh-release` error.

### Fixed

- **Onboarding modal — dynamically-composed Tailwind classes** like `"hover:" + accent.text.replace("text-", "bg-")` were missing from the production CSS bundle because Tailwind's JIT scanner only picks up literal class strings at build time. Switched to a typed `ACCENTS` constant where every color variant is hard-coded as a string literal. All 9 step colors (icon text, icon bg, blob glow, dot, button + hover state) are now guaranteed in the final CSS.
- **Cargo.lock version sync** — workflows that read the version from Cargo.lock would have seen 0.1.10 even with `Cargo.toml` bumped to 0.1.11 if `cargo` wasn't re-run before commit. Bumping all four files (package.json, Cargo.toml, tauri.conf.json, Cargo.lock) is now part of the release checklist documented in CLAUDE.md section 33.

### Internal

- `RawFile` struct dropped its `text_content` field. Text content lives exclusively in `file_content` rows written by Phase 2 (`index_directory_content`) or the watcher (`handle_fs_event`). One source of truth for "has this file been content-attempted".
- New `SCAN_PROGRESS_INTERVAL` and `MAX_FILES_PER_SCAN` constants in `commands/files.rs` replace the magic `500` and `100_000` locals.
- The new global keydown listener in `OnboardingModal` for `←`/`→`/`Esc` is added/removed with the modal mount lifecycle, no leak.

## [0.1.10] - 2026-06-08

### Added

- **Side-by-side file comparison** (`diff_files` Tauri command + `DiffCompareModal`). Right-click two selected files → *Compare files*. The modal renders a 4-column layout (left line number, left content, right line number, right content) with hunks separated by unified-diff style `@@ -X / +Y @@` headers. Four row kinds with distinct backgrounds: `equal` (neutral), `delete` (red on left + muted on right), `insert` (muted on left + green on right), `modify` (red+green with intra-line char highlights). 20 MB per-file cap.
- **PDF Ctrl+F (find in document)** in `PdfViewer`. Routed through the new `useViewerFindStore` so the global Ctrl+F handler dispatches to the active viewer instead of always focusing the global search bar. Find bar lives in the PDF controls strip: input + result counter (`N/M`), prev/next chevrons, Escape to dismiss. Markers wrap matched characters inline using pdfjs's text-layer DOM (`<mark>` injected in the matching textDivs) so positioning inherits pdfjs's scale/transform — no coordinate math, no drift relative to the canvas underneath. Active match gets a stronger orange tint, inactive matches are subtle amber. Highlights persist across page renders triggered by zoom or scroll. Side benefit: PDF text is now natively selectable (drag-select + Ctrl+C work because the text layer is now properly styled with pdfjs's canonical CSS).
- **Inline char-level diff markers within `modify` rows** — when two lines differ by a few characters, only those characters get highlighted (red `<del>`-style on the left, green `<ins>`-style on the right) instead of painting the whole line red/green. Implemented via the new `inline_char_markers(a, b)` helper. Two algorithms inside it:
  - **Fast path** for same-length strings: position-by-position scan with run coalescing. Guaranteed-aligned highlights at the exact same column on both sides — solves the "Myers puts the insert 3 columns to the right of the delete" misalignment.
  - **Slow path** for different-length strings: `similar::TextDiff::from_chars` with a *Del-Equal-Ins → Del-Ins-Equal* alignment swap so the deletion and insertion render at the same visual column instead of having an "equal" sandwich between them. Reconstruction-tested: stripping markers must always recover the originals.
- **Multi-region diff navigation** — header shows the current diff position (`1/4`), per-kind line counters (`+X / −Y / ~Z`), and four navigation buttons:
  - `ChevronsUp` / `ChevronsDown` jump to the first / last change (also bound to `Home` / `End`).
  - `ChevronUp` / `ChevronDown` jump to the previous / next change (also bound to `Shift+F3` / `F3`, matching browser convention).
  - The active diff group is washed with `bg-accent/20` so a multi-line modification block reads as a single highlighted unit.
- **Hunk navigation operates on diff GROUPS, not raw rows** — a group is a maximal run of consecutive non-equal rows. Matches the convention used by VSCode / Notepad++ Compare / IntelliJ: a contiguous block of N edited lines counts as one navigable change. The data-diff attribute is placed on the FIRST row of each group; `goToDiff(N)` queries the DOM by attribute and scrolls only the modal body (manual offset math vs. `scrollIntoView` to prevent any chance of bubbling up to the window scroll).
- **Expand / collapse context around hunks** — every hunk separator now carries a `+10` button that fetches 10 more lines of equal context via the new `get_text_lines(path, start_line, count)` Tauri command (capped at 200 lines per call, with the frontend chunking larger requests). When the gap has more than 10 hidden lines, a secondary `all (N)` button reveals everything at once. **Shift-click** the `+10` button has the same effect as `all`. Once any context is revealed, a `−N` button appears on the same separator to fold the expansion back. Leading edge (before the first hunk) and trailing edge (after the last hunk) get their own separators so the user can reach the file's true start and end — `total_lines` is now part of `DiffResult` so the frontend knows where the trailing gap ends.
- **Text selection in the diff modal** — content cells now opt in to `select-text` + `cursor: text`. Previously the global `user-select: none` (set on `html/body/#root` for native-app feel) prevented any selection inside the modal. Line-number cells stay `select-none` so `Ctrl+A` / `Ctrl+C` ignore them — same convention as VSCode and GitHub.
- **Whitespace markers within char-level diffs** — when a marker span contains spaces or tabs (e.g. only trailing whitespace was added / removed), the whitespace renders as visible glyphs (`·` for space, `→` for tab) at 50% opacity. Outside markers, whitespace stays invisible so unchanged spaces don't add noise.

### Improved

- **PUA-codepoint markers replace HTML-shaped `<del>` / `<ins>` tags**. The frontend used to parse intra-line markers with a regex over literal `<del>...</del>` / `<ins>...</ins>` strings. Comparing two `.html` or `.xml` files where the actual content contained those tags broke the rendering — the source content collided with the marker syntax. Markers now use Private Use Area codepoints (U+E000..U+E003) which cannot appear in regular text files. The frontend parser uses a manual `indexOf` walk instead of a regex, with a defensive "open without close → render plain text" fallback so the PUA glyphs can never leak to the DOM.
- **Line-ending normalization in `diff_files`** — CRLF vs LF differences are now treated as not-a-diff for content comparison purposes (matches Git's `core.autocrlf` and VSCode's diff editor). Previously, comparing a Windows file (CRLF) with a Unix file (LF) made `similar::TextDiff::from_lines` see ZERO equal lines, collapsing the whole document into one Delete-all + Insert-all hunk. Now both texts get `\r\n` → `\n` and lone `\r` → `\n` before diffing.
- **Equal-length fast path with adversarial race against `similar`** — when both files have the same line count, the backend runs a naïve line-by-line walk AND `similar::TextDiff::from_lines`, then picks whichever produced fewer non-equal rows. Wins both cases:
  - "Edit a few lines in place" → naïve walk produces N modify rows (correct), similar might place displaced inserts and deletes in different hunks. Naïve wins.
  - "Refactor adding 5 lines and removing 5 lines (balanced length)" → naïve walk would mark dozens of contiguous lines as modified due to alignment drift. Similar finds the real insert/delete pairs. Similar wins.
- **Hunk separator becomes a unified `GapControls` cluster** — the same expand / collapse cluster is used between hunks AND at the leading / trailing edges. Single source of truth for the UX, plus an `EdgeSeparator` variant that drops the `@@ -X / +Y @@` header (which has no meaning at file edges).
- **PDF text layer CSS now matches pdfjs's canonical contract** — exposed `--total-scale-factor` inline per-page and copied the `font-size: calc(var(--text-scale-factor) * var(--font-height))` + `transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))` rules from pdfjs's `pdf_viewer.css`. Without these the invisible text layer rendered at the browser default 16 px with no horizontal scaling, so `Range.getClientRects()` (used for find highlights) returned pixel rectangles offset by tens of pixels relative to the canvas underneath. Side effects: native PDF text selection and Ctrl+C also start working correctly.
- **Stale-closure fix in `PdfViewer.renderPage`** — `renderPage` is a `useCallback([])` that intentionally never re-creates; previously it read `findHits` / `activeHit` from state, so when a new page scrolled into view during an active search it saw the initial `null` / `0` and skipped applying highlights. Now reads `findHitsRef.current` / `activeHitRef.current` — refs are stable across renders and always reflect the latest committed state, so pages rendered mid-search get their highlights immediately.
- **Modal scroll fix** — the modal body now has `min-h-0` in addition to `flex-1 overflow-auto`. Without `min-h-0`, the flex item's default `min-height: auto` made the body grow to its content size instead of respecting the parent's `max-h-[92vh]`, so `overflow-auto` never engaged and the modal grew off-screen. Surfaced when expanding context made the diff long enough to exceed the viewport.

### Fixed

- **PDF find highlights landing on the wrong word** — the textDivs inside `<span class="markedContent">` containers weren't getting `position: absolute` because the previous CSS used a child selector (`> span`) that didn't reach nested spans. With `display: contents` on `.markedContent` and a descendant selector on the textDivs, nested and direct textDivs both get the correct positioning. Plus the canonical font-size / transform rules above ensure `Range.getClientRects()` matches the canvas.
- **Diff comparison undercounted hunks** — when `similar`'s alignment chose to "displace" a single-line change into a bare Insert with no paired Delete (compensated by extra Deletes in a later hunk to balance line counts), the local hunk read as "a whole new line was added next to an unchanged one" instead of a Modify. The equal-length fast path bypasses similar entirely for the common case; the slow path still uses similar but is documented and tested for the edge.
- **GitPanel's `renderInlineMarkers` left intentionally unchanged** — it parses `<del>` / `<ins>` from git-diff output, but the only call site keeps `inlineMarkers: false` (default). Dead-code parser, so the PUA migration on the diff side doesn't affect it.

### Testing

- **48 → 58 Rust unit tests**. New `diff_tests` module covers `inline_char_markers`:
  - Single-char swap aligns markers at the same column on both sides
  - Pure insert / pure delete keep their positions
  - Multi-char contiguous changes coalesce into one marker span
  - Position-by-position alignment for same-length strings with multiple changes
  - Multi-byte (é / è) unicode characters stay intact through the position-aware diff
  - **HTML-like content (`a<del>x</del>b` vs `a<del>y</del>b`) doesn't collide with the PUA markers** — the canary that justified switching marker delimiters
  - Reconstruction test: stripping markers always recovers the originals

## [0.1.9] - 2026-06-01

### Added

- **Git integration (V1, read-only, opt-in)** — when browsing a folder inside a git repository, nxs surfaces git context inline. Read-only by design: no commit / push / pull, only checkout (the one navigation-only write op). Toggle in Settings → Git so non-dev users pay zero runtime cost.
  - **Detection** with LRU cache (64 entries, positive AND negative) via `Repository::discover` — handles `.git` files for worktrees and submodules. Negative caching is what keeps the integration cheap for the 99% of folders that aren't repos.
  - **Per-file status badges** in the FileList: 6 px colored dot (modified = amber, added = emerald, deleted = red, renamed = blue, untracked = sky, ignored = muted, conflicted = pink). Palette matches VSCode SCM gutter so the legend is already familiar.
  - **`.gitignored` files dimmed** to 50% opacity (toggle-able in Settings).
  - **Sidebar `GitPanel`** with collapsible sections: current branch + ahead/behind, changed files (each row expandable to its inline diff), local branches list, recent commits. Cap total height at 45 vh with sticky header + scrollable body region — a repo with 100 changed files no longer pushes the bottom Sidebar sections off-screen.
  - **Diff viewer** built in: simple colored unified-diff `<pre>` rendering (no `@codemirror/merge` dep — saves bundle for V1). Per-diff height cap at 300 px with internal scroll so a single giant diff can't dominate the panel.
  - **Per-file Git tab in `PreviewPanel`** — alongside the existing Info / History tabs. Shows status, diff vs HEAD, and a per-file commit history (last 20 commits that touched THIS file, each expandable to see what changed in this file in that commit). Hidden in the tab bar when git is disabled or the file isn't inside a repo.
  - **Branch checkout** — click any local branch → `window.confirm` → `git_checkout_branch` runs in libgit2 `safe()` mode. Refuses to switch when uncommitted changes would conflict (no `force()` exposed, ever — protecting the user's working tree is non-negotiable). Surface clear errors and toast on success/failure. After success, refresh git state + reload the current folder so the file list reflects the new branch immediately.
  - **GitPanel collapsible** via a chevron in the header — folded state shows only the branch line + ahead/behind, freeing screen real estate without unmounting.
  - **Bundles `git2 = "0.19"` with vendored libgit2** so we don't depend on system git being installed. Adds ~3 MB to the binary whether the feature is enabled or not (Rust deps are linked at build time, no way around it) — disclosed transparently in Settings.
- **Quick Look (Space bar) expanded coverage** — previously only image / video / audio / text. Now also:
  - **PDF** via the WebView2 native `<embed type="application/pdf">` viewer. Zero JS lib loaded for the QuickLook path — pdfjs (~990 KB) only kicks in when the user opens the PDF in the full viewer.
  - **DOCX / ODT / XLSX / ODS / PPTX / ODP** via the existing `preview_file` Tauri command — shows the extracted plain text (up to 3000 chars). Same UX as the existing TEXT branch: instant peek, double-click for the full styled viewer.
  - **IPYNB** with cell-typed rendering — markdown cells and code cells get distinct backgrounds + an uppercase cell-type label and execution count for code cells. Outputs are intentionally not rendered (notebooks with base64 images can be tens of MB; staying lean keeps Space-bar peek sub-100 ms). Hard cap at 2 MB to avoid `JSON.parse` blocking the UI on huge notebooks.
- **Automation conditions: AND / OR combinator** — new `condition_logic` field on each rule (default `and`, preserves identical behavior for existing rules). Segmented `ALL / ANY` toggle in the rule editor with a "(any)" hint in the summary when relevant. `evaluate_conditions(conds, logic, ctx)` is a pure function — empty list ALWAYS matches regardless of logic (vacuously-false OR would be too easy to trigger accidentally).
- **Resizable Sidebar** with drag handle on its right edge (4 px column, hover-accent affordance). Width is persisted to `localStorage` across sessions (`nxs.sidebarWidth`), unlike the PreviewPanel which stays ephemeral. **Double-click the handle to reset** to the default 210 px and clear the saved value. Range 200–480 px.
- **Per-file Git history backend** — new `git_get_file_history(repo_root, path, n)` Tauri command. Revwalk from HEAD, filters to commits that actually touched the file (via pathspec + delta-foreach to confirm), formats per-commit diff for the file. Bounded traversal at 1000 commits with cap on returned entries at 50.

### Improved

- **Shared `useResizable` hook** in `src/utils/useResizable.ts` — extracted from PreviewPanel, extended with `side: "left" | "right"`, optional `storageKey` for persistence, and a `reset()` callback for the double-click-to-restore-default pattern. Sidebar and PreviewPanel both consume it now — single source of truth for drag-resize behavior.
- **Toast `action` field** — `Toast.action: { label, onClick }` for inline CTAs (used by the rate-limit warning's "Open Automations" jump-to-panel button). Click runs the handler and auto-dismisses.
- **Toast `detail` wraps to 3 lines** instead of single-line truncate — long explanations like the git rate-limit warning are now readable in full; short details still render on one line, no regression.
- **GitPanel visual polish** — dropped the per-row `border-b` between commits and changed-files (the harsh white rails in dark mode), replaced section dividers with `border-border-subtle/25` + a faint `bg-surface-2/30` tint on section headers. The whole panel reads quieter, closer to the VSCode Source Control look.
- **`AutomationsModal` open state lifted to `useStore`** — matches the existing `shareModalOpen` pattern. Lets the rate-limit toast's "Open Automations" CTA open the modal from outside the Sidebar.

### Fixed

- **`watch_directory` regression with multi-folder workspaces** — previously the watcher was REPLACED on every call to `watch_directory`, silently dropping prior watches. A workspace with N watched folders only received events for the LAST one added — auto-tag-on-create, live tag refresh, content reindexing on modify were all broken for every other folder. Now accumulates paths into a single shared `RecommendedWatcher`. Fix actually landed alongside automation in v0.1.8 but is worth re-flagging here because it silently affected anyone with more than one folder per workspace.
- **"Open with nxs" Windows context menu now actually opens files** — previously the registry entry navigated to the parent folder for files too, which was useful for "Reveal" semantics but not for "Open". Split into TWO verbs: `nxs` → **"Reveal in nxs"** (navigate to parent, current behavior preserved) and `nxsOpen` → **"Open with nxs"** (actually opens the file in the viewer via the new `--open` argv flag). Folders keep the single entry. `LaunchPath` now carries `intent: "open" | "reveal"` so the frontend can branch. `self_heal_registration` detects the missing `nxsOpen` verb on upgrade and writes it silently — existing users see both entries appear after their first launch on v0.1.9 without touching Settings.
- **Indexing badge invisible after adding a first folder to a workspace** — the badge mounted before `scan_directory` populated the `files` table, so `get_indexing_stats` returned `[0, 0]` and the badge self-hid. Subsequent `content-indexed` events were matched by `total` which stayed 0 forever, so the badge stayed invisible until you switched workspaces and came back. Now `handleAddFolder` re-seeds the badge state after the scan resolves — badge appears immediately.
- **Quick Look arrow-key navigation only moved one step** — `curIdx` was derived from `entry.path` (the prop the modal opened with, immutable for the modal's lifetime), so every ArrowRight repeatedly landed on the same `siblings[entry.idx + 1]`. Now derived from `current.path` (the displayed file), which updates with each navigation.

### Performance

- **Negative-cached git detection** — the LRU stores both "this path IS in a repo at X" and "this path is NOT in a repo". The negative entries are what make navigation in non-git folders zero-cost after the first probe. Without them, every directory change would walk up the filesystem looking for `.git`.
- **Stale-response guard in `useGitStore.refresh`** — records `currentPath = path` before the first invoke and discards the response if `currentPath` changed mid-flight. Stops slow status queries for repo A from flashing data into the panel when the user has already navigated to repo B.
- **`statusByPath: Map<rel, FileStatusEntry>`** is built once when status changes, so FileList does O(1) lookups per row instead of scanning the changed_files array on every render.

### Testing

- **48 Rust unit tests** total (up from 36 in v0.1.8 — git module adds 7 + automation AND/OR adds 5):
  - Git: detection cache LRU eviction, negative caching semantics, path normalization, status flag mapping (conflict-dominates, ignored, staged, clean-returns-none)
  - Automation: empty-conditions-always-matches (regardless of logic), AND requires-all, OR requires-any, single-condition acts identically under either mode, `ConditionLogic` defaults to `And`

## [0.1.8] - 2026-05-31

### Added

- **Automation rules** — nxs can now act on the filesystem in response to events or on demand. A full new subsystem with four phases shipping in one release:
  - **Typed rule model.** Each rule has a trigger (`file_created` / `file_modified` / `file_renamed` / `manual`), an optional scope path, a list of AND'd conditions, and an ordered list of actions. Persisted in a new `automation_rules` table with conditions and actions as JSON arrays; no DB migration required to add new variants.
  - **9 condition kinds**: `ext`, `name_contains`, `name_starts_with`, `name_regex`, `path_contains`, `size_gt`, `size_lt`, `age_gt_days`, `tag_has`. Regex uses `regex-lite` (no PCRE features, fast cold start).
  - **7 action kinds**: `move_to`, `copy_to`, `rename`, `add_tag`, `remove_tag`, `trash`, `notify`. Move falls back to copy + remove on cross-volume hops. Trash uses the existing `trash_items` table — soft delete only, never `delete_path`.
  - **Template engine** with `{year}`, `{month}`, `{day}`, `{hour}`, `{minute}`, `{date}` (= YYYY-MM-DD), `{name}`, `{ext}`. Unknown tokens are left literal — typo-friendly. Date math via Howard Hinnant's algorithm; no `chrono` dependency.
  - **Manual run** with target folder + optional recursive walk (max depth 8, hard cap at 10 000 files, same skip list as `scan_directory`: `.git`, `node_modules`, `target`, `__pycache__`, etc.). Dry-run preview returns a per-file diff before applying.
  - **Watcher dispatch.** Every filesystem event from the existing `notify::RecommendedWatcher` is forwarded to `automation::dispatch_event` via `std::thread::spawn` so the notify callback never blocks on rule evaluation.
  - **Per-rule rate limiting** — 10 firings per 60 seconds per rule. Beyond that, the rule is auto-disabled and a toast notifies the user with an "Open Automations" CTA to jump straight to the panel and re-enable when ready.
  - **Cycle detection** — every engine-touched path is registered for 5 s; subsequent watcher events on those paths are suppressed. Kills the self-trigger loop where a rule's own output would re-fire the rule.
  - **UI** — full modal with three views (list / editor / run). Editor is a visual builder with dropdown-selected condition and action kinds, no free-form code. Per-row drag handles let you reorder actions (order matters: `move` then `rename` ≠ `rename` then `move`).
- **Preset library** — 5 ready-to-use templates surface as the empty-state gallery and behind a "Templates" button when rules exist. Picking a preset prefills the editor in the user's language, ready to tweak and save:
  - *Tag PDFs as Documents* — adds the "Documents" tag to every PDF in a folder (manual run, zero config).
  - *Tag images as Photos* — single regex covers jpg/jpeg/png/webp/heic.
  - *Archive screenshots older than 30 days* — `name_starts_with=Screenshot` + `age_gt_days=30` → trash.
  - *Organize new PDFs by year* — file-created watcher → `move_to C:\Archive\{year}`, demonstrates template tokens.
  - *Clean .tmp files older than 7 days* — combined extension + age condition.
- **Per-rule diagnostics** — three new columns on `automation_rules`: `last_fired_at`, `fire_count`, `last_error`. Updated whenever a rule actually does work (dry runs don't count, no-match firings don't count). Shown in the rule list as *"fired 12× · last 5m ago"* with an automatic *"⚠ last error"* badge that clears itself on the next fully-successful run. Closes the "is my rule even firing?" feedback loop that V1 was missing.
- **Drag-to-reorder action handles** — HTML5 native DnD with a visual drop indicator (2 px accent line above or below the target row) and dimmed source row. Action order is semantic so this matters: move-then-tag is different from tag-then-move.
- **Toast action button** — `ToastAction { label, onClick }` optional field on `Toast`. Renders as a button under the detail line; clicking runs the action and auto-dismisses. First user is the rate-limit warning's "Open Automations" shortcut.
- **`AutomationsModal` open state lifted to `useStore`** — matches the existing `shareModalOpen` pattern. Lets external triggers (toast CTA, future AI tool calls) open the modal without going through the Sidebar's local state.

### Improved

- **Toast `detail` field now wraps to 3 lines** (was: single-line truncate) via `line-clamp-3`. Long explanations like the rate-limit warning are readable in full; short details still fit on one line, no visual regression.
- **`AutomationRule` JSON serialization is forward-compatible** — `last_fired_at`, `fire_count`, `last_error` carry `#[serde(default)]` so a rule deserialized from an older DB shape doesn't reject the row.
- **~110 new i18n strings** covering the entire automation surface (rule names, conditions, actions, triggers, presets, run-now panel, diagnostics, toast). Full FR + EN parity.

### Fixed

- **Multi-folder workspaces only watched their last added folder** — `watch_directory` previously created a fresh `RecommendedWatcher` on every call and overwrote the static `Mutex<Option<...>>`, silently dropping the previous watcher and stopping its watches. A workspace with N watched folders only observed events for the last one added: auto-tag-on-create, content reindexing on modify, and tag preservation on watcher refresh were all broken for every folder except the latest. The watcher now accumulates paths into a single shared instance, calling `.watch(path)` for each new one. Fix landed alongside automation because every rule depends on receiving events, but the regression had been silently affecting the file manager for any user with more than one folder per workspace.

### Performance

- **No regression on cold path**. The diagnostics write is a single `UPDATE` inside the existing DB lock window of `dispatch_event` — no extra acquisitions, no extra round-trips. The new `idx_automation_enabled_trigger` index makes the per-event rule lookup O(log N).
- **Rate limiter and cycle detection use lazy eviction** — old timestamps are pruned only when a relevant rule is checked, not on a timer thread. Zero ambient work when no automation events are flowing.

### Testing

- **36 unit tests on the automation engine** (up from 0 before this release). All pure-function over in-memory state, no Tauri runtime or live DB needed:
  - Template engine (5 cases, including `{date}` / `{day}` substitution-order safety)
  - Condition evaluator (9 cases, one per Condition variant + regex sad-path)
  - Date and time helpers (`unix_to_ymd`, `unix_to_hm`)
  - Path helpers (`unique_path_returns_original_when_free`, `describe_action_resolves_templates`, recursive walker with `.git` skip-list)
  - Rate limiter (under cap, cap-trip, window pruning, per-rule isolation)
  - Cycle detection (within-TTL, unknown path)
  - Trigger-path matching (empty / inside / outside / case-insensitive)
  - `trigger_kind_from_action` mapping
  - `compute_diagnostics_update` (dry-run skip, no-match skip, success clears last_error, partial failure records first error, all-fail still fires)

## [0.1.7] - 2026-05-29

### Added

- **Streaming AI responses** — tokens stream live into the assistant bubble as the model generates them, for both Anthropic and Ollama. The Stop button now aborts the underlying `fetch` (`AbortController`) in addition to the loop, so cancellation is truly instant. Tool calls still execute in the existing agent loop at end-of-stream — no breaking change to the tool flow.
- **Custom AI instructions** — Settings → AI → "Custom instructions" lets the user write persistent personal rules (working language, naming conventions, organization preferences). Appended to every system prompt under a dedicated section so the model always follows them.
- **Composite AI tools** — three new high-level tools, each replacing what used to require dozens of atomic calls and a long agent chain:
  - **`tag_files_matching(dir, pattern?, extension?, tag_name)`** — tag every file in a tree by name substring or extension in a single call. Creates the tag if it doesn't exist. Capped at 500 tagged files for safety.
  - **`find_duplicates(dir)`** — reports groups of files sharing the same name + size (fast, no hashing). Catches the common case of copies across folders. Top 50 groups by size.
  - **`find_unused(dir, days)`** — lists files in a tree that have no recorded activity (open/modify/etc.) in the last N days. Useful for cleanup suggestions.
- **Post-action verification** — `create_file`, `create_dir`, `write_file`, and `rename_path` now re-check the filesystem after the action and prepend `✓ Verified —` (or a clear failure message) to the tool result. Hard-kills the class of small-model hallucinations where the AI claims success without acting.
- **Per-file progress events during indexing** — the backend now emits two `content-indexed` events per file (one before the extraction, one after the DB write). The badge popover updates `Processed` / `Remaining` counters in real time as each file completes, instead of waiting for batches.
- **AI memory cap** — the system prompt now injects only the 30 most recent memories (older ones stay in the DB but don't bloat the context window). New backend command `count_ai_memories` for future UI showing total saved.

### Improved

- **Indexing event payloads now use folder-global counters** — `indexed` / `total` in `content-indexed` events match what `get_indexing_stats` returns from the DB, so frontend filters work correctly across simultaneous indexing of multiple workspace folders.
- **Indexing popover positioning** — rendered via React portal at `document.body` with `position: fixed` clamped to the viewport. No longer clipped by the sidebar's `overflow-hidden`. The badge button stays clickable while indexing runs, so the popover can be reopened to monitor progress.
- **Text selection in info panels** — `PreviewPanel` and `AiPanel` opt into `user-select: text` so file paths, metadata, and AI responses can be copied. The rest of the app keeps the `user-select: none` "native app" feel.
- **`summarize_folder` tool** — categorizes a folder's contents (PDFs, Images, Code, Spreadsheets, etc.) with extension hints and per-category total size. The AI calls this on "what's in this folder?" questions instead of dumping a raw `list_directory` output.
- **`get_indexing_stats` is now async + spawn_blocking** — DB queries during indexing no longer pin the tokio runtime, so badge refreshes don't compete with the indexer for the DB mutex.

### Performance

- **SQLite startup pragmas** — at every connection open: `PRAGMA wal_checkpoint(TRUNCATE)` reclaims WAL space from the previous session, then `synchronous=NORMAL` (durable enough with WAL, much faster bulk writes), `temp_store=MEMORY` (temp tables in RAM), and `mmap_size=256MB` (memory-map up to 256 MB of the DB for read-only queries). Net result: faster cold queries, smaller `.db-wal`, less fsync pressure during indexing.
- **New composite SQLite indexes** — `idx_file_tags_file_ctx` on `(file_id, context_id)`, `idx_folder_tags_path_ctx` on `(folder_path, context_id)`, `idx_activity_file_ts` on `(file_id, timestamp DESC)`, plus a partial index `idx_file_content_attempted` on non-empty rows. The tag-aware JOINs in `list_directory` and `load_files_with_tags` are 3-5× faster on large workspaces.
- **Lazy-loaded file viewers** — `DocumentViewer` (pdfjs ~2 MB), `EditorView` (CodeMirror packs), `MediaViewer`, and `ArchiveViewer` are now imported via `React.lazy` + `Suspense`. The initial JS bundle drops by several MB; the viewer chunk is fetched only when the user actually opens a file of the matching type. Visible startup time improvement.
- **Batched DB writes in the content indexer** — extracted text is buffered in groups of 20 files and flushed in a single `BEGIN`/`COMMIT` transaction. Collapses 20 mutex acquisitions + 20 implicit transactions into one — ~10× faster DB throughput on bulk indexing.
- **Global indexing-progress store** — one tauri event listener and one Zustand store (`useIndexingStore`) feed all sidebar badges via path-keyed selectors, instead of N badges each registering their own listener and re-querying `get_indexing_stats`. Drastically reduces tauri event dispatch and DB load when multiple workspace folders are active.
- **Folder-size LRU cache** — `get_folder_stats` and `get_folder_sizes` results are cached in-memory for 30 s (max 32 entries). Re-opening the preview panel for a previously-visited folder is instant instead of re-walking the tree. The file watcher invalidates cache entries for any path branch where a change is detected, so freshness is preserved.

### Fixed

- **"Rendered more hooks than during the previous render" crash** — the indexing badge component declared `useRef` / `useState` after an early-return path; all hooks are now unconditional.
- **Indexing counters stuck while file names cycled** — the event payload's `total` referred to the per-run queue size instead of the folder-global total, so the frontend filter rejected every update. Backend now emits global counters that match the badge's reference total.
- **Indexing percentage overshooting 100%** (e.g. 103%) — in force mode the queue includes files that already had a row (empty content) plus genuinely new files. The local `indexed` counter incremented for both, even though retried-empties don't change the DB's attempted count. The query now carries a `was_attempted` flag per row and the counter only increments for genuinely new attempts. A frontend `Math.min(indexed, total)` clamp provides a belt-and-braces safeguard.
- **Reindex popover closing on click** — `setOpen(false)` was called when launching the manual reindex, hiding the live progress immediately. The popover now stays open so the user can watch each file go by.
- **Stop button only flipped a flag** — the in-flight fetch kept running until the model finished generating. Now the `AbortController.abort()` is wired up too, so the network call dies the moment Stop is clicked.

### Fixed

- **"Rendered more hooks than during the previous render" crash** — the indexing badge component declared `useRef` / `useState` after an early-return path; all hooks are now unconditional.
- **Indexing counters stuck while file names cycled** — the event payload's `total` referred to the per-run queue size instead of the folder-global total, so the frontend filter rejected every update. Backend now emits global counters that match the badge's reference total.
- **Reindex popover closing on click** — `setOpen(false)` was called when launching the manual reindex, hiding the live progress immediately. The popover now stays open so the user can watch each file go by.
- **Stop button only flipped a flag** — the in-flight fetch kept running until the model finished generating. Now the `AbortController.abort()` is wired up too, so the network call dies the moment Stop is clicked.

### Developer

- **`commands/ai_ops.rs`** — new module hosting the composite AI tools. Kept separate from `tags.rs` / `files.rs` because these are AI-facing batch operations with their own semantics (best-effort across a tree, capped payloads, no per-call confirmation).
- **`AnthropicResp` SSE reassembly** — `callAnthropicStream` reads `content_block_start` / `delta` / `stop` events, reconstructs the same `AnthropicResp` shape at end of stream so the rest of the agent loop is unchanged. The non-streaming `callAnthropic` is kept as a fallback (not currently called but available).
- **`store/useIndexingStore.ts`** — new Zustand store with one global tauri listener, path-keyed progress map, and a `seedIndexingProgress(path, total, indexed)` helper for badges to publish their initial state. Pending events for unmounted badges are stashed under synthetic keys and migrated on first seed.
- **`utils/folderSizeCache.ts`** — small TTL + LRU cache module exporting `getCachedFolderStats` / `cacheFolderStats` / `getCachedFolderSizes` / `cacheFolderSizes` / `invalidateFolderCacheForPath`. The file watcher in `App.tsx` calls the invalidate helper on any `file-changed` event so the cache stays consistent.

### Added (workspace notes, AI extensions, spreadsheet improvements)

- **Workspace notes panel** — new toolbar button (sticky-note icon) opens a per-workspace panel split into two sections:
  - **Tasks** with checkbox, editable text, optional due date and time. Inline custom date/time pickers styled to match the app (no native browser UI). Auto-sort: not-done first, then by due date ascending; overdue tasks tinted red, due-today amber. Toolbar badge shows count of pending tasks per workspace.
  - **Free-form notes** textarea below the tasks for context, meeting notes, etc.
  - **Save semantics**: structural actions (toggle, add, delete, date change) save immediately; text typing is debounced 300 ms.
- **Custom DatePicker / TimePicker components** — replace the native browser pickers that didn't match the dark theme. Calendar grid with month navigation + "Today" / "Clear" shortcuts; time picker with hour/minute steppers, 5 quick presets (Morning, Noon, Afternoon, End-of-day, Evening), "Now" / "Clear". Both rendered via portal with viewport-clamped positioning.
- **Workspace-notes startup toast** — at app start, if any unchecked tasks for the active workspace have a due date that is overdue or today, a toast appears (warning for overdue, info for due-today) with up to 3 task titles. One toast per workspace per session via `sessionStorage`.
- **AI tools for workspace notes** — 9 new tools the AI can call:
  - Single-task: `add_task`, `toggle_task`, `delete_task`, `set_task_due`, `edit_task_text`
  - Multi-task: `bulk_task_action(action, scope)` — `action ∈ {done, undone, toggle, delete}`, `scope ∈ {all, undone, done, <substring>}`. Covers "coche les deux", "supprime tous les test", "mark all undone done", etc., in a single tool call.
  - Notes section: `set_workspace_notes_text`, `append_to_workspace_notes`
  - Read: `get_workspace_notes` (rarely needed because the current task list is auto-injected into every system prompt).
- **Relative date resolution in user messages** — before sending a message to the model, common date/time expressions are detected and appended as a `[Resolved: "demain" = 2026-05-31; "14h" = 14:00]` annotation. Covers French and English keywords (`aujourd'hui`/`today`, `demain`/`tomorrow`, `après-demain`, `semaine prochaine`/`next week`, `dans X jours`/`in X days`, weekday names with optional "prochain"/"next"), and times in `Xh`, `XhYY`, `HH:MM` formats. Dramatically improves small Ollama models' date accuracy.
- **Pre-computed date block in system prompt** — the prompt now starts with a `CURRENT DATE` block listing absolute values for Today, Tomorrow, Day after, In 7/30 days, Next Monday, Next Friday. The model is explicitly instructed to use these values verbatim instead of computing them.
- **Current workspace tasks inlined in the system prompt** — the model can act on them directly without an extra `get_workspace_notes` round-trip.
- **Text-based tool-call parser for Ollama** — `extractTextToolCalls(text)` runs as a fallback when the structured `tool_calls` array is empty in the response. Recognizes four common emission formats:
  - `<tool_call>{...}</tool_call>` (qwen2.5, Hermes)
  - Dangling `<tool_call>{...` without closing tag (stream cut mid-token)
  - `<|python_tag|>{...}<|end|>` (some Llama variants)
  - ```` ```tool_call\n{...}\n``` ```` (code-block wrapped)
  Tolerant to `arguments` / `parameters` / `args` synonyms. Cleans the rendered text of the matched tags so the user doesn't see them.
- **Spreadsheet viewer improvements** — major usability lift for CSV / XLSX:
  - **Header-row mode** (auto-on) replaces the `A B C` column letters with the first row's values as labels.
  - **Sortable columns**: click a header to sort ascending → descending → off. Numeric mode auto-detected when every non-empty cell parses as a number; otherwise locale-aware string compare with `numeric: true` collation. Empty cells always go last regardless of direction.
  - **Global filter**: case-insensitive substring across all columns.
  - **Per-column filter row** (new): toggle via toolbar button, shows an inline input under each header. Filters AND together with the global filter. Sticky positioning keeps the row visible during scroll. Clear-all corner button when at least one column filter is active.
  - **Original row numbers preserved** in the leftmost column even when sorted or filtered.
  - **Edit mode unaffected**: sort/filter controls hidden in edit mode; saved file always reflects the original order with all rows.
  - **Status bar** shows filtered/total counts, active sort column with direction, and active column-filter count.
  - All viewer labels (`Edit`, `Save`, `Header`, `Filter`, `Sort`, status bar plurals…) routed through the i18n system. `fmtNum` now uses the active language locale instead of hardcoded `fr-FR`.

### Improved (AI quality)

- **Tool result phrasing rewritten** for the workspace-notes tools — every result starts with `SUCCESS:` / `FAILURE:` in caps and ends with an explicit instruction (e.g. *"Tell the user."*). Small Ollama models stop questioning their own actions and stop asking the user to confirm.
- **Failure hints** when `toggle_task` / `delete_task` / `set_task_due` find no match — the response lists the actually-available tasks, so the model can retry with the correct text in the next turn instead of giving up. `set_task_due` failure explicitly warns *"do NOT call add_task"* to prevent duplicate-creation bugs.
- **Date local time** — system prompt date block now uses local-date components instead of `toISOString()`, fixing off-by-one errors near midnight in non-UTC timezones.
- **`AppSettings.aiInstructions`** consumed by the prompt builder — custom instructions appear under a dedicated section in every system prompt.

### Fixed

- **AI inventing dates from training data** (e.g. *"September 26, 2023"* when asked for "tomorrow") — combination of stronger system-prompt language, pre-computed date table, and inline message resolution.
- **AI requesting task ids unnecessarily** — the live CURRENT TASKS section in the prompt plus tightened rules ("Don't ask for ids") stops the model from asking the user to identify a task that's already visible.
- **Bulk task operations confusing the model** — adding the dedicated `bulk_task_action` tool means "check both" / "delete all the test ones" resolve in a single call instead of multiple `toggle_task` round-trips.
- **Tool calls emitted as raw text by Ollama models** (e.g. `<tool_call>{"name":"…"}</tool_call>` shown verbatim instead of executed) — caught by the new fallback parser and routed to the executor.
- **`SpreadsheetViewer` had hard-coded French strings** — all replaced via the i18n table, with new `sheet*` keys covering both FR and EN.

### Developer

- **`commands/notes.rs`** — minimal Rust commands for per-workspace notes: `get_workspace_note(context_id)`, `save_workspace_note(context_id, content)`. Content is a TEXT blob; the frontend stores JSON (`{ tasks, notes }`) and the backend doesn't introspect it. Migration tolerates pre-existing raw markdown content (placed in `notes`, `tasks` empty).
- **`workspace_notes` table** added in `db.rs` (idempotent), keyed by `context_id` (PK), with `content` and `updated_at`.
- **`NotesPanel.tsx`** holds the typed `NotesState = { tasks, notes }` shape; tasks use random short ids. Live updates from the AI dispatch a `notes-updated` CustomEvent on `window` so the panel, the toolbar badge, and the AI's own prompt context refresh without polling.
- **`DatePicker.tsx` / `TimePicker.tsx`** — self-contained popovers using `createPortal`. No external date library; computed in-component.
- **`resolveRelativeDatesInMessage(text)`** in `AiPanel.tsx` — patterns kept terse (regex per keyword), case-insensitive, with a fallback path for "next <weekday>" and a generic "dans X jours / in X days". Easy to extend with new languages or expressions.

### Windows shell integration — robustness fixes

- **Single-instance mode** via `tauri-plugin-single-instance`. Right-clicking "Open with nxs" while nxs is already running no longer spawns a second window. The existing window pops to the foreground and navigates to the new path. The duplicate process exits cleanly without ever opening a window. Plugin must remain the FIRST `.plugin(...)` call in the Tauri builder for the detection to work.
- **Reliable file vs directory detection** — `get_launch_path` now returns `{ path, is_dir }` and computes `is_dir` via `fs::metadata` instead of the string heuristic (`!path.includes(".")`). The old heuristic broke on dotted folder names (`my.docs`) and extension-less files (`Makefile`, `LICENSE`).
- **`SHChangeNotify(SHCNE_ASSOCCHANGED)`** is called after registering or unregistering the shell extension. Windows usually picks up the registry change on its own, but several long-running Explorer scenarios benefit from an explicit notification. Cheap and harmless. Requires the `Win32_UI_Shell` feature on the `windows` crate (added to `Cargo.toml`).
- **Self-healing exe path** — at startup, if the user previously opted in to shell integration, the backend silently compares the exe path stored in the registry to `current_exe()` and re-registers if they differ. Means an app update relocating the binary no longer leaves the context menu pointing at a stale path; the user doesn't have to revisit Settings. Runs in a background thread so it never delays the splash.

### Developer (shell integration)

- **`commands/winintegration.rs`** now exposes `parse_launch_path_from_args(args)` and `classify_launch_path(path)` as public helpers. Reused by `lib.rs` in the single-instance callback so the second-launch path follows the same parsing as the initial `get_launch_path`.
- **`shell-launch` Tauri event** — emitted from the single-instance callback with the same `{ path: string, is_dir: bool }` payload as the initial launch. `App.tsx` has a dedicated listener that navigates the existing window without creating a new view.

### Known limitations

- The streaming Ollama path requires Ollama ≥ 0.1.30 for `stream: true` with `tools`. Older versions silently ignore tool calls when streaming.
- `find_duplicates` matches by `(name, size)` only — files with the same content but renamed are not detected. Content-hash detection is on the roadmap.
- `FileList` is not yet virtualized — opening a directory with 2000+ entries feels slightly laggy on first paint and during scroll. Below ~500 visible entries it's invisible. Virtualization is on the roadmap.
- Workspace-notes notifications are in-app only (toast at startup, badge counter). OS-level reminders that fire when the app is closed are out of scope for V1.
- Spreadsheet sort is single-column only; multi-column sort and operator filters (`>`, `<`, ranges) are not supported.
- Relative-date resolution covers common French and English expressions only; expressions like *"fin juin"*, *"dans 2 mois et demi"*, or *"le 15 du mois prochain"* are not resolved and fall back to whatever the model can compute from the date block.
- Shell integration requires a one-time Explorer refresh on rare systems where `SHChangeNotify` is not enough — restart Explorer (Task Manager → Restart) if the context menu entry doesn't show up after toggling the setting.
- In dev mode (`npm run tauri dev`), enabling shell integration registers the path of the dev binary in `target/debug/`. Launching from the context menu starts a fresh standalone process, not a `tauri dev` session. Always test shell integration against a release build.

## [0.1.6] - 2026-05-29

### Added

- **AI Assistant overhaul** — Anthropic (Claude 4.5/4.6/4.7) and Ollama providers share the same 20+ tool set: search, navigate, read, write, create, rename, move, copy, tag, plan batch reorganizations. The system prompt detects the user's locale and forces same-language replies; explicit anti-hallucination rules prevent the model from inventing file names. Active workspace, tags, and selection are injected as live context on every turn.
- **`plan_moves` with confirmation flow** — when reorganizing a folder, the AI proposes a single batch plan (`fichier.pdf → dst_dir/`, with a "reason" per move). A popover shows the full list and the user approves or cancels before any file is moved. `dst_dir: "trash"` is a special value that safely routes to the recycle bin instead of deleting.
- **Persistent AI memory** — `remember(content)` saves notes across sessions (project context, naming conventions, user preferences). Memories are injected into every system prompt verbatim. A collapsible memory panel in the AI assistant lists all saved notes with one-click delete.
- **Content indexing for documents** — PDFs, DOCX, XLSX, PPTX, ODT, ODS, ODP, plus all text and code formats are extracted into a SQLite FTS5 index. `search_files` now matches both file names AND contents. PDF text is extracted via `pdf-extract` (with a panic-safe fallback for malformed files); Office formats are read directly from their underlying ZIP/XML.
- **Background indexing pipeline** — when a folder is added to a workspace, content extraction runs asynchronously on a 2-thread blocking pool with `BELOW_NORMAL` priority on Windows, so the UI stays responsive. Per-file 30-second timeout prevents a single bad PDF from stalling the queue. Each processed file is marked in the DB so it's never retried unless the user explicitly forces a re-scan.
- **Per-folder indexing badge** — each workspace folder in the sidebar shows a `XX%` badge indicating indexing progress. Click to open a popover with stats (`Processed: X / Y`, `Remaining: Z`), the file currently being processed, and a "Re-scan everything" button that retries previously skipped or failed files (with an extended 25 MB PDF cap in this manual mode).
- **`preview_file` tool** — the AI can request a content preview of any single file regardless of size. Result is cached in the FTS index, so the next `search_files` will find that file by content too.
- **Live filesystem fallback in `search_files`** — when the DB index has no match, the AI tool automatically tries a live disk walk on the home folder before reporting "not found".
- **`content-indexed` progress events** — the backend emits a Tauri event per file processed with the current filename; the sidebar badge updates live during indexing without polling.
- **`get_file_snippets(dir, offset, limit)`** — paginated content reader exposed to the AI for organizing large folders (50 files per page max).
- **`copy_path` AI tool** — non-destructive duplication into a destination directory.
- **Content indexing toggle** — Settings → Activity → "Content indexing" lets the user disable automatic content extraction. The file watcher always indexes new and modified files regardless of the toggle.

### Improved

- **File watcher debounced 300ms** — Word and other apps fire 8+ filesystem events when saving a single document; the watcher now coalesces bursts before reloading the directory.
- **`search_files` is now workspace-aware** — search results carry workspace-scoped tags, not just global ones.
- **`setListEntries` tag preservation** — defensive merge in the store: if a stale `list_directory` call returns entries with empty tags, the previous tags for those paths are kept. Acts as a safety net against `contextId=0` regressions.
- **PDF extraction is panic-safe** — `pdf-extract` panics on malformed PDFs (CMap parse errors, missing object references) are caught and silently logged; the indexer falls back to an ASCII heuristic.
- **Quieter console** — a custom panic hook filters output from `pdf-extract`, `lopdf`, `adobe-cmap-parser`, and `type1-encoding-parser` so the dev console isn't flooded during bulk indexing.

### Fixed

- **Tags disappearing when navigating with the mouse back/forward buttons** — the handler was calling `list_directory` with `contextId: 0` from a stale closure; now reads from a ref kept in sync with `activeContextId`.
- **Tags disappearing when adding a folder to a workspace** — `Sidebar::handleAddFolder` was calling `list_directory` without `contextId` in two places.
- **Tags missing after navigating via the disk-usage modal, command palette, and timeline view** — all three call sites now pass the active context id.
- **Tags missing in `search_files` results** — the backend query was hard-coded to `context_id = 0`; now accepts the workspace id and filters with `OR ft.context_id = 0`.
- **AI panel was confusing the current folder list with search results** — the listing was injected verbatim into the system prompt and the model returned items from it as if they were search hits. The prompt now ships only a compact summary (`5 folders, 23 files`) and the model must call `list_directory` to see details.
- **`write_file` triggered an unnecessary confirmation dialog** — it was incorrectly tagged as destructive even when creating new files.
- **AI invented `[id=27]` as a tag name** — the prompt and `get_tags` output now show tags as `name="Archives"` and an explicit rule forbids the ID notation.
- **Failed PDF extractions were retried on every relaunch** — files where extraction returned nothing are now marked in `file_content` and skipped unless the user clicks "Re-scan everything".

### Developer

- **`CLAUDE.md`** — 890-line internal codebase guide (gitignored). 31 sections cover the data model, every backend module, dual-pane mode, popup windows, the drag-and-drop system, the content indexing pipeline, AI architecture, common idioms, and step-by-step how-tos for the most frequent change types.

## [0.1.5] - 2026-05-28

### Added

- **Rubber-band selection** — click and drag on the empty area of the file list to draw a selection rectangle; all entries overlapping the rect are selected on pointer release.
- **External drag-and-drop** — drag files and folders from nxs to any external Windows app (File Explorer, browser, desktop, etc.). Uses `tauri-plugin-drag` under the hood: pointer capture keeps tracking the cursor even after it leaves the window, and the native OS drag kicks in the moment the pointer crosses the window boundary.
- **Windows shell integration** — "Open with nxs" entry now appears in the File Explorer right-click context menu for files, folders, and the folder background. Install/uninstall directly from **Settings → Explorer** with a single toggle (writes to HKCU — no admin required). Launching nxs with a `--path` argument or from the context menu navigates straight to that path.
- **Command palette: recent files** — when the query is empty the palette lists the 10 most recently navigated or opened files (sourced from the activity log), so you can jump back to anything without typing.
- **Command palette: recent searches** — previous search terms are persisted in localStorage and shown below recent files; clicking one restores it in the search field.
- **Live filesystem search** — `search_live` runs a parallel walkdir scan (max depth 3, heavy dirs excluded) alongside the SQLite FTS query. Both results are merged and deduplicated in the palette for instant local results even for files not yet indexed.

### Improved

- **Disk usage modal** — computation now runs in a `spawn_blocking` thread so it never freezes the UI; skips `node_modules`, `.git`, `target`, `__pycache__`, `.cargo`, `vendor`, `dist`, `.next`, `.nuxt`, and `build` directories for speed and relevance. A note in the modal footer informs the user of excluded directories.
- **Navigation history** — back / forward now correctly update the active tab name; previously the tab label stayed stuck on the child folder after pressing Back.
- **Activity recording** — every folder navigation and every file open is logged to the SQLite activity table, feeding both the command palette recent list and the per-file activity feed.

### Removed

- **Folder size column** — the async per-row size computation caused hover transition jank. The column is removed; aggregate disk usage is still available through the dedicated Disk Usage modal.

## [0.1.4] - 2026-05-12

### Added

- **Trash / Recycle bin** — delete (Del) now moves files and folders to a soft-delete bin stored in AppData instead of permanently removing them. The bin is accessible via the "Corbeille" button at the bottom of the sidebar: browse trashed items with their original path, deletion date, and size; restore any item to its original location (with automatic conflict resolution if the path is taken); delete an item permanently; or empty the entire bin at once with a two-step confirmation. Shift+Del bypasses the bin and permanently deletes immediately (with confirmation dialog). Remote tabs still use direct deletion.
- **Archive manager** — clicking any `.zip`, `.tar`, `.tar.gz`, or `.tgz` file opens a built-in archive viewer instead of the editor. Features: virtual folder navigation with breadcrumb trail, sortable file/folder listing with sizes and compression ratios, "Extract here" (extracts to a same-level folder named after the archive), and "Extract to…" which opens the in-app folder picker. Status bar shows file count, total uncompressed and compressed size, and space savings percentage.
- **In-app folder picker** — replaces the native OS file dialog for all "pick a destination" flows. Supports breadcrumb navigation, ".." back row, subfolder creation (inline input), and a path preview. Used by "Extract to…" in both the archive viewer and the file list context menu.
- **ZIP creation with name prompt** — right-click any file, folder, or selection → *Compress to ZIP*. An inline modal lets you set the archive name before it is created (pre-filled with the file/folder name, ".zip" appended automatically). Works for single items and multi-selections.
- **Binary snapshots** — the snapshot/history panel now supports non-text files. Images (PNG, JPG, WebP…) and office documents (XLSX, ODS, PDF) can be snapshotted and restored; the panel shows a restore-only UI (no diff) for binary formats. CSV files retain the full line-by-line diff view.

### Improved

- **i18n consistency** — all UI strings in every component now go through the `useTranslation()` system. No more hardcoded French or English mixed across the codebase. New translation keys cover: common actions (cancel, close, refresh, create), file operations (rename, duplicate, copy, cut, paste), context menu labels, status bar plurals, trash strings, archive strings, and the folder picker. Both `en` and `fr` locales are fully covered.
- **Context menu** — "Delete" for local files is now labelled *Move to Trash* (Del) with a separate *Delete permanently* entry (Shift+Del); remote tabs keep a single *Delete* entry. All labels adapt to the current language.

## [0.1.3] - 2026-05-06

### Added

- **Multi-window support** — right-click any file or folder and choose *Open in new window*; same option available on folder and file tab context menus. Popup windows use native OS decorations so move, resize, and close all work out of the box.
- **Image thumbnails in grid view** — `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.avif` files render actual thumbnails in grid layout instead of a generic icon. Thumbnails load lazily via Tauri's asset protocol.
- **Status bar** — the file list now shows a persistent bottom bar with total item count (folders + files); when items are selected it switches to selection count and cumulative file size.
- **Editable path bar** — click anywhere on the breadcrumb to switch to a text input and type a path directly. Enter navigates, Escape cancels.

### Improved

- **CSV editor** — editor now stays in table view after initial load (was incorrectly falling back to a raw textarea). Virtual scrolling added for large files (up to 50 000 rows with no lag); row/column count shown in the info bar; fixed an issue where the last rows were unreachable due to the status bar sitting outside the scroll container.
- **Image gallery navigation** — arrow keys and prev/next buttons now cycle images within the current tab instead of opening a new tab for each image.
- **Tab bar overflow** — left/right chevron scroll buttons appear automatically when file or folder tabs overflow the bar width; mouse-wheel scrolling also works.
- **Navigation performance** — listing a directory no longer scans each subdirectory to count children. This eliminates multi-second hangs when navigating outside a workspace on machines with OneDrive or other virtual-filesystem providers.

### Fixed

- **PDF viewer white screen** — updated the pdfjs-dist v5 render call to pass the required `canvas` parameter; added `vite-env.d.ts` so the `?url` worker import resolves under TypeScript.
- **"Open with default app" error** — spurious `state: undefined` argument removed from the `open_with_default` invoke call in DocumentViewer.
- **Popup window snap-back to folder** — React Strict Mode causes the restore effect to run twice; the second run was consuming the (now-absent) init data and falling through to normal workspace restore, which called `setContexts` and wiped `openedFile`. Fixed by: (1) making `get_window_init_data` non-destructive (clones the entry instead of removing it); (2) always returning early in non-main windows regardless of whether init data is present; (3) guarding the init block with `!popupInit` so it runs at most once.

## [0.1.2] - 2026-05-05

### Fixed

- **Close button non-functional** — `core:window:allow-destroy` capability was missing; `Window.destroy()` was failing silently on every click. Added the permission so the titlebar × button and Alt+F4 now reliably save state and close the window.
- **Auto-tags not applied to files created in-app** — new files created via the app were not receiving extension-based auto-tags ("Text", "Images", "Code", etc.). Root cause: the path was built in the frontend with forward-slashes, then converted in Rust, producing a key that didn't match the backslash paths used by `list_directory`. Fixed by passing `dir` + `name` separately and building the full path in Rust with `Path::join`, which guarantees OS-native separators. The file watcher (`handle_fs_event`) also now applies auto-tags on `Create` events as a second layer.
- **"Created" date always showing "—"** — `ListEntry` was missing the `created_at` field; it was hard-coded to 0 everywhere. Added the field to the Rust struct and TypeScript interface, and populated it from `fs::metadata().created()` in `list_directory`, `search_folders`, and the sharing server.
- **Language change only affecting Settings modal** — the `useTranslation()` i18n hook was only wired up in `PreviewPanel`. Extended it to `Toolbar` (search placeholder, "watching" indicator) and `FileList` (Name / Size / Modified column headers).
- **Settings toggles misaligned** — the toggle thumb (absolute-positioned `<span>`) was rendering outside the pill because `<button>` elements don't establish a CSS positioning context in WebView2. Changed the outer element from `<button>` to `<div role="switch">`.

## [0.1.1] - 2026-05-05

### Added

- **Snapshots** — lightweight per-file version history stored in SQLite. Captures a snapshot automatically on every save (auto mode) or on demand via a "+ Save" button (manual mode). Configurable max count per file (2–50, default 10). Files larger than 1 MB are skipped silently.
- **Snapshot diff view** — clicking any snapshot in the History panel opens a modal showing a line-by-line diff between the snapshot and the current file content. Added lines are highlighted in green, removed lines in red; long unchanged sections are collapsed. Restore is available directly from the modal.
- **Snapshot settings** — two new options in Settings → Editor: snapshot mode (Auto / Manual) and max snapshots per file (slider, 2–50).
- **Per-file activity feed** — a "History" tab in the preview panel lists all recorded events for the selected file (open, edit, rename, delete) with timestamps.
- **Guest permissions for shared workspaces** — while hosting, a collapsible "Permissions invités" section in the Share modal lets the host configure what guests can do (List, Read, Create, Edit, Delete). A workspace-wide default applies everywhere; per-path overrides allow narrower or broader access to specific folders or files (longest-prefix match). Permissions are enforced server-side on every WebSocket command.

### Fixed

- **File/folder selection highlighting broken** — `bg-accent/10` and similar Tailwind opacity modifiers were producing invalid CSS because `--color-accent` was set as a hex value. Fixed by adding a `--color-accent-rgb` variable (space-separated RGB) and updating the Tailwind config to use `rgb(var(--color-accent-rgb) / <alpha-value>)`. The `applySettings` function now keeps both variables in sync when the accent color changes.

## [0.1.0] - initial release

First public build. Core features: multi-workspace file explorer, CodeMirror editor, tags & tag rules, full-text search, shared workspaces over WebSocket, frameless window.
