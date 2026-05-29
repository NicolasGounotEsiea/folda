import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState } from "react";
import { saveAndClose, isClosing } from "./utils/appClose";
import { BulkRename } from "./components/BulkRename";
import { CommandPalette } from "./components/CommandPalette";
import { DocumentViewer } from "./components/DocumentViewer";
import { EditorView } from "./components/EditorView";
import { FileList } from "./components/FileList";
import { MediaViewer } from "./components/MediaViewer";
import { ArchiveViewer } from "./components/ArchiveViewer";
import { AUDIO_EXTS, IMAGE_EXTS, VIDEO_EXTS, DOC_EXTS, ARCHIVE_EXTS } from "./utils/fileExtensions";
import { PreviewPanel } from "./components/PreviewPanel";
import { ProgressOverlay } from "./components/ProgressOverlay";
import { AiPanel } from "./components/AiPanel";
import { DiskUsageModal } from "./components/DiskUsageModal";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { Titlebar } from "./components/Titlebar";
import { Toolbar } from "./components/Toolbar";
import { useStore, pathToTab } from "./store/useStore";
import type { Context, FileEntry, ListEntry, Tag } from "./types";
import { TimelineView } from "./views/TimelineView";
import { SettingsModal } from "./components/SettingsModal";
import { deserializeSettings, applySettings } from "./utils/settings";
import { telemetryInit } from "./utils/telemetry";
import { KeyboardShortcutsModal } from "./components/KeyboardShortcutsModal";
import { OnboardingModal } from "./components/OnboardingModal";
import { ToastContainer } from "./components/ToastContainer";
import { useToastStore } from "./store/useToastStore";

interface FileChangedPayload {
  path: string;
  name: string;
  action: "created" | "modified" | "deleted";
  timestamp: number;
}

interface WindowInitData {
  mode: "folder" | "file";
  path: string;
  name?: string | null;
  ext?: string | null;
}

