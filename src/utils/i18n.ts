import { useStore } from "../store/useStore";

type AppStrings = {
  // ── existing ──────────────────────────────────────────────────────────────
  name: string; size: string; created: string; modified: string;
  /// Tooltip shown on the Created row when the file was likely copied here,
  /// explaining the inode-created date is later than the content-modified date.
  addedHereOn: string;
  tags: string; noTags: string; addTag: string;
  info: string; history: string;
  statistics: string; items: string;
  noActivity: string;
  loading: string;
  calculating: string;
  search: string;
  watching: string;

  // ── common actions ────────────────────────────────────────────────────────
  cancel: string;
  close: string;
  refresh: string;
  save: string;
  create: string;
  emptyVerb: string;     // "Empty" / "Vider" (action button label)

  // ── file operations ───────────────────────────────────────────────────────
  rename: string;
  duplicate: string;
  copy: string;
  cut: string;
  paste: string;
  delete: string;
  select: string;

  // ── files & folders ───────────────────────────────────────────────────────
  file: string;          // lowercase singular
  files: string;         // capitalized header ("Files" / "Fichiers")
  folder: string;        // lowercase singular
  folders: string;       // capitalized header ("Folders" / "Dossiers")
  element: string;       // status-bar singular: "item" / "élément"
  elements: string;      // status-bar plural: "items" / "éléments"
  selectedOne: string;   // "selected" / "sélectionné"
  selectedMany: string;  // "selected" / "sélectionnés"
  emptyFolder: string;
  emptyFolderHint: string;          // sub-hint shown under the title in empty-state
  noSearchResults: string;           // "No matches"
  noSearchResultsHint: string;       // takes the user's query — use {query} placeholder
  noFilterMatches: string;           // "No files match these filters"
  noFilterMatchesHint: string;       // adjusting tags
  clearSearchAction: string;         // ghost button label
  clearFiltersAction: string;        // ghost button label
  quickFilterPlaceholder: string;        // input placeholder for the "/" filter bar
  quickFilterCountTitle: string;         // tooltip on the "X / Y" counter
  quickFilterNoMatches: string;          // empty state title when filter narrows to zero
  quickFilterNoMatchesHint: string;      // hint — supports {query} placeholder
  quickFilterClear: string;              // ghost button label inside the no-match empty state
  transferCancelled: string;             // info toast when the user cancels a copy/move
  quickStartTitle: string;               // tooltip + ARIA label for the logo button popover
  quickStartWorkspace: string;           // section label "Workspace"
  quickStartNoWorkspace: string;         // fallback when no workspace active
  quickStartRecent: string;              // section label "Recent"
  quickStartNoRecent: string;            // empty-state hint when no activity yet
  quickStartWorkspaces: string;          // section label "Workspaces"
  quickStartActive: string;              // tiny badge on the current workspace row
  emptyTrashTitle: string;           // "Trash is empty"
  emptyTrashHint: string;
  indexingLabel: string;             // status-bar abbreviation, "Indexing" / "Indexation"
  hiddenShort: string;                // status-bar badge, "hidden" / "cachés"
  scanning: string;
  navigateToStart: string;
  newFile: string;
  newFolder: string;

  // ── context menu ─────────────────────────────────────────────────────────
  openWithSystem: string;
  openInEditor: string;
  openInNewWindow: string;
  openFolder: string;
  openInNewTab: string;
  copyPath: string;
  revealInExplorer: string;
  pinToSidebar: string;
  unpinFromSidebar: string;
  bulkRename: string;
  compressToZip: string;
  archiveName: string;

  // ── trash ─────────────────────────────────────────────────────────────────
  trash: string;
  trashIsEmpty: string;
  trashEmptyAction: string;
  trashOriginalLocation: string;
  trashDeletedOn: string;
  trashRestore: string;
  trashDeletePermanently: string;
  trashMoveToTrash: string;
  trashCannotUndo: string;
  today: string;
  yesterday: string;

  // ── archives ──────────────────────────────────────────────────────────────
  archiveReading: string;
  archiveExtractHere: string;
  archiveExtractTo: string;
  archiveFormats: string;
  archiveUnsupported: string;
  archiveOpenWith: string;
  archiveCompressed: string;
  archiveUncompressed: string;
  archiveSaved: string;
  archiveExtracted: string;

  // ── folder picker ─────────────────────────────────────────────────────────
  chooseFolder: string;
  newFolderName: string;

  // sharing
  sharingReconnecting: string;
  sharingConnectedAsGuest: string;
  sharingManageConnection: string;
  sharingActiveShare: string;
  sharingGuest: string;
  sharingGuests: string;
  sharingShare: string;
  sharingJoin: string;

  // AI assistant
  aiTitle: string;
  aiEmptyDesc: string;
  aiSuggestion1: string;
  aiSuggestion2: string;
  aiSuggestion3: string;
  aiThinking: string;
  aiUsingTool: string;
  aiPlaceholder: string;
  aiStop: string;
  aiDisclaimer: string;
  aiDisclaimerOllama: string;
  aiShiftEnter: string;
  // Ollama
  ollamaStatus: string;
  ollamaRunning: string;
  ollamaOffline: string;
  ollamaChecking: string;
  ollamaNotInstalled: string;
  ollamaInstallDesc: string;
  ollamaDownload: string;
  ollamaInstalledModels: string;
  ollamaNoModels: string;
  ollamaDownloadModel: string;
  ollamaPull: string;
  ollamaPulling: string;
  ollamaCustomModel: string;
  ollamaModelPlaceholder: string;
  ollamaModelDone: string;
  ollamaToolWarning: string;
  ollamaRefresh: string;

  // ── Spreadsheet viewer ────────────────────────────────────────────────────
  sheetEdit: string;            // "Edit" / "Éditer"
  sheetSave: string;            // "Save" / "Sauvegarder"
  sheetHeader: string;          // "Header" / "En-tête"
  sheetHeaderToggleOn: string;  // "First row used as header (click to disable)"
  sheetHeaderToggleOff: string; // "Use first row as header"
  sheetFilter: string;          // "Filter" / "Filtrer"
  sheetFilterPlaceholder: string; // "Filter…" / "Filtrer…"
  sheetClearFilter: string;     // tooltip "Clear" / "Effacer"
  sheetCloseFilter: string;     // tooltip "Close" / "Fermer"
  sheetFindEditPlaceholder: string; // input placeholder for find-in-edit
  sheetFindPrev: string;        // tooltip "Previous match"
  sheetFindNext: string;        // tooltip "Next match"

  // ── PDF in-document find ─────────────────────────────────────────────────
  pdfFindPlaceholder: string;
  pdfFindOpen: string;
  pdfFindClose: string;
  pdfFindPrev: string;
  pdfFindNext: string;
  sheetSortActive: string;      // pill "Sort on" / "Tri actif"
  sheetSortClear: string;       // tooltip "Clear sort" / "Annuler le tri"
  sheetSortClick: string;       // tooltip "Click to sort" / "Cliquer pour trier"
  sheetEditing: string;         // status "editing" / "édition en cours"
  sheetEditingHint: string;     // banner "Edit mode — click a cell to modify"
  sheetTruncatedTo: string;     // banner "Display limited to first {n} rows"
  sheetTruncatedStatus: string; // status "truncated to {n}"
  sheetRowSing: string;         // "row" / "ligne"
  sheetRowPlur: string;         // "rows" / "lignes"
  sheetColSing: string;         // "column" / "colonne"
  sheetColPlur: string;         // "columns" / "colonnes"
  sheetSheets: string;          // "sheets" / "feuilles"
  sheetSortedBy: string;        // "sorted by" / "trié par"
  sheetColumnFilters: string;       // toolbar button "Column filters" / "Filtres colonne"
  sheetDelimiterLabel: string;      // mini-label prefix in the dropdown, "Sep:" / "Sép:"
  sheetDelimiterAuto: string;       // "Auto" pill in the dropdown
  sheetDelimiterTooltip: string;    // tooltip on the whole dropdown
  sheetColumnFiltersShow: string;   // tooltip when hidden
  sheetColumnFiltersHide: string;   // tooltip when shown
  sheetColumnFilterPlaceholder: string;  // input placeholder e.g. "Filter…"
  sheetColumnFiltersActive: string;     // status "{n} column filter(s) active"
  sheetColumnFiltersClearAll: string;   // tooltip on clear-all button

  // ── automations ───────────────────────────────────────────────────────────
  automations: string;                  // sidebar entry
  automationsTitle: string;             // modal header
  automationNew: string;                // "+ New rule"
  automationEdit: string;
  automationDisable: string;
  automationEnable: string;
  automationRunNow: string;
  automationEmpty: string;              // empty-state message
  automationHelp: string;               // top help text
  automationConfirmDelete: string;      // "Delete rule '{name}'?"
  automationDeleted: string;
  automationDeleteFailed: string;
  automationSaved: string;
  automationSaveFailed: string;
  automationLoadFailed: string;
  automationNameRequired: string;

  automationFieldName: string;
  automationFieldNamePh: string;
  automationFieldTrigger: string;
  automationFieldScope: string;
  automationFieldScopePh: string;
  automationFieldScopeHelp: string;
  automationFieldConditions: string;
  automationFieldActions: string;
  automationAddCondition: string;
  automationAddAction: string;
  automationNoConditions: string;
  automationNoActions: string;
  automationBrowse: string;

  automationTriggerCreated: string;
  automationTriggerModified: string;
  automationTriggerRenamed: string;
  automationTriggerManual: string;
  automationTriggerCreatedHelp: string;
  automationTriggerModifiedHelp: string;
  automationTriggerRenamedHelp: string;
  automationTriggerManualHelp: string;

  automationCondExt: string;
  automationCondNameContains: string;
  automationCondNameStarts: string;
  automationCondNameRegex: string;
  automationCondPathContains: string;
  automationCondSizeGt: string;
  automationCondSizeLt: string;
  automationCondAgeGtDays: string;
  automationCondTagHas: string;
  automationCondExtPh: string;
  automationCondNamePh: string;
  automationCondRegexPh: string;
  automationCondPathPh: string;
  automationCondBytesPh: string;
  automationCondDaysPh: string;
  automationCondTagPh: string;

  automationActionMoveTo: string;
  automationActionCopyTo: string;
  automationActionRename: string;
  automationActionAddTag: string;
  automationActionRemoveTag: string;
  automationActionTrash: string;
  automationActionNotify: string;
  automationActionTrashHelp: string;
  automationActionPathPh: string;
  automationActionRenamePh: string;
  automationActionTagPh: string;
  automationActionMessagePh: string;

  automationSummaryNoConditions: string;
  automationSummaryConditionsSingular: string;
  automationSummaryConditionsPlural: string;
  automationSummaryActionsSingular: string;
  automationSummaryActionsPlural: string;
  automationSummaryAnyHint: string;          // "(any)" shown next to conditions when OR mode

  automationConditionLogicLabel: string;     // label before the segmented toggle
  automationConditionLogicAll: string;       // "ALL must match" pill
  automationConditionLogicAny: string;       // "ANY must match" pill

  automationRunTargetDir: string;
  automationRunTargetDirPh: string;
  automationRunRecursive: string;
  automationRunDryRun: string;
  automationRunApply: string;
  automationRunDisabled: string;        // tooltip on Apply when rule is disabled
  automationRunNoTarget: string;
  automationRunDone: string;            // "{n} action(s) applied"
  automationRunFailed: string;
  automationRunReportDry: string;       // "{matched} file(s), {actions} action(s) preview"
  automationRunReportLive: string;      // "{ok}/{total} succeeded"

  automationToastRuleDisabledTitle: string;   // toast on rate-limit trip
  automationToastRuleDisabledDetail: string;
  automationToastOpen: string;                // CTA button label on the toast

  // ── automations: per-rule diagnostics ─────────────────────────────────────
  automationDiagFiredTimes: string;    // "fired {n}× · last {when}"
  automationDiagJustNow: string;       // "just now"
  automationDiagMinutesAgo: string;    // "{n}m ago"
  automationDiagHoursAgo: string;      // "{n}h ago"
  automationDiagDaysAgo: string;       // "{n}d ago"
  automationDiagLastErrorChip: string; // chip text "last error"
  automationDiagLastErrorTitle: string; // hover title: "Last error: {error}"

  // ── automations: preset library ───────────────────────────────────────────
  automationPresets: string;            // button label "Templates"
  automationPresetsHint: string;        // tooltip "Start from a template"
  automationEmptyTryPreset: string;     // empty-state header above gallery
  automationPresetTagPdfsName: string;
  automationPresetTagPdfsDesc: string;
  automationPresetTagImagesName: string;
  automationPresetTagImagesDesc: string;
  automationPresetArchiveScreenshotsName: string;
  automationPresetArchiveScreenshotsDesc: string;
  automationPresetOrganizePdfsName: string;
  automationPresetOrganizePdfsDesc: string;
  automationPresetCleanTmpName: string;
  automationPresetCleanTmpDesc: string;

  automationDragToReorder: string;     // tooltip on the action drag handle

  // ── git integration (sidebar GitPanel) ────────────────────────────────────
  gitLoading: string;
  gitStaleHint: string;
  gitAheadBehindTitle: string;
  gitChanges: string;
  gitBranches: string;
  gitCommits: string;
  gitNoChanges: string;
  gitNoBranches: string;
  gitNoCommits: string;
  gitJustNow: string;
  gitMinutesAgo: string;
  gitHoursAgo: string;
  gitDaysAgo: string;

  // ── git integration (per-file tab in PreviewPanel) ────────────────────────
  gitTabLabel: string;
  gitFileClean: string;
  gitFileNotInRepo: string;
  gitFileDiffHeader: string;
  gitFileHistoryHeader: string;
  gitFileNoHistory: string;

  // ── git: collapse + checkout ──────────────────────────────────────────────
  gitCollapse: string;
  gitExpand: string;
  gitCurrentBranch: string;            // tooltip on the row of the current branch
  gitClickToCheckout: string;          // tooltip on other local branches
  gitRemoteBranchUnclickable: string;  // tooltip on remote branches (if shown)
  gitCheckoutConfirm: string;          // window.confirm("Switch to {name}?")
  gitCheckoutSuccess: string;          // toast message
  gitCheckoutFailed: string;           // toast title (detail = libgit2 message)

  // ── search: match-origin badges ───────────────────────────────────────────
  commandPaletteContentBadge: string;       // "content" / "contenu" chip label
  commandPaletteContentBadgeTitle: string;  // hover tooltip explaining the badge

  previewExtractedText: string;             // "Extracted text" header in PreviewPanel

  // ── Compare files (Notepad++ Compare-style) ───────────────────────────────
  diffCompareFiles: string;                 // context menu entry
  diffCompareWithOtherPane: string;         // context menu entry, dual-pane only
  diffModeTooltip: string;                  // tooltip on the line/char toggle
  diffModeChar: string;                     // toggle label, e.g. "Char"
  diffModeLine: string;                     // toggle label, e.g. "Line"
  diffComparing: string;                    // loading state in the modal
  diffIdentical: string;                    // "Files are identical"
  diffPrevHunk: string;                     // tooltip for previous-hunk button
  diffNextHunk: string;                     // tooltip for next-hunk button
  diffFirstHunk: string;                    // tooltip for first-hunk button
  diffLastHunk: string;                     // tooltip for last-hunk button
};

