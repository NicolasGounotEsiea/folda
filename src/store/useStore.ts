import { create } from "zustand";
import type { FileEntry, ListEntry, Tag, Context, PinnedItem, ViewMode, LayoutMode, SavedView, TagStat } from "../types";
import { type AppSettings, DEFAULT_SETTINGS, applySettings } from "../utils/settings";

export type SelectedEntry =
  | { kind: "file"; entry: FileEntry }
  | { kind: "folder"; entry: ListEntry }
  | null;

export interface Tab {
  id: string; // file path — unique key
  file: FileEntry;
  isDirty: boolean;
  draftContent: string | null;    // current editor content (unsaved)
  originalContent: string | null; // content as loaded from disk
}

export interface FolderTab {
  id: string;
  path: string;
  isRemote?: boolean;
}

export interface ClipEntry {
  path: string;
  name: string;
  is_dir: boolean;
}

// Reconstruct a minimal Tab from a stored file path (content loads lazily on open)
export function pathToTab(path: string): Tab {
  const norm = path.replace(/\\/g, "/");
  const name = norm.split("/").filter(Boolean).pop() ?? path;
  const dotIdx = name.lastIndexOf(".");
  const extension = dotIdx > 0 ? name.slice(dotIdx + 1) : "";
  const file: FileEntry = { id: -1, path, name, extension, size: 0, created_at: 0, modified_at: 0, accessed_at: 0, tags: [] };
  return { id: path, file, isDirty: false, draftContent: null, originalContent: null };
}

interface AppStore {
  rootPaths: string[];
  currentPath: string;
  listEntries: ListEntry[];

  // Folder tabs (explorer tabs)
  folderTabs: FolderTab[];
  activeFolderTabId: string | null;
  openFolderTab: (path: string) => void;
  closeFolderTab: (id: string) => string | null; // returns path to navigate to, or null
  switchFolderTab: (id: string) => string;       // returns path of that tab

  // Navigation history
  navHistory: string[];
  navIndex: number;
  pushNav: (path: string) => void;
  stepBack: () => string | null;   // returns the path to load, or null
  stepForward: () => string | null;
  files: FileEntry[];
  selectedFile: FileEntry | null;
  selectedEntry: SelectedEntry;
  tags: Tag[];
  tagStats: TagStat[];
  savedViews: SavedView[];
  contexts: Context[];
  activeContextId: number | null;
  viewMode: ViewMode;
  layoutMode: LayoutMode;
  searchQuery: string;
  searchType: "all" | "files" | "folders";
  selectedTagIds: number[];
  isScanning: boolean;
  isWatching: boolean;

  // Live progress for the in-flight scan_directory call. Updated by the
  // `scan-progress` Tauri event listener in App.tsx and cleared when the scan
  // resolves. Lives in the store (not local Sidebar state) so the FileList
  // overlay can read it without prop-drilling through the layout.
  scanProgress: { path: string; scanned: number; done: boolean } | null;

  // Pinned items
  pinnedItems: PinnedItem[];
  setPinnedItems: (items: PinnedItem[]) => void;
  addPinnedItem: (item: PinnedItem) => void;
  removePinnedItem: (path: string) => void;

  // Command palette
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (v: boolean) => void;

  // Bulk rename
  bulkRenameOpen: boolean;
  setBulkRenameOpen: (v: boolean) => void;

  // Multi-select
  selectedPaths: string[];
  // Clipboard
  clipboard: { action: "copy" | "cut"; paths: string[]; isRemote: boolean; entries: ClipEntry[] } | null;
  // Sort
  sortBy: "name" | "size" | "modified" | "type";
  sortDir: "asc" | "desc";
  // Hidden files
  showHidden: boolean;

  // Tabs
  tabs: Tab[];
  activeTabId: string | null;
  openedFile: FileEntry | null; // derived: active tab's file