export function App() {
  const {
    viewMode, currentPath, openedFile,
    setCurrentPath, setListEntries,
    setFiles, setTags, removeFile, markFileModified,
    setIsWatching, setIsScanning,
    pushNav, stepBack, stepForward, selectEntry,
    commandPaletteOpen, setCommandPaletteOpen,
    bulkRenameOpen, setBulkRenameOpen,
    selectedPaths, listEntries,
    setContexts, setTabs,
    sharingMode, addSharingClient, removeSharingClient, resetSharing,
    sharingGuestArgs, setSharingJoined, setSharingReconnecting,
    updateSettings, setShowHidden, openFile, settings,
    dualPaneActive, setDualPaneActive,
    activePaneIndex, stepBack2, stepForward2, setPane2Entries,
    activeContextId,
  } = useStore();

  // Ref so async callbacks always read the current contextId without stale closures
  const activeContextIdRef = useRef(activeContextId);
  useEffect(() => { activeContextIdRef.current = activeContextId; }, [activeContextId]);

  const addToast = useToastStore((s) => s.addToast);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watcherDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Null = main window, set = popup window with init data.
  // IS_POPUP is stable: the window label never changes after creation.
  const IS_POPUP = getCurrentWindow().label !== "main";
  const [popupInit, setPopupInit] = useState<WindowInitData | null>(null);

  // Restore last session
  useEffect(() => {
    const restore = async () => {
      // ── Popup-window detection ────────────────────────────────────────────
      // Non-main windows receive init data via get_window_init_data.
      // TEAR-OUT HOOK: when a tab is torn out and a new window is created,
      // that window goes through this same path — no extra code needed here.
      const winLabel = getCurrentWindow().label;
      if (winLabel !== "main") {
        // Non-main windows never run the normal workspace restore — always return here.
        // get_window_init_data is non-destructive (leaves data in the map) so this is
        // safe even when React Strict Mode invokes the effect twice.
        const initData = await invoke<WindowInitData | null>(
          "get_window_init_data", { label: winLabel }
        ).catch(() => null);

        if (initData && !popupInit) {
          setPopupInit(initData);
          const rawSettings = await invoke<Record<string, string>>("get_all_settings").catch(() => ({} as Record<string, string>));
          const loaded = deserializeSettings(rawSettings);
          updateSettings(loaded);
          applySettings(loaded);

          if (initData.mode === "folder") {
            setCurrentPath(initData.path);
            pushNav(initData.path);
            const entries = await invoke<ListEntry[]>("list_directory", { path: initData.path, contextId: 0 }).catch(() => [] as ListEntry[]);
            setListEntries(entries);
          } else if (initData.mode === "file") {
            const name = initData.name ?? initData.path.replace(/\\/g, "/").split("/").pop() ?? "";
            // Open the file immediately so the viewer renders on first paint
            openFile({ id: -1, path: initData.path, name, extension: initData.ext ?? "", size: 0, created_at: 0, modified_at: 0, accessed_at: 0, tags: [] });
            // Load the parent folder in the background so MediaViewer has sibling
            // images for prev/next navigation
            const norm = initData.path.replace(/\\/g, "/");
            const parentPath = norm.split("/").slice(0, -1).join("/");
            if (parentPath) {
              setCurrentPath(parentPath);
              invoke<ListEntry[]>("list_directory", { path: parentPath, contextId: 0 })
                .then(setListEntries)
                .catch(() => {});
            }
          }
        }
        return; // always skip normal workspace restore for non-main windows
      }
      // Load contexts — they are the source of truth for folders
      let ctxs = await invoke<Context[]>("get_contexts").catch(() => [] as Context[]);

      // Migration: if no contexts exist but watched_paths do, create a Default workspace
      if (ctxs.length === 0) {
        const legacy = await invoke<string[]>("get_watched_paths").catch(() => [] as string[]);
        if (legacy.length > 0) {
          const id = await invoke<number>("create_context", { name: "Default", icon: "📁" }).catch(() => null);
          if (id !== null) {
            await invoke("update_context", {
              id, name: "Default", icon: "📁",
              watchedPaths: legacy, lastPath: legacy[0],
              activeTagIds: [], openTabs: [], openFileTabs: [],
            }).catch(console.error);
          }
          ctxs = await invoke<Context[]>("get_contexts").catch(() => [] as Context[]);
        }
      }

      // Load and apply persisted settings
      const rawSettings = await invoke<Record<string, string>>("get_all_settings").catch(() => ({} as Record<string, string>));
      const loadedSettings = deserializeSettings(rawSettings);
      updateSettings(loadedSettings);
      applySettings(loadedSettings);
      if (loadedSettings.showHiddenDefault) setShowHidden(true);
      if (!loadedSettings.hasSeenOnboarding) setOnboardingOpen(true);

      setContexts(ctxs); // sets activeContextId + rootPaths from DB-active workspace

      const activeCtx = ctxs.find((c) => c.is_active) ?? null;
      const ctxId = activeCtx?.id ?? 0;

      if (!ctxs.length) {
        // No workspaces — global mode: navigate to home directory
        const homeDir = await invoke<string>("get_home_dir").catch(() => "C:\\Users");
        setCurrentPath(homeDir);
        pushNav(homeDir);
        const entries = await invoke<ListEntry[]>("list_directory", { path: homeDir, contextId: 0 }).catch(() => [] as ListEntry[]);
        setListEntries(entries);
        return;
      }

      // Restore active workspace's file tabs, hydrating any crash-saved drafts
      if (activeCtx?.open_file_tabs?.length) {
        const restoredTabs = activeCtx.open_file_tabs.map((path) => {
          const tab = pathToTab(path);
          try {
            const saved = localStorage.getItem(`nxs_draft:${path}`);
            if (saved) return { ...tab, draftContent: saved, isDirty: true };
          } catch { /* ignore */ }
          return tab;
        });
        setTabs(restoredTabs);
        const recovered = restoredTabs.filter((t) => t.isDirty).length;
        if (recovered > 0) {
          addToast({
            type: "warning",
            message: `${recovered} unsaved file${recovered > 1 ? "s" : ""} recovered`,
            detail: "Your changes from the last session were restored.",
          });
        }
      }

      // If launched from Windows shell context menu, navigate there directly
      const launchPath = await invoke<string | null>("get_launch_path").catch(() => null);
      if (launchPath) {
        const isDir = !launchPath.includes(".") || launchPath.endsWith("\\") || launchPath.endsWith("/");
        const targetDir = isDir ? launchPath : launchPath.replace(/[/\\][^/\\]+$/, "");
        setCurrentPath(targetDir);
        pushNav(targetDir);
        const entries = await invoke<ListEntry[]>("list_directory", { path: targetDir, contextId: ctxId }).catch(() => [] as ListEntry[]);
        setListEntries(entries);
        return;
      }

      // Find the best starting path: last_path of active context, or first folder
      const allPaths = ctxs.flatMap((c) => c.watched_paths);
      const lastPath = activeCtx?.last_path || allPaths[0];

      if (!lastPath) {
        // Contexts exist but no path set — navigate to home
        const homeDir = await invoke<string>("get_home_dir").catch(() => "C:\\Users");
        setCurrentPath(homeDir);
        pushNav(homeDir);
        const entries = await invoke<ListEntry[]>("list_directory", { path: homeDir, contextId: ctxId }).catch(() => [] as ListEntry[]);
        setListEntries(entries);
        return;
      }

      setCurrentPath(lastPath);
      pushNav(lastPath);
      try {
        const entries = await invoke<ListEntry[]>("list_directory", { path: lastPath, contextId: ctxId });
        setListEntries(entries);
      } catch { /* folder may have moved */ }

      setIsScanning(true);
      try {
        const files = await invoke<FileEntry[]>("get_files", { path: lastPath, contextId: ctxId });
        setFiles(files);
        const tags = await invoke<Tag[]>("get_tags");
        setTags(tags);
        for (const p of allPaths) {
          invoke("watch_directory", { path: p }).catch(console.error);
        }
        setIsWatching(true);
      } finally {
        setIsScanning(false);
      }
    };
    restore().catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sharing events
  useEffect(() => {
    const u1 = listen<{ name: string }>("sharing://client-joined", (e) => addSharingClient(e.payload.name));
    const u2 = listen<{ name: string }>("sharing://client-left", (e) => removeSharingClient(e.payload.name));
    const u3 = listen("sharing://disconnected", () => resetSharing());
    const u4 = listen<{ kind: string; path: string }>("sharing://fs-event", async () => {
      if (currentPath) {
        try {
          const entries = await invoke<ListEntry[]>("list_remote_dir", { path: currentPath });
          setListEntries(entries);
        } catch { /* ignore */ }
      }
    });
    return () => { u1.then((f) => f()); u2.then((f) => f()); u3.then((f) => f()); u4.then((f) => f()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath, sharingMode]);

  // Mouse back / forward buttons — pane-aware
  useEffect(() => {
    const handler = async (e: MouseEvent) => {
      let path: string | null = null;
      const usePane2 = dualPaneActive && activePaneIndex === 1;
      if (e.button === 3) path = usePane2 ? stepBack2() : stepBack();
      else if (e.button === 4) path = usePane2 ? stepForward2() : stepForward();
      if (!path) return;
      e.preventDefault();
      try {
        const cmd = sharingMode === "joined" ? "list_remote_dir" : "list_directory";
        const entries = await invoke<ListEntry[]>(cmd, { path, contextId: activeContextIdRef.current ?? 0 });
        if (usePane2) setPane2Entries(entries);
        else setListEntries(entries);
        selectEntry(null);
      } catch { /* folder may no longer exist */ }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dualPaneActive, activePaneIndex]);

  // File watching events — debounced 300ms to coalesce rapid bursts (e.g. Word auto-save)
  useEffect(() => {
    const unlisten = listen<FileChangedPayload>("file-changed", (event) => {
      const { action, path, timestamp } = event.payload;
      if (action === "deleted") { removeFile(path); return; }
      if (!currentPath) return;
      if (watcherDebounceRef.current) clearTimeout(watcherDebounceRef.current);
      watcherDebounceRef.current = setTimeout(async () => {
        try {
          const entries = await invoke<ListEntry[]>("list_directory", { path: currentPath, contextId: activeContextIdRef.current ?? 0 });
          setListEntries(entries);
          const tags = await invoke<Tag[]>("get_tags");
          setTags(tags);
        } catch { markFileModified(path, timestamp); }
      }, 300);
    });
    return () => {
      unlisten.then((fn) => fn());
      if (watcherDebounceRef.current) clearTimeout(watcherDebounceRef.current);
    };
  }, [currentPath, setListEntries, setTags, removeFile, markFileModified]);

  // Init telemetry once settings are loaded
  useEffect(() => {
    telemetryInit(settings.telemetryEnabled);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global hotkeys: Ctrl+K → palette, ? → shortcuts, F5 → dual pane toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setCommandPaletteOpen(true);
      }
      if (e.key === "?" && !inInput && !e.ctrlKey && !e.metaKey) {
        setShortcutsOpen((v) => !v);
      }
      if (e.key === "F5" && !inInput) {
        e.preventDefault();
        setDualPaneActive(!dualPaneActive);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "i") {
        e.preventDefault();
        setAiPanelOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setCommandPaletteOpen, dualPaneActive, setDualPaneActive]);

  // Auto-reconnect when sharing session drops
  useEffect(() => {
    const unlisten = listen("sharing://disconnected", async () => {
      const args = sharingGuestArgs;
      if (!args) return; // intentional disconnect — no reconnect

      const MAX_ATTEMPTS = 4;
      if (reconnectAttemptsRef.current >= MAX_ATTEMPTS) {
        resetSharing();
        reconnectAttemptsRef.current = 0;
        return;
      }

      const delay = Math.min(3 * 2 ** reconnectAttemptsRef.current, 24); // 3, 6, 12, 24s
      reconnectAttemptsRef.current++;
      setSharingReconnecting(true);

      reconnectTimerRef.current = setTimeout(async () => {
        try {
          const info = await invoke<{ name: string; icon: string; root_paths: string[] }>(
            "join_shared_workspace",
            { code: args.code, password: args.password, displayName: args.displayName },
          );
          setSharingJoined(info.name, info.root_paths);
          reconnectAttemptsRef.current = 0;
          setSharingReconnecting(false);
        } catch {
          // Will trigger sharing://disconnected again → retry
        }
      }, delay * 1000);
    });
    return () => {
      unlisten.then((f) => f());
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharingGuestArgs]);

  const handleOnboardingClose = async () => {
    setOnboardingOpen(false);
    updateSettings({ hasSeenOnboarding: true });
    await invoke("set_setting", { key: "hasSeenOnboarding", value: "true" }).catch(console.error);
  };

  const [previewOpen, setPreviewOpen] = useState(true);
  const [diskUsageOpen, setDiskUsageOpen] = useState(false);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);

  // Save workspace state on OS-level close (Alt+F4, taskbar right-click, etc.)
  // Popup windows use native OS decorations so the OS handles close naturally.
  useEffect(() => {
    if (IS_POPUP) return; // native close button on popups needs no interception
    const win = getCurrentWindow();
    const p = win.onCloseRequested((event) => {
      if (isClosing()) return; // already saving, destroy() pending
      event.preventDefault();
      saveAndClose(); // saves state then destroy()s — no second CloseRequested
    });
    return () => { p.then((f) => f()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedEntries = useMemo(
    () => listEntries.filter((e) => selectedPaths.includes(e.path)),
    [listEntries, selectedPaths]
  );

  return (
    <div className="flex flex-col h-full bg-surface-0">
      {/* Custom titlebar only for the main window — popup windows use native OS chrome */}
      {!IS_POPUP && <Titlebar />}
      <Toolbar
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenDiskUsage={() => setDiskUsageOpen(true)}
        onOpenAi={settings.claudeEnabled ? () => setAiPanelOpen((v) => !v) : undefined}
        aiActive={aiPanelOpen}
      />
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar hidden in popup windows for a focused, distraction-free view */}
        {!IS_POPUP && <Sidebar />}
        <div className="flex flex-1 overflow-hidden min-w-0">
        <div className="flex flex-col flex-1 overflow-hidden min-w-0">
          <TabBar />
          {openedFile ? (() => {
            const ext = openedFile.extension.toLowerCase();
            if (IMAGE_EXTS.includes(ext) || VIDEO_EXTS.includes(ext) || AUDIO_EXTS.includes(ext)) return <MediaViewer />;
            if (DOC_EXTS.includes(ext)) return <DocumentViewer />;
            if (ARCHIVE_EXTS.includes(ext)) return <ArchiveViewer />;
            return <EditorView />;
          })() : viewMode === "explorer" ? (
            dualPaneActive ? (
              <div className="flex flex-1 overflow-hidden">
                <FileList paneIndex={0} />
                <div className="w-[1px] bg-border-subtle shrink-0" />
                <FileList paneIndex={1} />
              </div>
            ) : (
              <div className="flex flex-1 overflow-hidden">
                <FileList />
                {previewOpen
                  ? <PreviewPanel onClose={() => setPreviewOpen(false)} />
                  : <button
                      onClick={() => setPreviewOpen(true)}
                      title="Open preview panel"
                      className="flex items-center justify-center w-6 shrink-0 bg-surface-1 border-l border-border-subtle text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors"
                    >
                      <span className="text-[9px] [writing-mode:vertical-rl] tracking-widest uppercase select-none">Preview</span>
                    </button>
                }
              </div>
            )
          ) : (
            <TimelineView />
          )}
        </div>
        {aiPanelOpen && settings.claudeEnabled && (
          <AiPanel
            onClose={() => setAiPanelOpen(false)}
            onNavigate={async (p) => {
              try {
                const entries = await invoke<ListEntry[]>("list_directory", { path: p, contextId: activeContextIdRef.current ?? 0 });
                setCurrentPath(p);
                pushNav(p);
                setListEntries(entries);
              } catch { /* ignore */ }
            }}
            onRefreshDir={async (p) => {
              try {
                const entries = await invoke<ListEntry[]>("list_directory", { path: p, contextId: activeContextIdRef.current ?? 0 });
                setListEntries(entries);
              } catch { /* ignore */ }
            }}
          />
        )}
        </div>
      </div>
      <ProgressOverlay />
      <ToastContainer />

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onShowGuide={() => { setSettingsOpen(false); setOnboardingOpen(true); }}
        />
      )}
      {shortcutsOpen && <KeyboardShortcutsModal onClose={() => setShortcutsOpen(false)} />}
      {onboardingOpen && <OnboardingModal onClose={handleOnboardingClose} />}

      {commandPaletteOpen && (
        <CommandPalette onClose={() => setCommandPaletteOpen(false)} />
      )}

      {bulkRenameOpen && selectedEntries.length > 1 && (
        <BulkRename
          entries={selectedEntries}
          onClose={() => setBulkRenameOpen(false)}
          onDone={async () => {
            setBulkRenameOpen(false);
            if (currentPath) {
              try {
                const entries = await invoke<ListEntry[]>("list_directory", { path: currentPath, contextId: activeContextIdRef.current ?? 0 });
                setListEntries(entries);
              } catch { /* ignore */ }
            }
          }}
        />
      )}

      {diskUsageOpen && currentPath && (
        <DiskUsageModal
          path={currentPath}
          onClose={() => setDiskUsageOpen(false)}
          onNavigate={(p) => {
            setCurrentPath(p);
            pushNav(p);
            invoke<ListEntry[]>("list_directory", { path: p, contextId: activeContextIdRef.current ?? 0 })
              .then(setListEntries)
              .catch(console.error);
            setDiskUsageOpen(false);
          }}
        />
      )}
    </div>
  );
}
