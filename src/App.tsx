import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { BulkRename } from "./components/BulkRename";
import { CommandPalette } from "./components/CommandPalette";
import { DocumentViewer, DOC_EXTS } from "./components/DocumentViewer";
import { EditorView } from "./components/EditorView";
import { FileList } from "./components/FileList";
import { AUDIO_EXTS, IMAGE_EXTS, MediaViewer, VIDEO_EXTS } from "./components/MediaViewer";
import { PreviewPanel } from "./components/PreviewPanel";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { Titlebar } from "./components/Titlebar";
import { Toolbar } from "./components/Toolbar";
import { useStore, pathToTab } from "./store/useStore";
import type { Context, FileEntry, ListEntry, Tag } from "./types";
import { TimelineView } from "./views/TimelineView";

interface FileChangedPayload {
  path: string;
  name: string;
  action: "created" | "modified" | "deleted";
  timestamp: number;
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
  } = useStore();

  // Restore last session
  useEffect(() => {
    const restore = async () => {
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

      if (!ctxs.length) return;
      setContexts(ctxs); // sets rootPaths from active workspace

      // Restore active workspace's file tabs
      const activeCtx = ctxs.find((c) => c.is_active) ?? ctxs[0];
      if (activeCtx?.open_file_tabs?.length) {
        setTabs(activeCtx.open_file_tabs.map(pathToTab));
      }

      // Find the best starting path: last_path of active context, or first folder
      const allPaths = ctxs.flatMap((c) => c.watched_paths);
      const lastPath = activeCtx?.last_path || allPaths[0];
      if (!lastPath) return;

      setCurrentPath(lastPath);
      pushNav(lastPath);
      try {
        const entries = await invoke<ListEntry[]>("list_directory", { path: lastPath });
        setListEntries(entries);
      } catch { /* folder may have moved */ }

      setIsScanning(true);
      try {
        const files = await invoke<FileEntry[]>("get_files", { path: lastPath });
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

  // Mouse back / forward buttons
  useEffect(() => {
    const handler = async (e: MouseEvent) => {
      let path: string | null = null;
      if (e.button === 3) path = stepBack();
      else if (e.button === 4) path = stepForward();
      if (!path) return;
      e.preventDefault();
      try {
        const cmd = sharingMode === "joined" ? "list_remote_dir" : "list_directory";
        const entries = await invoke<ListEntry[]>(cmd, { path });
        setListEntries(entries);
        selectEntry(null);
      } catch { /* folder may no longer exist */ }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // File watching events
  useEffect(() => {
    const unlisten = listen<FileChangedPayload>("file-changed", async (event) => {
      const { action, path, timestamp } = event.payload;
      if (action === "deleted") { removeFile(path); return; }
      if (currentPath) {
        try {
          const entries = await invoke<ListEntry[]>("list_directory", { path: currentPath });
          setListEntries(entries);
          const tags = await invoke<Tag[]>("get_tags");
          setTags(tags);
        } catch { markFileModified(path, timestamp); }
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [currentPath, setListEntries, setTags, removeFile, markFileModified]);

  // Global Ctrl+K → command palette
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setCommandPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setCommandPaletteOpen]);

  const selectedEntries = listEntries.filter((e) => selectedPaths.includes(e.path));

  return (
    <div className="flex flex-col h-full bg-surface-0">
      <Titlebar />
      <Toolbar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <div className="flex flex-col flex-1 overflow-hidden min-w-0">
          <TabBar />
          {openedFile ? (() => {
            const ext = openedFile.extension.toLowerCase();
            if (IMAGE_EXTS.includes(ext) || VIDEO_EXTS.includes(ext) || AUDIO_EXTS.includes(ext)) return <MediaViewer />;
            if (DOC_EXTS.includes(ext)) return <DocumentViewer />;
            return <EditorView />;
          })() : viewMode === "explorer" ? (
            <div className="flex flex-1 overflow-hidden">
              <FileList />
              <PreviewPanel />
            </div>
          ) : (
            <TimelineView />
          )}
        </div>
      </div>

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
                const entries = await invoke<ListEntry[]>("list_directory", { path: currentPath });
                setListEntries(entries);
              } catch { /* ignore */ }
            }
          }}
        />
      )}
    </div>
  );
}