  addRootPath: (path: string) => void;
  removeRootPath: (path: string) => void;
  setRootPaths: (paths: string[]) => void;
  setCurrentPath: (path: string) => void;
  setListEntries: (entries: ListEntry[]) => void;
  setFiles: (files: FileEntry[]) => void;
  selectFile: (file: FileEntry | null) => void;
  selectEntry: (entry: SelectedEntry) => void;
  updateFolderTags: (path: string, tags: Tag[]) => void;
  setTags: (tags: Tag[]) => void;
  setTagStats: (stats: TagStat[]) => void;
  setSavedViews: (views: SavedView[]) => void;
  setContexts: (contexts: Context[]) => void;
  setActiveContext: (id: number) => void;
  // Workspace folder management
  addFolderToContext: (contextId: number, path: string) => void;
  removeFolderFromContext: (contextId: number, path: string) => void;
  renameContext: (contextId: number, name: string) => void;
  exitWorkspace: () => void;
  // Returns { paths, lastPath, tagIds } of the new workspace to load
  switchWorkspace: (contextId: number) => {
    paths: string[];
    lastPath: string;
    tagIds: number[];
  } | null;
  setViewMode: (mode: ViewMode) => void;
  setLayoutMode: (mode: LayoutMode) => void;
  setSearchQuery: (q: string) => void;
  setSearchType: (t: "all" | "files" | "folders") => void;
  toggleTagFilter: (tagId: number) => void;
  clearTagFilters: () => void;
  setIsScanning: (v: boolean) => void;
  setIsWatching: (v: boolean) => void;
  setScanProgress: (p: { path: string; scanned: number; done: boolean } | null) => void;

  setSelectedPaths: (paths: string[]) => void;
  setClipboard: (cb: { action: "copy" | "cut"; paths: string[]; isRemote: boolean; entries: ClipEntry[] } | null) => void;
  addRemoteFolderTabs: (rootPaths: string[]) => void;
  setSortBy: (col: "name" | "size" | "modified" | "type") => void;
  /// Set sort column AND direction explicitly (no toggle). Used to apply the
  /// user's saved Explorer defaults at startup — `setSortBy` toggles direction
  /// so it can't express "sort by size, descending" from a cold state.
  setSortExplicit: (col: "name" | "size" | "modified" | "type", dir: "asc" | "desc") => void;
  toggleShowHidden: () => void;
  setShowHidden: (v: boolean) => void;

  openFile: (file: FileEntry) => void;         // open or focus tab
  navigateFile: (file: FileEntry) => void;      // replace openedFile in current tab (gallery nav)
  closeFile: () => void;                        // close active tab
  closeTab: (id: string) => void;
  setActiveTab: (id: string | null) => void;   // null = explorer tab
  goToExplorer: () => void;                    // switch to explorer without closing tabs
  setTabDirty: (id: string, dirty: boolean) => void;
  updateTabCache: (id: string, draft: string, original: string) => void;
  setTabs: (tabs: Tab[]) => void;              // replace all file tabs (used on workspace restore)
  addFileTabToContext: (contextId: number, path: string) => void;

  updateFileTags: (fileId: number, tags: Tag[]) => void;
  removeFile: (path: string) => void;
  markFileModified: (path: string, timestamp: number) => void;

  // Settings
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;

  // Dual pane
  dualPaneActive: boolean;
  activePaneIndex: 0 | 1;
  pane2Path: string;
  pane2Entries: ListEntry[];
  pane2SelectedPaths: string[];
  pane2NavHistory: string[];
  pane2NavIndex: number;
  setDualPaneActive: (v: boolean) => void;
  setActivePaneIndex: (i: 0 | 1) => void;
  setPane2Path: (p: string) => void;
  setPane2Entries: (e: ListEntry[]) => void;
  setPane2SelectedPaths: (p: string[]) => void;
  pushNav2: (path: string) => void;
  stepBack2: () => string | null;
  stepForward2: () => string | null;

  // Tab reorder
  reorderFolderTabs: (fromIdx: number, toIdx: number) => void;
  reorderTabs: (fromIdx: number, toIdx: number) => void;
  tabOrder: Array<{ type: "folder" | "file"; id: string }>;
  reorderAllTabs: (from: number, to: number) => void;

