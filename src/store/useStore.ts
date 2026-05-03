import { create } from "zustand";
import type { FileEntry, ListEntry, Tag, Context, PinnedItem, ViewMode, LayoutMode } from "../types";

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
  contexts: Context[];
  activeContextId: number | null;
  viewMode: ViewMode;
  layoutMode: LayoutMode;
  searchQuery: string;
  searchType: "all" | "files" | "folders";
  selectedTagIds: number[];
  isScanning: boolean;
  isWatching: boolean;

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
  setContexts: (contexts: Context[]) => void;
  setActiveContext: (id: number) => void;
  // Workspace folder management
  addFolderToContext: (contextId: number, path: string) => void;
  removeFolderFromContext: (contextId: number, path: string) => void;
  renameContext: (contextId: number, name: string) => void;
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

  setSelectedPaths: (paths: string[]) => void;
  setClipboard: (cb: { action: "copy" | "cut"; paths: string[]; isRemote: boolean; entries: ClipEntry[] } | null) => void;
  addRemoteFolderTabs: (rootPaths: string[]) => void;
  setSortBy: (col: "name" | "size" | "modified" | "type") => void;
  toggleShowHidden: () => void;

  openFile: (file: FileEntry) => void;         // open or focus tab
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

  // Sharing
  sharingMode: "idle" | "hosting" | "joined";
  sharingCode: string | null;
  sharingPassword: string | null;
  sharingClients: string[];
  remoteWorkspaceName: string | null;
  remoteRootPaths: string[];
  shareModalOpen: boolean;
  joinModalOpen: boolean;
  setSharingHosted: (code: string, password: string) => void;
  setSharingJoined: (workspaceName: string, rootPaths: string[]) => void;
  resetSharing: () => void;
  addSharingClient: (name: string) => void;
  removeSharingClient: (name: string) => void;
  setShareModalOpen: (v: boolean) => void;
  setJoinModalOpen: (v: boolean) => void;
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
    const { navHistory, navIndex } = get();
    const newIndex = navIndex - 1;
    if (newIndex < 0) return null;
    set({ navIndex: newIndex, currentPath: navHistory[newIndex] });
    return navHistory[newIndex];
  },
  stepForward: () => {
    const { navHistory, navIndex } = get();
    const newIndex = navIndex + 1;
    if (newIndex >= navHistory.length) return null;
    set({ navIndex: newIndex, currentPath: navHistory[newIndex] });
    return navHistory[newIndex];
  },
  files: [],
  selectedFile: null,
  selectedEntry: null,
  tags: [],
  contexts: [],
  activeContextId: null,
  viewMode: "explorer",
  layoutMode: "list",
  searchQuery: "",
  searchType: "all",
  selectedTagIds: [],
  isScanning: false,
  isWatching: false,
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
        return { currentPath: path, folderTabs: [{ id, path }], activeFolderTabId: id };
      }
      return {
        currentPath: path,
        folderTabs: s.activeFolderTabId
          ? s.folderTabs.map((t) => (t.id === s.activeFolderTabId ? { ...t, path } : t))
          : s.folderTabs,
      };
    }),
  setListEntries: (listEntries) => set({ listEntries }),

  openFolderTab: (path) =>
    set((s) => {
      const id = `ft-${Date.now()}`;
      return { folderTabs: [...s.folderTabs, { id, path }], activeFolderTabId: id, currentPath: path };
    }),

  closeFolderTab: (id) => {
    const s = get();
    const idx = s.folderTabs.findIndex((t) => t.id === id);
    const newTabs = s.folderTabs.filter((t) => t.id !== id);
    if (newTabs.length === 0) {
      set({ folderTabs: [], activeFolderTabId: null, currentPath: "" });
      return null;
    }
    if (s.activeFolderTabId !== id) {
      set({ folderTabs: newTabs });
      return null;
    }
    const nextTab = newTabs[idx] ?? newTabs[idx - 1];
    set({ folderTabs: newTabs, activeFolderTabId: nextTab.id, currentPath: nextTab.path });
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
  setContexts: (contexts) => set((s) => {
    // Active workspace = the one marked is_active in DB, or the current activeContextId, or first
    const active = contexts.find((c) => c.is_active)
      ?? contexts.find((c) => c.id === s.activeContextId)
      ?? contexts[0];
    return {
      contexts,
      activeContextId: active?.id ?? null,
      rootPaths: active?.watched_paths ?? [],
    };
  }),
  setActiveContext: (id) => set({ activeContextId: id }),

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

    // Save current workspace state
    const current = s.contexts.find((c) => c.id === s.activeContextId);
    if (current) {
      const updated = {
        ...current,
        last_path: s.currentPath,
        pinned_tag_ids: s.selectedTagIds,
        open_tabs: s.folderTabs.map((t) => t.path),
        open_file_tabs: s.tabs.map((t) => t.id),
      };
      set((st) => ({
        contexts: st.contexts.map((c) => c.id === current.id ? updated : c),
      }));
    }

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

    set({
      activeContextId: contextId,
      rootPaths: target.watched_paths,
      selectedTagIds: target.pinned_tag_ids,
      folderTabs: finalFolderTabs,
      activeFolderTabId,
      currentPath: activePath,
      tabs: restoredFileTabs,
      activeTabId: null,
      openedFile: null,
    });

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
      // Remove stale remote tabs before adding fresh ones
      const localTabs = s.folderTabs.filter((t) => !t.isRemote);
      const allTabs = [...localTabs, ...newTabs];
      // Activate first remote tab
      const firstRemote = newTabs[0];
      return {
        folderTabs: allTabs,
        activeFolderTabId: firstRemote?.id ?? s.activeFolderTabId,
        currentPath: firstRemote?.path ?? s.currentPath,
      };
    }),
  setSortBy: (col) =>
    set((s) => ({
      sortBy: col,
      sortDir: s.sortBy === col ? (s.sortDir === "asc" ? "desc" : "asc") : "asc",
    })),
  toggleShowHidden: () => set((s) => ({ showHidden: !s.showHidden })),

  openFile: (file) =>
    set((s) => {
      const id = file.path;
      if (s.tabs.find((t) => t.id === id)) {
        return { activeTabId: id, openedFile: file };
      }
      const newTabs = [...s.tabs, { id, file, isDirty: false, draftContent: null, originalContent: null }];
      return { tabs: newTabs, activeTabId: id, openedFile: file };
    }),

  closeFile: () =>
    set((s) => {
      if (!s.activeTabId) return {};
      return closeTabLogic(s.tabs, s.activeTabId, s.activeTabId);
    }),

  closeTab: (id) =>
    set((s) => closeTabLogic(s.tabs, s.activeTabId, id)),

  setActiveTab: (id) =>
    set((s) => ({
      activeTabId: id,
      openedFile: id === null ? null : deriveOpenedFile(s.tabs, id),
    })),

  goToExplorer: () => set({ activeTabId: null, openedFile: null }),

  setTabDirty: (id, dirty) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, isDirty: dirty } : t)),
    })),

  updateTabCache: (id, draft, original) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? { ...t, draftContent: draft, originalContent: original, isDirty: draft !== original }
          : t
      ),
    })),

  setTabs: (tabs) => set({ tabs, activeTabId: null, openedFile: null }),

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

  // Sharing state
  sharingMode: "idle",
  sharingCode: null,
  sharingPassword: null,
  sharingClients: [],
  remoteWorkspaceName: null,
  remoteRootPaths: [],
  shareModalOpen: false,
  joinModalOpen: false,

  setSharingHosted: (code, password) =>
    set({ sharingMode: "hosting", sharingCode: code, sharingPassword: password, sharingClients: [] }),
  setSharingJoined: (workspaceName, rootPaths) =>
    set({ sharingMode: "joined", remoteWorkspaceName: workspaceName, remoteRootPaths: rootPaths }),
  resetSharing: () =>
    set({ sharingMode: "idle", sharingCode: null, sharingPassword: null, sharingClients: [], remoteWorkspaceName: null, remoteRootPaths: [] }),
  addSharingClient: (name) =>
    set((s) => ({ sharingClients: s.sharingClients.includes(name) ? s.sharingClients : [...s.sharingClients, name] })),
  removeSharingClient: (name) =>
    set((s) => ({ sharingClients: s.sharingClients.filter((n) => n !== name) })),
  setShareModalOpen: (shareModalOpen) => set({ shareModalOpen }),
  setJoinModalOpen: (joinModalOpen) => set({ joinModalOpen }),

  updateFileTags: (fileId, tags) =>
    set((s) => ({
      listEntries: s.listEntries.map((e) =>
        e.id === fileId ? { ...e, tags } : e
      ),
      selectedFile:
        s.selectedFile?.id === fileId ? { ...s.selectedFile, tags } : s.selectedFile,
    })),
}));
