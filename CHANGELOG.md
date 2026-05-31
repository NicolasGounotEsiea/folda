# Changelog

All notable changes to nxs are documented here.

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