  // Sharing
  sharingMode: "idle" | "hosting" | "joined";
  sharingCode: string | null;
  sharingPassword: string | null;
  sharingClients: string[];
  sharingContextId: number | null;
  sharingWorkspaceName: string | null;
  sharingWorkspaceIcon: string | null;
  remoteWorkspaceName: string | null;
  remoteRootPaths: string[];
  shareModalOpen: boolean;
  joinModalOpen: boolean;
  /// Automations modal — lifted to the store so the toast "Open" CTA from a
  /// rate-limited rule can open it from outside the Sidebar.
  automationsModalOpen: boolean;
  setSharingHosted: (code: string, password: string, workspaceName: string, workspaceIcon: string, contextId: number | null) => void;
  setSharingJoined: (workspaceName: string, rootPaths: string[]) => void;
  resetSharing: () => void;
  addSharingClient: (name: string) => void;
  removeSharingClient: (name: string) => void;
  setShareModalOpen: (v: boolean) => void;
  setJoinModalOpen: (v: boolean) => void;
  setAutomationsModalOpen: (v: boolean) => void;
  // Guest reconnection
  sharingGuestArgs: { code: string; password: string; displayName: string } | null;
  sharingReconnecting: boolean;
  setSharingGuestArgs: (args: { code: string; password: string; displayName: string } | null) => void;
  setSharingReconnecting: (v: boolean) => void;
}

function deriveOpenedFile(tabs: Tab[], activeTabId: string | null): FileEntry | null {
  return tabs.find((t) => t.id === activeTabId)?.file ?? null;
}

function closeTabLogic(
  tabs: Tab[],
  activeTabId: string | null,
  id: string
): { tabs: Tab[]; activeTabId: string | null; openedFile: FileEntry | null } {
  const idx = tabs.findIndex((t) => t.id === id);
  const newTabs = tabs.filter((t) => t.id !== id);
  let newActiveId = activeTabId;
  if (activeTabId === id) {
    newActiveId = newTabs[idx]?.id ?? newTabs[idx - 1]?.id ?? null;
  }
  return { tabs: newTabs, activeTabId: newActiveId, openedFile: deriveOpenedFile(newTabs, newActiveId) };
}