const translations: Record<string, AppStrings> = {
  en: {
    name: "Name", size: "Size", created: "Created", modified: "Modified",
    addedHereOn: "Copied to this folder on {date} — the file's content modification date is older.",
    tags: "Tags", noTags: "No tags", addTag: "+ Add",
    info: "Info", history: "History",
    statistics: "Statistics", items: "Items",
    noActivity: "No activity recorded",
    loading: "Loading…",
    calculating: "Calculating…",
    search: "Search…",
    watching: "watching",

    cancel: "Cancel",
    close: "Close",
    refresh: "Refresh",
    save: "Save",
    create: "Create",
    emptyVerb: "Empty",

    rename: "Rename",
    duplicate: "Duplicate",
    copy: "Copy",
    cut: "Cut",
    paste: "Paste",
    delete: "Delete",
    select: "Select",

    file: "file",
    files: "Files",
    folder: "folder",
    folders: "Folders",
    element: "item",
    elements: "items",
    selectedOne: "selected",
    selectedMany: "selected",
    emptyFolder: "This folder is empty",
    emptyFolderHint: "Drop files here, or right-click to create something new.",
    noSearchResults: "No matches",
    noSearchResultsHint: "Nothing found for “{query}”. Try a partial word or different keyword.",
    noFilterMatches: "No files match these filters",
    noFilterMatchesHint: "Adjust the active tags or clear them to see more results.",
    clearSearchAction: "Clear search",
    quickFilterPlaceholder: "Filter this folder…",
    quickFilterCountTitle: "Matching items in the current folder",
    quickFilterNoMatches: "Nothing matches in this folder",
    quickFilterNoMatchesHint: "No entries in this folder contain “{query}”. Press Esc to clear.",
    quickFilterClear: "Clear filter",
    transferCancelled: "Transfer cancelled",
    quickStartTitle: "Quick start",
    quickStartWorkspace: "Workspace",
    quickStartNoWorkspace: "No workspace active",
    quickStartRecent: "Recent",
    quickStartNoRecent: "Nothing recent yet — open a few folders to see them here.",
    quickStartWorkspaces: "Workspaces",
    quickStartActive: "Active",
    clearFiltersAction: "Clear filters",
    emptyTrashTitle: "Trash is empty",
    emptyTrashHint: "Files you delete from nxs land here. Restore or empty them anytime.",
    indexingLabel: "Indexing",
    hiddenShort: "hidden",
    scanning: "Scanning…",
    navigateToStart: "Navigate to a folder to start",
    newFile: "New file",
    newFolder: "New folder",

    openWithSystem: "Open with system app",
    openInEditor: "Open in editor",
    openInNewWindow: "Open in new window",
    openFolder: "Open folder",
    openInNewTab: "Open in new tab",
    copyPath: "Copy path",
    revealInExplorer: "Reveal in Explorer",
    pinToSidebar: "Pin to sidebar",
    unpinFromSidebar: "Unpin from sidebar",
    bulkRename: "Bulk rename",
    compressToZip: "Compress to ZIP",
    archiveName: "Archive name",

    trash: "Trash",
    trashIsEmpty: "Trash is empty",
    trashEmptyAction: "Empty Trash",
    trashOriginalLocation: "Original location",
    trashDeletedOn: "Deleted",
    trashRestore: "Restore",
    trashDeletePermanently: "Delete permanently",
    trashMoveToTrash: "Move to Trash",
    trashCannotUndo: "This action cannot be undone.",
    today: "Today",
    yesterday: "Yesterday",

    archiveReading: "Reading archive…",
    archiveExtractHere: "Extract here",
    archiveExtractTo: "Extract to…",
    archiveFormats: "Supported formats: ZIP, TAR, TAR.GZ / TGZ",
    archiveUnsupported: "Unsupported format for navigation",
    archiveOpenWith: "Use \"Open with system app\"",
    archiveCompressed: "Compressed",
    archiveUncompressed: "uncompressed",
    archiveSaved: "saved",
    archiveExtracted: "files extracted",

    chooseFolder: "Choose a folder",
    newFolderName: "New folder name",

    sharingReconnecting: "Reconnecting…",
    sharingConnectedAsGuest: "Connected as guest",
    sharingManageConnection: "Manage connection",
    sharingActiveShare: "Active share",
    sharingGuest: "guest",
    sharingGuests: "guests",
    sharingShare: "Share",
    sharingJoin: "Join",

    aiTitle: "AI Assistant",
    aiEmptyDesc: "Ask me anything about your files — I can browse folders, search, read files, and help you organize.",
    aiSuggestion1: "What's in this folder?",
    aiSuggestion2: "Find all PDF files",
    aiSuggestion3: "What are my recent files?",
    aiThinking: "Thinking…",
    aiUsingTool: "Using tool:",
    aiPlaceholder: "Ask about your files… (Enter to send)",
    aiStop: "Stop",
    aiDisclaimer: "File paths may be sent to Anthropic",
    aiDisclaimerOllama: "Everything stays local — no data leaves your machine",
    aiShiftEnter: "Shift+Enter for new line",
    ollamaStatus: "Ollama status",
    ollamaRunning: "Ollama is running",
    ollamaOffline: "Ollama not detected",
    ollamaChecking: "Checking…",
    ollamaNotInstalled: "Ollama is not installed or not running",
    ollamaInstallDesc: "Ollama lets you run AI models locally for free. Install it once, then come back here to download a model.",
    ollamaDownload: "Download Ollama (free)",
    ollamaInstalledModels: "Installed models",
    ollamaNoModels: "No models installed yet",
    ollamaDownloadModel: "Download a model",
    ollamaPull: "Download",
    ollamaPulling: "Downloading…",
    ollamaCustomModel: "Custom model name",
    ollamaModelPlaceholder: "e.g. mistral:7b",
    ollamaModelDone: "Model ready",
    ollamaToolWarning: "This model may not support tools — responses may be text-only",
    ollamaRefresh: "Refresh",

    // Spreadsheet
    sheetEdit: "Edit",
    sheetSave: "Save",
    sheetHeader: "Header",
    sheetHeaderToggleOn: "First row used as header (click to disable)",
    sheetHeaderToggleOff: "Use first row as header",
    sheetFilter: "Filter",
    sheetFilterPlaceholder: "Filter…",
    sheetClearFilter: "Clear",
    sheetCloseFilter: "Close",
    sheetFindEditPlaceholder: "Find in cells…",
    sheetFindPrev: "Previous match (Shift+Enter)",
    sheetFindNext: "Next match (Enter)",

    pdfFindPlaceholder: "Find in document…",
    pdfFindOpen: "Find (Ctrl+F)",
    pdfFindClose: "Close find",
    pdfFindPrev: "Previous match (Shift+Enter)",
    pdfFindNext: "Next match (Enter)",
    sheetSortActive: "Sort on",
    sheetSortClear: "Clear sort",
    sheetSortClick: "Click to sort",
    sheetEditing: "editing",
    sheetEditingHint: "Edit mode — click a cell to modify",
    sheetTruncatedTo: "Display limited to first {n} rows",
    sheetTruncatedStatus: "truncated to {n}",
    sheetRowSing: "row",
    sheetRowPlur: "rows",
    sheetColSing: "column",
    sheetColPlur: "columns",
    sheetSheets: "sheets",
    sheetSortedBy: "sorted by",
    sheetColumnFilters: "Column filters",
    sheetDelimiterLabel: "Sep:",
    sheetDelimiterAuto: "Auto",
    sheetDelimiterTooltip: "CSV field separator. Auto-detects from the first lines; pick one explicitly if detection misses (typically semicolon or pipe).",
    sheetColumnFiltersShow: "Show column filters",
    sheetColumnFiltersHide: "Hide column filters",
    sheetColumnFilterPlaceholder: "Filter…",
    sheetColumnFiltersActive: "{n} column filter(s) active",
    sheetColumnFiltersClearAll: "Clear all column filters",

    automations: "Automations",
    automationsTitle: "Automations",
    automationNew: "New rule",
    automationEdit: "Edit",
    automationDisable: "Disable",
    automationEnable: "Enable",
    automationRunNow: "Run now",
    automationEmpty: "No automation rules yet. Create one to react to file events or batch-process a folder.",
    automationHelp: "Rules fire automatically on file events, or on demand against a target folder.",
    automationConfirmDelete: "Delete the automation \"{name}\"?",
    automationDeleted: "Rule deleted",
    automationDeleteFailed: "Could not delete the rule",
    automationSaved: "Rule saved",
    automationSaveFailed: "Could not save the rule",
    automationLoadFailed: "Could not load rules",
    automationNameRequired: "Please give the rule a name",

    automationFieldName: "Name",
    automationFieldNamePh: "e.g. Archive invoices by year",
    automationFieldTrigger: "Trigger",
    automationFieldScope: "Folder",
    automationFieldScopePh: "C:\\Users\\…\\Downloads (empty = anywhere)",
    automationFieldScopeHelp: "Restricts the trigger to events inside this folder (and subfolders). Leave empty to match anywhere.",
    automationFieldConditions: "Conditions (all must match)",
    automationFieldActions: "Actions (run in order)",
    automationAddCondition: "Add condition",
    automationAddAction: "Add action",
    automationNoConditions: "No conditions — every file will match.",
    automationNoActions: "No actions yet — add at least one.",
    automationBrowse: "Browse",

    automationTriggerCreated: "On create",
    automationTriggerModified: "On modify",
    automationTriggerRenamed: "On rename",
    automationTriggerManual: "Manual",
    automationTriggerCreatedHelp: "Fires when a new file appears in the folder.",
    automationTriggerModifiedHelp: "Fires when a file is edited or overwritten.",
    automationTriggerRenamedHelp: "Fires when a file is renamed.",
    automationTriggerManualHelp: "Runs only when you click \"Run now\" against a folder.",

    automationCondExt: "extension is",
    automationCondNameContains: "name contains",
    automationCondNameStarts: "name starts with",
    automationCondNameRegex: "name matches regex",
    automationCondPathContains: "path contains",
    automationCondSizeGt: "size >",
    automationCondSizeLt: "size <",
    automationCondAgeGtDays: "older than (days)",
    automationCondTagHas: "has tag",
    automationCondExtPh: "pdf",
    automationCondNamePh: "report",
    automationCondRegexPh: "^report-\\d{4}\\.pdf$",
    automationCondPathPh: "\\2026\\",
    automationCondBytesPh: "bytes",
    automationCondDaysPh: "days",
    automationCondTagPh: "Invoices",

    automationActionMoveTo: "move to",
    automationActionCopyTo: "copy to",
    automationActionRename: "rename to",
    automationActionAddTag: "add tag",
    automationActionRemoveTag: "remove tag",
    automationActionTrash: "move to trash",
    automationActionNotify: "notify",
    automationActionTrashHelp: "no parameter needed",
    automationActionPathPh: "D:\\Archive\\{year}",
    automationActionRenamePh: "{year}-{month}-{name}.{ext}",
    automationActionTagPh: "Invoices",
    automationActionMessagePh: "Message shown to the user",

    automationSummaryNoConditions: "no conditions",
    automationSummaryConditionsSingular: "condition",
    automationSummaryConditionsPlural: "conditions",
    automationSummaryActionsSingular: "action",
    automationSummaryActionsPlural: "actions",
    automationSummaryAnyHint: "(any)",

    automationConditionLogicLabel: "Match:",
    automationConditionLogicAll: "ALL",
    automationConditionLogicAny: "ANY",

    automationRunTargetDir: "Target folder",
    automationRunTargetDirPh: "Pick the folder to scan",
    automationRunRecursive: "Include subfolders (up to depth 8, skips .git / node_modules / etc.)",
    automationRunDryRun: "Preview (dry-run)",
    automationRunApply: "Apply",
    automationRunDisabled: "Enable the rule first to apply for real",
    automationRunNoTarget: "Please pick a target folder",
    automationRunDone: "{n} action(s) applied",
    automationRunFailed: "Run failed",
    automationRunReportDry: "{matched} file(s) would match, {actions} action(s) preview",
    automationRunReportLive: "{ok} / {total} action(s) succeeded",

    automationToastRuleDisabledTitle: "Automation \"{name}\" was paused",
    automationToastRuleDisabledDetail: "It fired more than {limit} times in {seconds}s. Re-enable it from the Automations panel once the underlying issue is fixed.",
    automationToastOpen: "Open Automations",

    automationDiagFiredTimes: "fired {n}× · last {when}",
    automationDiagJustNow: "just now",
    automationDiagMinutesAgo: "{n}m ago",
    automationDiagHoursAgo: "{n}h ago",
    automationDiagDaysAgo: "{n}d ago",
    automationDiagLastErrorChip: "last error",
    automationDiagLastErrorTitle: "Last error: {error}",

    automationPresets: "Templates",
    automationPresetsHint: "Start from a ready-made rule",
    automationEmptyTryPreset: "No rules yet — pick a template below to get started, or click \"New rule\" for a blank one.",
    automationPresetTagPdfsName: "Tag PDFs as Documents",
    automationPresetTagPdfsDesc: "Manual run · adds the \"Documents\" tag to every PDF in a folder.",
    automationPresetTagImagesName: "Tag images as Photos",
    automationPresetTagImagesDesc: "Manual run · uses a regex to match jpg/png/webp/heic and tag them \"Photos\".",
    automationPresetArchiveScreenshotsName: "Archive old screenshots",
    automationPresetArchiveScreenshotsDesc: "Manual run · sends files named Screenshot* older than 30 days to the trash.",
    automationPresetOrganizePdfsName: "Organize new PDFs by year",
    automationPresetOrganizePdfsDesc: "On create · moves new PDFs to C:\\Archive\\{year}. Edit the destination before saving.",
    automationPresetCleanTmpName: "Clean .tmp files older than 7 days",
    automationPresetCleanTmpDesc: "Manual run · trashes .tmp files that haven't been touched in a week.",

    automationDragToReorder: "Drag to reorder",

    gitLoading: "Loading git status…",
    gitStaleHint: "Index was locked by another process — showing slightly stale data",
    gitAheadBehindTitle: "Commits ahead of / behind the upstream branch",
    gitChanges: "Changes",
    gitBranches: "Branches",
    gitCommits: "Recent commits",
    gitNoChanges: "Working tree is clean",
    gitNoBranches: "No branches",
    gitNoCommits: "No commits yet",
    gitJustNow: "just now",
    gitMinutesAgo: "{n}m ago",
    gitHoursAgo: "{n}h ago",
    gitDaysAgo: "{n}d ago",

    gitTabLabel: "Git",
    gitFileClean: "Clean — no uncommitted changes",
    gitFileNotInRepo: "This file isn't inside a git repository.",
    gitFileDiffHeader: "Changes vs HEAD",
    gitFileHistoryHeader: "Recent commits touching this file",
    gitFileNoHistory: "No history found within the last 1000 commits.",

    gitCollapse: "Collapse git panel",
    gitExpand: "Expand git panel",
    gitCurrentBranch: "Current branch",
    gitClickToCheckout: "Click to switch to this branch",
    gitRemoteBranchUnclickable: "Remote branch — check it out via your git client",
    gitCheckoutConfirm: "Switch to branch \"{name}\"?\n\nThis will update your files on disk. Uncommitted changes will block the switch.",
    gitCheckoutSuccess: "Switched to {name}",
    gitCheckoutFailed: "Could not switch branch",

    commandPaletteContentBadge: "content",
    commandPaletteContentBadgeTitle: "This result matched on indexed file content, not its name",

    previewExtractedText: "Extracted text",

    diffCompareFiles: "Compare files",
    diffCompareWithOtherPane: "Compare with other pane",
    diffModeTooltip: "Switch between character-level (intra-line highlights) and line-level (whole-line wash) display",
    diffModeChar: "Char",
    diffModeLine: "Line",
    diffComparing: "Computing diff…",
    diffIdentical: "Files are identical",
    diffPrevHunk: "Previous change (Shift+F3)",
    diffNextHunk: "Next change (F3)",
    diffFirstHunk: "First change (Home)",
    diffLastHunk: "Last change (End)",
  },

  fr: {
    name: "Nom", size: "Taille", created: "Créé le", modified: "Modifié",
    addedHereOn: "Copié dans ce dossier le {date} — la date de modification du contenu est plus ancienne.",
    tags: "Étiquettes", noTags: "Aucune étiquette", addTag: "+ Ajouter",
    info: "Infos", history: "Historique",
    statistics: "Statistiques", items: "Éléments",
    noActivity: "Aucune activité enregistrée",
    loading: "Chargement…",
    calculating: "Calcul…",
    search: "Rechercher…",
    watching: "surveillance",

    cancel: "Annuler",
    close: "Fermer",
    refresh: "Rafraîchir",
    save: "Enregistrer",
    create: "Créer",
    emptyVerb: "Vider",

    rename: "Renommer",
    duplicate: "Dupliquer",
    copy: "Copier",
    cut: "Couper",
    paste: "Coller",
    delete: "Supprimer",
    select: "Sélectionner",

    file: "fichier",
    files: "Fichiers",
    folder: "dossier",
    folders: "Dossiers",
    element: "élément",
    elements: "éléments",
    selectedOne: "sélectionné",
    selectedMany: "sélectionnés",
    emptyFolder: "Ce dossier est vide",
    emptyFolderHint: "Glisse des fichiers ici, ou clic-droit pour en créer un nouveau.",
    noSearchResults: "Aucun résultat",
    noSearchResultsHint: "Rien trouvé pour « {query} ». Essaie un mot partiel ou un autre mot-clé.",
    noFilterMatches: "Aucun fichier ne correspond à ces filtres",
    noFilterMatchesHint: "Ajuste les étiquettes actives ou enlève-les pour voir plus de résultats.",
    clearSearchAction: "Effacer la recherche",
    quickFilterPlaceholder: "Filtrer ce dossier…",
    quickFilterCountTitle: "Éléments correspondants dans le dossier",
    quickFilterNoMatches: "Aucun élément dans ce dossier",
    quickFilterNoMatchesHint: "Rien ne contient « {query} » ici. Appuie sur Esc pour effacer.",
    quickFilterClear: "Effacer le filtre",
    transferCancelled: "Transfert annulé",
    quickStartTitle: "Accès rapide",
    quickStartWorkspace: "Workspace",
    quickStartNoWorkspace: "Aucun workspace actif",
    quickStartRecent: "Récents",
    quickStartNoRecent: "Rien de récent — ouvre quelques dossiers pour les voir ici.",
    quickStartWorkspaces: "Workspaces",
    quickStartActive: "Actif",
    clearFiltersAction: "Effacer les filtres",
    emptyTrashTitle: "La corbeille est vide",
    emptyTrashHint: "Les fichiers supprimés dans nxs apparaissent ici. Restaure-les ou vide-les quand tu veux.",
    indexingLabel: "Indexation",
    hiddenShort: "cachés",
    scanning: "Analyse en cours…",
    navigateToStart: "Naviguez vers un dossier pour commencer",
    newFile: "Nouveau fichier",
    newFolder: "Nouveau dossier",

    openWithSystem: "Ouvrir avec l'app système",
    openInEditor: "Ouvrir dans l'éditeur",
    openInNewWindow: "Ouvrir dans une nouvelle fenêtre",
    openFolder: "Ouvrir le dossier",
    openInNewTab: "Ouvrir dans un nouvel onglet",
    copyPath: "Copier le chemin",
    revealInExplorer: "Afficher dans l'Explorateur",
    pinToSidebar: "Épingler dans la barre latérale",
    unpinFromSidebar: "Détacher de la barre latérale",
    bulkRename: "Renommer en masse",
    compressToZip: "Compresser en ZIP",
    archiveName: "Nom de l'archive",

    trash: "Corbeille",
    trashIsEmpty: "La corbeille est vide",
    trashEmptyAction: "Vider la corbeille",
    trashOriginalLocation: "Emplacement d'origine",
    trashDeletedOn: "Supprimé le",
    trashRestore: "Restaurer",
    trashDeletePermanently: "Supprimer définitivement",
    trashMoveToTrash: "Déplacer à la corbeille",
    trashCannotUndo: "Cette action est irréversible.",
    today: "Aujourd'hui",
    yesterday: "Hier",

    archiveReading: "Lecture de l'archive…",
    archiveExtractHere: "Extraire ici",
    archiveExtractTo: "Extraire vers…",
    archiveFormats: "Formats supportés : ZIP, TAR, TAR.GZ / TGZ",
    archiveUnsupported: "Format non supporté pour la navigation",
    archiveOpenWith: "Utilisez « Ouvrir avec l'app système »",
    archiveCompressed: "Compressé",
    archiveUncompressed: "non compressé",
    archiveSaved: "économisé",
    archiveExtracted: "fichiers extraits",

    chooseFolder: "Choisir un dossier",
    newFolderName: "Nom du nouveau dossier",

    sharingReconnecting: "Reconnexion…",
    sharingConnectedAsGuest: "Connecté en tant qu'invité",
    sharingManageConnection: "Gérer la connexion",
    sharingActiveShare: "Partage actif",
    sharingGuest: "invité",
    sharingGuests: "invités",
    sharingShare: "Partager",
    sharingJoin: "Rejoindre",

    aiTitle: "Assistant IA",
    aiEmptyDesc: "Posez-moi des questions sur vos fichiers — je peux parcourir les dossiers, rechercher, lire des fichiers et vous aider à organiser.",
    aiSuggestion1: "Qu'est-ce qu'il y a dans ce dossier ?",
    aiSuggestion2: "Trouver tous les PDF",
    aiSuggestion3: "Quels sont mes fichiers récents ?",
    aiThinking: "Réflexion en cours…",
    aiUsingTool: "Utilisation de l'outil :",
    aiPlaceholder: "Posez une question sur vos fichiers… (Entrée pour envoyer)",
    aiStop: "Arrêter",
    aiDisclaimer: "Les chemins de fichiers peuvent être envoyés à Anthropic",
    aiDisclaimerOllama: "Tout reste local — aucune donnée ne quitte votre machine",
    aiShiftEnter: "Maj+Entrée pour nouvelle ligne",
    ollamaStatus: "Statut d'Ollama",
    ollamaRunning: "Ollama est actif",
    ollamaOffline: "Ollama non détecté",
    ollamaChecking: "Vérification…",
    ollamaNotInstalled: "Ollama n'est pas installé ou n'est pas actif",
    ollamaInstallDesc: "Ollama vous permet d'exécuter des modèles IA localement et gratuitement. Installez-le une fois, puis revenez ici pour télécharger un modèle.",
    ollamaDownload: "Télécharger Ollama (gratuit)",
    ollamaInstalledModels: "Modèles installés",
    ollamaNoModels: "Aucun modèle installé",
    ollamaDownloadModel: "Télécharger un modèle",
    ollamaPull: "Télécharger",
    ollamaPulling: "Téléchargement…",
    ollamaCustomModel: "Nom de modèle personnalisé",
    ollamaModelPlaceholder: "ex. mistral:7b",
    ollamaModelDone: "Modèle prêt",
    ollamaToolWarning: "Ce modèle ne supporte peut-être pas les outils — les réponses peuvent être en texte uniquement",
    ollamaRefresh: "Rafraîchir",

    // Spreadsheet
    sheetEdit: "Éditer",
    sheetSave: "Sauvegarder",
    sheetHeader: "En-tête",
    sheetHeaderToggleOn: "Première ligne utilisée comme en-tête (cliquer pour désactiver)",
    sheetHeaderToggleOff: "Activer la première ligne comme en-tête",
    sheetFilter: "Filtrer",
    sheetFilterPlaceholder: "Filtrer…",
    sheetClearFilter: "Effacer",
    sheetCloseFilter: "Fermer",
    sheetFindEditPlaceholder: "Rechercher dans les cellules…",
    sheetFindPrev: "Précédent (Maj+Entrée)",
    sheetFindNext: "Suivant (Entrée)",

    pdfFindPlaceholder: "Rechercher dans le document…",
    pdfFindOpen: "Rechercher (Ctrl+F)",
    pdfFindClose: "Fermer la recherche",
    pdfFindPrev: "Précédent (Maj+Entrée)",
    pdfFindNext: "Suivant (Entrée)",
    sheetSortActive: "Tri actif",
    sheetSortClear: "Annuler le tri",
    sheetSortClick: "Cliquer pour trier",
    sheetEditing: "édition en cours",
    sheetEditingHint: "Mode édition — cliquez une cellule pour modifier",
    sheetTruncatedTo: "Affichage limité aux {n} premières lignes",
    sheetTruncatedStatus: "tronqué à {n}",
    sheetRowSing: "ligne",
    sheetRowPlur: "lignes",
    sheetColSing: "colonne",
    sheetColPlur: "colonnes",
    sheetSheets: "feuilles",
    sheetSortedBy: "trié par",
    sheetColumnFilters: "Filtres colonne",
    sheetDelimiterLabel: "Sép:",
    sheetDelimiterAuto: "Auto",
    sheetDelimiterTooltip: "Séparateur de champs CSV. Auto-détecté à partir des premières lignes ; choisis explicitement si la détection rate (typiquement point-virgule ou pipe).",
    sheetColumnFiltersShow: "Afficher les filtres par colonne",
    sheetColumnFiltersHide: "Masquer les filtres par colonne",
    sheetColumnFilterPlaceholder: "Filtrer…",
    sheetColumnFiltersActive: "{n} filtre(s) colonne actif(s)",
    sheetColumnFiltersClearAll: "Effacer tous les filtres colonne",

    automations: "Automatisations",
    automationsTitle: "Automatisations",
    automationNew: "Nouvelle règle",
    automationEdit: "Modifier",
    automationDisable: "Désactiver",
    automationEnable: "Activer",
    automationRunNow: "Exécuter",
    automationEmpty: "Aucune règle pour le moment. Créez-en une pour réagir aux événements de fichiers ou traiter un dossier en lot.",
    automationHelp: "Les règles s'exécutent automatiquement sur les événements fichier, ou à la demande sur un dossier cible.",
    automationConfirmDelete: "Supprimer l'automatisation « {name} » ?",
    automationDeleted: "Règle supprimée",
    automationDeleteFailed: "Impossible de supprimer la règle",
    automationSaved: "Règle enregistrée",
    automationSaveFailed: "Impossible d'enregistrer la règle",
    automationLoadFailed: "Impossible de charger les règles",
    automationNameRequired: "Donnez un nom à la règle",

    automationFieldName: "Nom",
    automationFieldNamePh: "ex. Archiver les factures par année",
    automationFieldTrigger: "Déclencheur",
    automationFieldScope: "Dossier",
    automationFieldScopePh: "C:\\Users\\…\\Téléchargements (vide = partout)",
    automationFieldScopeHelp: "Restreint le déclencheur aux événements dans ce dossier (et sous-dossiers). Laissez vide pour s'appliquer partout.",
    automationFieldConditions: "Conditions (toutes doivent correspondre)",
    automationFieldActions: "Actions (exécutées dans l'ordre)",
    automationAddCondition: "Ajouter une condition",
    automationAddAction: "Ajouter une action",
    automationNoConditions: "Aucune condition — tous les fichiers correspondront.",
    automationNoActions: "Aucune action pour l'instant — ajoutez-en au moins une.",
    automationBrowse: "Parcourir",

    automationTriggerCreated: "À la création",
    automationTriggerModified: "À la modification",
    automationTriggerRenamed: "Au renommage",
    automationTriggerManual: "Manuel",
    automationTriggerCreatedHelp: "Se déclenche quand un nouveau fichier apparaît dans le dossier.",
    automationTriggerModifiedHelp: "Se déclenche quand un fichier est édité ou écrasé.",
    automationTriggerRenamedHelp: "Se déclenche quand un fichier est renommé.",
    automationTriggerManualHelp: "Ne s'exécute que via le bouton « Exécuter » sur un dossier.",

    automationCondExt: "extension =",
    automationCondNameContains: "le nom contient",
    automationCondNameStarts: "le nom commence par",
    automationCondNameRegex: "le nom matche le regex",
    automationCondPathContains: "le chemin contient",
    automationCondSizeGt: "taille >",
    automationCondSizeLt: "taille <",
    automationCondAgeGtDays: "plus vieux que (jours)",
    automationCondTagHas: "a l'étiquette",
    automationCondExtPh: "pdf",
    automationCondNamePh: "rapport",
    automationCondRegexPh: "^rapport-\\d{4}\\.pdf$",
    automationCondPathPh: "\\2026\\",
    automationCondBytesPh: "octets",
    automationCondDaysPh: "jours",
    automationCondTagPh: "Factures",

    automationActionMoveTo: "déplacer vers",
    automationActionCopyTo: "copier vers",
    automationActionRename: "renommer en",
    automationActionAddTag: "ajouter l'étiquette",
    automationActionRemoveTag: "retirer l'étiquette",
    automationActionTrash: "mettre à la corbeille",
    automationActionNotify: "notifier",
    automationActionTrashHelp: "aucun paramètre requis",
    automationActionPathPh: "D:\\Archive\\{year}",
    automationActionRenamePh: "{year}-{month}-{name}.{ext}",
    automationActionTagPh: "Factures",
    automationActionMessagePh: "Message affiché à l'utilisateur",

    automationSummaryNoConditions: "aucune condition",
    automationSummaryConditionsSingular: "condition",
    automationSummaryConditionsPlural: "conditions",
    automationSummaryActionsSingular: "action",
    automationSummaryActionsPlural: "actions",
    automationSummaryAnyHint: "(au moins une)",

    automationConditionLogicLabel: "Correspondance :",
    automationConditionLogicAll: "TOUTES",
    automationConditionLogicAny: "AU MOINS UNE",

    automationRunTargetDir: "Dossier cible",
    automationRunTargetDirPh: "Choisissez le dossier à analyser",
    automationRunRecursive: "Inclure les sous-dossiers (profondeur max 8, ignore .git / node_modules / etc.)",
    automationRunDryRun: "Aperçu (sans modification)",
    automationRunApply: "Appliquer",
    automationRunDisabled: "Activez la règle avant d'appliquer pour de vrai",
    automationRunNoTarget: "Choisissez un dossier cible",
    automationRunDone: "{n} action(s) appliquée(s)",
    automationRunFailed: "Échec de l'exécution",
    automationRunReportDry: "{matched} fichier(s) correspondraient, {actions} action(s) en aperçu",
    automationRunReportLive: "{ok} / {total} action(s) réussies",

    automationToastRuleDisabledTitle: "Automatisation « {name} » mise en pause",
    automationToastRuleDisabledDetail: "Elle s'est déclenchée plus de {limit} fois en {seconds}s. Réactivez-la depuis le panneau Automatisations après avoir résolu la cause.",
    automationToastOpen: "Ouvrir Automatisations",

    automationDiagFiredTimes: "déclenchée {n}× · dernière {when}",
    automationDiagJustNow: "à l'instant",
    automationDiagMinutesAgo: "il y a {n}min",
    automationDiagHoursAgo: "il y a {n}h",
    automationDiagDaysAgo: "il y a {n}j",
    automationDiagLastErrorChip: "dernière erreur",
    automationDiagLastErrorTitle: "Dernière erreur : {error}",

    automationPresets: "Modèles",
    automationPresetsHint: "Partir d'une règle prête à l'emploi",
    automationEmptyTryPreset: "Aucune règle — choisissez un modèle ci-dessous pour démarrer, ou cliquez sur « Nouvelle règle » pour partir de zéro.",
    automationPresetTagPdfsName: "Étiqueter les PDFs comme Documents",
    automationPresetTagPdfsDesc: "Exécution manuelle · ajoute l'étiquette « Documents » à tous les PDFs d'un dossier.",
    automationPresetTagImagesName: "Étiqueter les images comme Photos",
    automationPresetTagImagesDesc: "Exécution manuelle · regex pour matcher jpg/png/webp/heic et leur ajouter l'étiquette « Photos ».",
    automationPresetArchiveScreenshotsName: "Archiver les vieilles captures d'écran",
    automationPresetArchiveScreenshotsDesc: "Exécution manuelle · met à la corbeille les fichiers Screenshot* de plus de 30 jours.",
    automationPresetOrganizePdfsName: "Organiser les nouveaux PDFs par année",
    automationPresetOrganizePdfsDesc: "À la création · déplace les nouveaux PDFs vers C:\\Archive\\{year}. Modifiez la destination avant d'enregistrer.",
    automationPresetCleanTmpName: "Nettoyer les .tmp de plus de 7 jours",
    automationPresetCleanTmpDesc: "Exécution manuelle · met à la corbeille les .tmp non touchés depuis une semaine.",

    automationDragToReorder: "Glisser pour réorganiser",

    gitLoading: "Chargement du statut git…",
    gitStaleHint: "L'index est verrouillé par un autre processus — données potentiellement périmées",
    gitAheadBehindTitle: "Commits en avance / en retard par rapport à la branche distante",
    gitChanges: "Modifications",
    gitBranches: "Branches",
    gitCommits: "Commits récents",
    gitNoChanges: "Aucune modification",
    gitNoBranches: "Aucune branche",
    gitNoCommits: "Aucun commit",
    gitJustNow: "à l'instant",
    gitMinutesAgo: "il y a {n}min",
    gitHoursAgo: "il y a {n}h",
    gitDaysAgo: "il y a {n}j",

    gitTabLabel: "Git",
    gitFileClean: "Propre — aucune modification non commitée",
    gitFileNotInRepo: "Ce fichier n'est pas dans un dépôt git.",
    gitFileDiffHeader: "Modifications vs HEAD",
    gitFileHistoryHeader: "Commits récents touchant ce fichier",
    gitFileNoHistory: "Aucun historique trouvé dans les 1000 derniers commits.",

    gitCollapse: "Replier le panneau git",
    gitExpand: "Déplier le panneau git",
    gitCurrentBranch: "Branche actuelle",
    gitClickToCheckout: "Cliquer pour basculer sur cette branche",
    gitRemoteBranchUnclickable: "Branche distante — utilisez votre client git pour la checkout",
    gitCheckoutConfirm: "Basculer sur la branche « {name} » ?\n\nVos fichiers sur le disque seront mis à jour. Les modifications non commitées bloqueront le changement.",
    gitCheckoutSuccess: "Basculé sur {name}",
    gitCheckoutFailed: "Impossible de changer de branche",

    commandPaletteContentBadge: "contenu",
    commandPaletteContentBadgeTitle: "Ce résultat correspond au contenu indexé du fichier, pas à son nom",

    previewExtractedText: "Texte extrait",

    diffCompareFiles: "Comparer les fichiers",
    diffCompareWithOtherPane: "Comparer avec l'autre pane",
    diffModeTooltip: "Basculer entre l'affichage par caractère (highlights intra-ligne) et par ligne (fond plein)",
    diffModeChar: "Char",
    diffModeLine: "Ligne",
    diffComparing: "Calcul du diff…",
    diffIdentical: "Les fichiers sont identiques",
    diffPrevHunk: "Changement précédent (Maj+F3)",
    diffNextHunk: "Changement suivant (F3)",
    diffFirstHunk: "Premier changement (Début)",
    diffLastHunk: "Dernier changement (Fin)",
  },
};

export function useTranslation(): AppStrings {
  const lang = useStore((s) => s.settings.language);
  return translations[lang] ?? translations.en;
}