export const useStore = create<AppStore>((set, get) => ({
  rootPaths: [],
  currentPath: "",
  listEntries: [],
  folderTabs: [],
  activeFolderTabId: null,

  navHistory: [],
  navIndex: -1,
  pushNav: (path) =>
    set((s) => {
      const trimmed = s.navHistory.slice(0, s.navIndex + 1);
      // Don't push the same path twice in a row
      if (trimmed[trimmed.length - 1] === path) return {};
      return { navHistory: [...trimmed, path], navIndex: trimmed.length };
    }),
  stepBack: () => {
    const { navHistory, navIndex, activeFolderTabId, folderTabs } = get();
    const newIndex = navIndex - 1;
    if (newIndex < 0) return null;
    const path = navHistory[newIndex];
    const updatedTabs = activeFolderTabId
      ? folderTabs.map((t) => (t.id === activeFolderTabId ? { ...t, path } : t))
      : folderTabs;
    set({ navIndex: newIndex, currentPath: path, folderTabs: updatedTabs });
    return path;
  },
  stepForward: () => {
    const { navHistory, navIndex, activeFolderTabId, folderTabs } = get();
    const newIndex = navIndex + 1;
    if (newIndex >= navHistory.length) return null;
    const path = navHistory[newIndex];
    const updatedTabs = activeFolderTabId
      ? folderTabs.map((t) => (t.id === activeFolderTabId ? { ...t, path } : t))
      : folderTabs;
    set({ navIndex: newIndex, currentPath: path, folderTabs: updatedTabs });
    return path;
  },
  files: [],
  selectedFile: null,
  selectedEntry: null,
  tags: [],
  tagStats: [],
  savedViews: [],
  contexts: [],
  activeContextId: null,
  viewMode: "explorer",
  layoutMode: "list",
  searchQuery: "",
  searchType: "all",
  selectedTagIds: [],
  isScanning: false,
  isWatching: false,
  scanProgress: null,
  selectedPaths: [],
  clipboard: null,
  sortBy: "name",
  sortDir: "asc",
  showHidden: false,
  pinnedItems: [],
  commandPaletteOpen: false,
  bulkRenameOpen: false,
  tabs: [],
  activeTabId: null,
  openedFile: null,
  tabOrder: [],

  addRootPath: (path) =>
    set((s) => ({
      rootPaths: s.rootPaths.includes(path) ? s.rootPaths : [...s.rootPaths, path],
    })),
  removeRootPath: (path) =>
    set((s) => ({ rootPaths: s.rootPaths.filter((p) => p !== path) })),
  setRootPaths: (rootPaths) => set({ rootPaths }),
  setCurrentPath: (path) =>
    set((s) => {
      if (s.folderTabs.length === 0) {
        const id = `ft-${Date.now()}`;
        return { currentPath: path, folderTabs: [{ id, path }], activeFolderTabId: id, tabOrder: [...s.tabOrder, { type: "folder" as const, id }] };
      }
      return {
        currentPath: path,
        folderTabs: s.activeFolderTabId
          ? s.folderTabs.map((t) => (t.id === s.activeFolderTabId ? { ...t, path } : t))
          : s.folderTabs,
      };
    }),
  setListEntries: (newEntries) => set((s) => {
    // If a stale list_directory call (contextId=0) returns entries with no tags,
    // preserve the tags we already have for those same paths rather than wiping them.
    const tagCache = new Map(s.listEntries.map((e) => [e.path, e.tags]));
    const merged = newEntries.map((e) => {
      const cached = tagCache.get(e.path);
      return cached && cached.length > 0 && e.tags.length === 0 ? { ...e, tags: cached } : e;
    });
    return { listEntries: merged };
  }),

  openFolderTab: (path) =>
    set((s) => {
      const id = `ft-${Date.now()}`;
      return { folderTabs: [...s.folderTabs, { id, path }], activeFolderTabId: id, currentPath: path, tabOrder: [...s.tabOrder, { type: "folder" as const, id }] };
    }),

  closeFolderTab: (id) => {
    const s = get();
    const idx = s.folderTabs.findIndex((t) => t.id === id);
    const newTabs = s.folderTabs.filter((t) => t.id !== id);
    const newTabOrder = s.tabOrder.filter((e) => !(e.type === "folder" && e.id === id));
    if (newTabs.length === 0) {
      set({ folderTabs: [], activeFolderTabId: null, currentPath: "", tabOrder: newTabOrder });
      return null;
    }
    if (s.activeFolderTabId !== id) {
      set({ folderTabs: newTabs, tabOrder: newTabOrder });
      return null;
    }
    const nextTab = newTabs[idx] ?? newTabs[idx - 1];
    set({ folderTabs: newTabs, activeFolderTabId: nextTab.id, currentPath: nextTab.path, tabOrder: newTabOrder });
    return nextTab.path;
  },

  switchFolderTab: (id) => {
    const s = get();
    const tab = s.folderTabs.find((t) => t.id === id);
    if (!tab) return s.currentPath;
    set({ activeFolderTabId: id, currentPath: tab.path });
    return tab.path;
  },
  setFiles: (files) => set({ files }),
  selectFile: (selectedFile) => set({ selectedFile, selectedEntry: selectedFile ? { kind: "file", entry: selectedFile } : null }),
  selectEntry: (selectedEntry) => set({
    selectedEntry,
    selectedFile: selectedEntry?.kind === "file" ? selectedEntry.entry : null,
  }),
  updateFolderTags: (path, tags) =>
    set((s) => ({
      listEntries: s.listEntries.map((e) => e.path === path ? { ...e, tags } : e),
      selectedEntry: s.selectedEntry?.kind === "folder" && s.selectedEntry.entry.path === path
        ? { kind: "folder", entry: { ...s.selectedEntry.entry, tags } }
        : s.selectedEntry,
    })),
  setTags: (tags) => set({ tags }),
  setTagStats: (tagStats) => set({ tagStats }),
  setSavedViews: (savedViews) => set({ savedViews }),
  setContexts: (contexts) => set((s) => {
    // Prefer DB-active context, then already-active in store, then null (global mode)
    const active = contexts.find((c) => c.is_active)
      ?? contexts.find((c) => c.id === s.activeContextId)
      ?? null;
    return {
      contexts,
      activeContextId: active?.id ?? null,
      rootPaths: active?.watched_paths ?? [],
    };
  }),
  setActiveContext: (id) => set({ activeContextId: id }),
  exitWorkspace: () => set({ activeContextId: null, rootPaths: [], selectedTagIds: [] }),

  addFolderToContext: (contextId, path) =>
    set((s) => {
      const contexts = s.contexts.map((c) =>
        c.id === contextId && !c.watched_paths.includes(path)
          ? { ...c, watched_paths: [...c.watched_paths, path] }
          : c
      );
      const rootPaths = [...new Set(contexts.flatMap((c) => c.watched_paths))];
      return { contexts, rootPaths };
    }),

  removeFolderFromContext: (contextId, path) =>
    set((s) => {
      const contexts = s.contexts.map((c) =>
        c.id === contextId
          ? { ...c, watched_paths: c.watched_paths.filter((p) => p !== path) }
          : c
      );
      const rootPaths = [...new Set(contexts.flatMap((c) => c.watched_paths))];
      return { contexts, rootPaths };
    }),

  renameContext: (contextId, name) =>
    set((s) => ({
      contexts: s.contexts.map((c) => c.id === contextId ? { ...c, name } : c),
    })),

  switchWorkspace: (contextId) => {
    const s = get();
    const target = s.contexts.find((c) => c.id === contextId);
    if (!target) return null;

    // Snapshot current workspace state (will be merged into the single set() below)
    const current = s.contexts.find((c) => c.id === s.activeContextId);
    const updatedCurrent = current ? {
      ...current,
      last_path: s.currentPath,
      pinned_tag_ids: s.selectedTagIds,
      open_tabs: s.folderTabs.map((t) => t.path),
      open_file_tabs: s.tabs.map((t) => t.id),
    } : null;

    // Restore target workspace's folder tabs
    const tabPaths: string[] = target.open_tabs ?? [];
    const restoredFolderTabs: FolderTab[] = tabPaths.map((path, i) => ({ id: `ft-${Date.now()}-${i}`, path }));

    const activePath = target.last_path
      || restoredFolderTabs[restoredFolderTabs.length - 1]?.path
      || target.watched_paths[0]
      || "";

    const finalFolderTabs: FolderTab[] = restoredFolderTabs.length > 0
      ? restoredFolderTabs
      : activePath ? [{ id: `ft-${Date.now()}`, path: activePath }] : [];

    const activeFolderTabId = finalFolderTabs.find((t) => t.path === activePath)?.id
      ?? finalFolderTabs[finalFolderTabs.length - 1]?.id
      ?? null;

    // Restore target workspace's file tabs
    const restoredFileTabs: Tab[] = (target.open_file_tabs ?? []).map(pathToTab);

    // Single set() to save current + restore target — avoids double re-render
    set((st) => ({
      contexts: updatedCurrent
        ? st.contexts.map((c) => c.id === updatedCurrent.id ? updatedCurrent : c)
        : st.contexts,
      activeContextId: contextId,
      rootPaths: target.watched_paths,
      selectedTagIds: target.pinned_tag_ids,
      folderTabs: finalFolderTabs,
      activeFolderTabId,
      currentPath: activePath,
      tabs: restoredFileTabs,
      activeTabId: null,
      openedFile: null,
      tabOrder: [
        ...finalFolderTabs.map((t) => ({ type: "folder" as const, id: t.id })),
        ...restoredFileTabs.map((t) => ({ type: "file" as const, id: t.id })),
      ],
    }));

    return {
      paths: target.watched_paths,
      lastPath: activePath,
      tagIds: target.pinned_tag_ids,
    };
  },
  setViewMode: (viewMode) => set({ viewMode }),
  setLayoutMode: (layoutMode) => set({ layoutMode }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSearchType: (searchType) => set({ searchType }),
  toggleTagFilter: (tagId) =>
    set((s) => ({
      selectedTagIds: s.selectedTagIds.includes(tagId)
        ? s.selectedTagIds.filter((id) => id !== tagId)
        : [...s.selectedTagIds, tagId],
    })),
  clearTagFilters: () => set({ selectedTagIds: [] }),
  setIsScanning: (isScanning) => set({ isScanning }),
  setIsWatching: (isWatching) => set({ isWatching }),
  setScanProgress: (scanProgress) => set({ scanProgress }),

  // Dual pane state
  dualPaneActive: false,
  activePaneIndex: 0,
  pane2Path: "",
  pane2Entries: [],
  pane2SelectedPaths: [],
  pane2NavHistory: [],
  pane2NavIndex: -1,
  setDualPaneActive: (v) => set((s) => {
    if (v && !s.dualPaneActive) {
      return {
        dualPaneActive: true,
        pane2Path: s.currentPath,
        pane2Entries: [...s.listEntries],
        pane2NavHistory: s.currentPath ? [s.currentPath] : [],
        pane2NavIndex: s.currentPath ? 0 : -1,
      };
    }
    return { dualPaneActive: v };
  }),
  setActivePaneIndex: (activePaneIndex) => set({ activePaneIndex }),
  setPane2Path: (pane2Path) => set({ pane2Path }),
  setPane2Entries: (pane2Entries) => set({ pane2Entries }),
  setPane2SelectedPaths: (pane2SelectedPaths) => set({ pane2SelectedPaths }),
  pushNav2: (path) =>
    set((s) => {
      const trimmed = s.pane2NavHistory.slice(0, s.pane2NavIndex + 1);
      if (trimmed[trimmed.length - 1] === path) return {};
      return { pane2NavHistory: [...trimmed, path], pane2NavIndex: trimmed.length };
    }),
  stepBack2: () => {
    const { pane2NavHistory, pane2NavIndex } = get();
    const newIndex = pane2NavIndex - 1;
    if (newIndex < 0) return null;
    const path = pane2NavHistory[newIndex];
    set({ pane2NavIndex: newIndex, pane2Path: path });
    return path;
  },
  stepForward2: () => {
    const { pane2NavHistory, pane2NavIndex } = get();
    const newIndex = pane2NavIndex + 1;
    if (newIndex >= pane2NavHistory.length) return null;
    const path = pane2NavHistory[newIndex];
    set({ pane2NavIndex: newIndex, pane2Path: path });
    return path;
  },

  reorderFolderTabs: (fromIdx, toIdx) => set((s) => {
    const tabs = [...s.folderTabs];
    const [moved] = tabs.splice(fromIdx, 1);
    tabs.splice(toIdx, 0, moved);
    return { folderTabs: tabs };
  }),

  reorderTabs: (fromIdx, toIdx) => set((s) => {
    const tabs = [...s.tabs];
    const [moved] = tabs.splice(fromIdx, 1);
    tabs.splice(toIdx, 0, moved);
    return { tabs };
  }),

  reorderAllTabs: (from, to) => set((s) => {
    const order = [...s.tabOrder];
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    // Keep folderTabs and tabs arrays in the same relative order as tabOrder
    const folderTabs = order.filter((e) => e.type === "folder").map((e) => s.folderTabs.find((t) => t.id === e.id)!).filter(Boolean);
    const tabs = order.filter((e) => e.type === "file").map((e) => s.tabs.find((t) => t.id === e.id)!).filter(Boolean);
    return { tabOrder: order, folderTabs, tabs };
  }),

  setPinnedItems: (pinnedItems) => set({ pinnedItems }),
  addPinnedItem: (item) =>
    set((s) => ({
      pinnedItems: s.pinnedItems.some((p) => p.path === item.path)
        ? s.pinnedItems
        : [item, ...s.pinnedItems],
    })),
  removePinnedItem: (path) =>
    set((s) => ({ pinnedItems: s.pinnedItems.filter((p) => p.path !== path) })),
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
  setBulkRenameOpen: (bulkRenameOpen) => set({ bulkRenameOpen }),

  setSelectedPaths: (selectedPaths) => set({ selectedPaths }),
  setClipboard: (clipboard) => set({ clipboard }),

  addRemoteFolderTabs: (rootPaths) =>
    set((s) => {
      const newTabs: FolderTab[] = rootPaths.map((path, i) => ({
        id: `ft-remote-${Date.now()}-${i}`,
        path,
        isRemote: true,
      }));
      const localTabs = s.folderTabs.filter((t) => !t.isRemote);
      const allTabs = [...localTabs, ...newTabs];
      const firstRemote = newTabs[0];
      const oldRemoteIds = new Set(s.folderTabs.filter((t) => t.isRemote).map((t) => t.id));
      const newTabOrder = [
        ...s.tabOrder.filter((e) => !(e.type === "folder" && oldRemoteIds.has(e.id))),
        ...newTabs.map((t) => ({ type: "folder" as const, id: t.id })),
      ];
      return {
        folderTabs: allTabs,
        activeFolderTabId: firstRemote?.id ?? s.activeFolderTabId,
        currentPath: firstRemote?.path ?? s.currentPath,
        tabOrder: newTabOrder,
      };
    }),
  setSortBy: (col) =>
    set((s) => ({
      sortBy: col,
      sortDir: s.sortBy === col ? (s.sortDir === "asc" ? "desc" : "asc") : "asc",
    })),
  setSortExplicit: (col, dir) => set({ sortBy: col, sortDir: dir }),
  toggleShowHidden: () => set((s) => ({ showHidden: !s.showHidden })),
  setShowHidden: (v) => set({ showHidden: v }),

  openFile: (file) =>
    set((s) => {
      const id = file.path;
      if (s.tabs.find((t) => t.id === id)) {
        return { activeTabId: id, openedFile: file };
      }
      const newTabs = [...s.tabs, { id, file, isDirty: false, draftContent: null, originalContent: null }];
      return { tabs: newTabs, activeTabId: id, openedFile: file, tabOrder: [...s.tabOrder, { type: "file" as const, id }] };
    }),

  navigateFile: (file) =>
    set((s) => {
      if (s.activeTabId === null) return {};
      const oldId = s.activeTabId;
      const tabs = s.tabs.map((t) =>
        t.id === s.activeTabId ? { ...t, id: file.path, file } : t
      );
      return {
        tabs,
        activeTabId: file.path,
        openedFile: file,
        tabOrder: s.tabOrder.map((e) => e.type === "file" && e.id === oldId ? { ...e, id: file.path } : e),
      };
    }),

  closeFile: () =>
    set((s) => {
      if (!s.activeTabId) return {};
      const removedId = s.activeTabId;
      const result = closeTabLogic(s.tabs, s.activeTabId, s.activeTabId);
      const contexts = s.activeContextId !== null
        ? s.contexts.map((c) => c.id === s.activeContextId
            ? { ...c, open_file_tabs: result.tabs.map((t) => t.id) }
            : c)
        : s.contexts;
      return { ...result, contexts, tabOrder: s.tabOrder.filter((e) => !(e.type === "file" && e.id === removedId)) };
    }),

  closeTab: (id) => {
    try { localStorage.removeItem(`nxs_draft:${id}`); } catch { /* ignore */ }
    set((s) => {
      const result = closeTabLogic(s.tabs, s.activeTabId, id);
      const contexts = s.activeContextId !== null
        ? s.contexts.map((c) => c.id === s.activeContextId
            ? { ...c, open_file_tabs: result.tabs.map((t) => t.id) }
            : c)
        : s.contexts;
      return { ...result, contexts, tabOrder: s.tabOrder.filter((e) => !(e.type === "file" && e.id === id)) };
    });
  },

  setActiveTab: (id) =>
    set((s) => ({
      activeTabId: id,
      openedFile: id === null ? null : deriveOpenedFile(s.tabs, id),
    })),

  goToExplorer: () => set({ activeTabId: null, openedFile: null }),

  setTabDirty: (id, dirty) => {
    if (!dirty) {
      try { localStorage.removeItem(`nxs_draft:${id}`); } catch { /* ignore */ }
    }
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, isDirty: dirty } : t)),
    }));
  },

  updateTabCache: (id, draft, original) => {
    // Persist unsaved draft so it survives crashes
    if (draft !== original) {
      try { localStorage.setItem(`nxs_draft:${id}`, draft); } catch { /* quota */ }
    } else {
      try { localStorage.removeItem(`nxs_draft:${id}`); } catch { /* ignore */ }
    }
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? { ...t, draftContent: draft, originalContent: original, isDirty: draft !== original }
          : t
      ),
    }));
  },

  setTabs: (tabs) => set((s) => ({
    tabs,
    activeTabId: null,
    openedFile: null,
    tabOrder: [
      ...s.tabOrder.filter((e) => e.type === "folder"),
      ...tabs.map((t) => ({ type: "file" as const, id: t.id })),
    ],
  })),

  addFileTabToContext: (contextId, path) =>
    set((s) => ({
      contexts: s.contexts.map((c) =>
        c.id === contextId && !(c.open_file_tabs ?? []).includes(path)
          ? { ...c, open_file_tabs: [...(c.open_file_tabs ?? []), path] }
          : c
      ),
    })),

  removeFile: (path) =>
    set((s) => {
      const base = {
        listEntries: s.listEntries.filter((e) => e.path !== path),
        selectedFile: s.selectedFile?.path === path ? null : s.selectedFile,
      };
      if (s.tabs.find((t) => t.id === path)) {
        return { ...base, ...closeTabLogic(s.tabs, s.activeTabId, path) };
      }
      return base;
    }),

  markFileModified: (path, timestamp) =>
    set((s) => ({
      listEntries: s.listEntries.map((e) =>
        e.path === path ? { ...e, modified_at: timestamp } : e
      ),
    })),

  // Settings state
  settings: DEFAULT_SETTINGS,
  updateSettings: (patch) =>
    set((s) => {
      const next = { ...s.settings, ...patch };
      applySettings(next);
      return { settings: next };
    }),

  // Sharing state
  sharingMode: "idle",
  sharingCode: null,
  sharingPassword: null,
  sharingClients: [],
  sharingContextId: null,
  sharingWorkspaceName: null,
  sharingWorkspaceIcon: null,
  remoteWorkspaceName: null,
  remoteRootPaths: [],
  shareModalOpen: false,
  joinModalOpen: false,
  automationsModalOpen: false,

  setSharingHosted: (code, password, workspaceName, workspaceIcon, contextId) =>
    set({ sharingMode: "hosting", sharingCode: code, sharingPassword: password, sharingClients: [], sharingContextId: contextId, sharingWorkspaceName: workspaceName, sharingWorkspaceIcon: workspaceIcon }),
  setSharingJoined: (workspaceName, rootPaths) =>
    set({ sharingMode: "joined", remoteWorkspaceName: workspaceName, remoteRootPaths: rootPaths }),
  resetSharing: () =>
    set({ sharingMode: "idle", sharingCode: null, sharingPassword: null, sharingClients: [], sharingContextId: null, sharingWorkspaceName: null, sharingWorkspaceIcon: null, remoteWorkspaceName: null, remoteRootPaths: [], sharingGuestArgs: null, sharingReconnecting: false }),
  addSharingClient: (name) =>
    set((s) => ({ sharingClients: s.sharingClients.includes(name) ? s.sharingClients : [...s.sharingClients, name] })),
  removeSharingClient: (name) =>
    set((s) => ({ sharingClients: s.sharingClients.filter((n) => n !== name) })),
  setShareModalOpen: (shareModalOpen) => set({ shareModalOpen }),
  setJoinModalOpen: (joinModalOpen) => set({ joinModalOpen }),
  setAutomationsModalOpen: (automationsModalOpen) => set({ automationsModalOpen }),
  sharingGuestArgs: null,
  sharingReconnecting: false,
  setSharingGuestArgs: (sharingGuestArgs) => set({ sharingGuestArgs }),
  setSharingReconnecting: (sharingReconnecting) => set({ sharingReconnecting }),

  updateFileTags: (fileId, tags) =>
    set((s) => ({
      listEntries: s.listEntries.map((e) =>
        e.id === fileId ? { ...e, tags } : e
      ),
      selectedFile:
        s.selectedFile?.id === fileId ? { ...s.selectedFile, tags } : s.selectedFile,
    })),
}));
