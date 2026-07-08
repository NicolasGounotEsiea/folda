import { invoke } from "@tauri-apps/api/core";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { search, openSearchPanel } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView as CMView, type EditorView as CMEditorView } from "@codemirror/view";
import CodeMirror, { type Statistics } from "@uiw/react-codemirror";
import { Ban, FileCode, History, Save, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { useViewerFindStore } from "../store/useViewerFindStore";
import { SnapshotPanel } from "./SnapshotPanel";

// These extensions are handled by MediaViewer or DocumentViewer — EditorView only sees them
// if somehow routed here, in which case we show a "can't edit" message.
const BINARY_EXTS = new Set([
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst",
  "exe", "msi", "dll", "so", "dylib", "bin", "dat",
  "xls", "xlsx", "ppt", "pptx",
  "ttf", "otf", "woff", "woff2", "db", "sqlite",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico",
  "mp4", "webm", "mov", "mkv", "m4v", "avi", "mp3", "wav", "flac", "ogg", "m4a",
  "pdf", "doc", "docx", "odt", "rtf",
]);

const LANG_NAMES: Record<string, string> = {
  js: "JavaScript", jsx: "JSX", ts: "TypeScript", tsx: "TSX",
  py: "Python", rs: "Rust", css: "CSS", scss: "SCSS",
  html: "HTML", htm: "HTML", json: "JSON",
  md: "Markdown", mdx: "Markdown", txt: "Plain Text",
  sh: "Shell", bash: "Shell", ps1: "PowerShell",
  toml: "TOML", yaml: "YAML", yml: "YAML",
  sql: "SQL", lua: "Lua", go: "Go",
};

function getLangExtension(ext: string): Extension | null {
  switch (ext.toLowerCase()) {
    case "js":   return javascript();
    case "jsx":  return javascript({ jsx: true });
    case "ts":   return javascript({ typescript: true });
    case "tsx":  return javascript({ jsx: true, typescript: true });
    case "py":   return python();
    case "rs":   return rust();
    case "css":
    case "scss": return css();
    case "html":
    case "htm":  return html();
    case "json": return json();
    case "md":
    case "mdx":  return markdown();
    default:     return null;
  }
}

export function EditorView() {
  const { openedFile, closeFile, activeTabId, updateTabCache, sharingMode, settings } = useStore();
  const isRemote = sharingMode === "joined";
  const readFile = (path: string) =>
    isRemote ? invoke<string>("read_remote_file", { path }) : invoke<string>("read_file_full", { path });
  const writeFile = (path: string, content: string) =>
    isRemote ? invoke("write_remote_file", { path, content }) : invoke("write_file", { path, content });
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({ line: 1, col: 1 });
  const [confirmClose, setConfirmClose] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [snapshotKey, setSnapshotKey] = useState(0); // bump to refresh panel
  const contentRef = useRef(content);
  const originalRef = useRef(originalContent);
  contentRef.current = content;
  originalRef.current = originalContent;

  const isDirty = content !== originalContent;

  // isLoaded guards the cache: only sync to store after the file is fully loaded
  const isLoadedRef = useRef(false);

  useEffect(() => {
    if (!openedFile) return;
    isLoadedRef.current = false;

    // Check if this tab already has a cached draft (originalContent !== null means it was loaded before)
    const { tabs } = useStore.getState();
    const tab = tabs.find((t) => t.id === openedFile.path);
    if (tab?.originalContent !== null && tab?.originalContent !== undefined) {
      setContent(tab.draftContent ?? tab.originalContent);
      setOriginalContent(tab.originalContent);
      setLoading(false);
      isLoadedRef.current = true;
      return;
    }

    // First open — load from disk
    setLoading(true);
    setError(null);
    readFile(openedFile.path)
      .then((text) => {
        setContent(text);
        setOriginalContent(text);
        // Seed the cache so next visit restores correctly
        if (activeTabId) updateTabCache(activeTabId, text, text);
        isLoadedRef.current = true;
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openedFile?.path]);

  const handleSave = useCallback(async () => {
    if (!openedFile) return;
    const current = contentRef.current;
    setSaving(true);
    try {
      // Auto-snapshot before saving (local files only, ≤1 MB enforced server-side)
      if (!isRemote && settings.snapshotMode === "auto") {
        invoke("create_snapshot", {
          filePath: openedFile.path,
          maxCount: settings.snapshotMaxCount,
        }).catch(() => {});
      }
      await writeFile(openedFile.path, current);
      setOriginalContent(current);
      if (activeTabId) updateTabCache(activeTabId, current, current);
      setSnapshotKey((k) => k + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [openedFile, activeTabId, updateTabCache, isRemote, settings.snapshotMode, settings.snapshotMaxCount]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave]);

  if (!openedFile) return null;

  const ext = openedFile.extension.toLowerCase();

  if (BINARY_EXTS.has(ext)) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden bg-surface-0">
        <div className="flex items-center gap-2 px-3 h-10 bg-surface-1 border-b border-border-subtle shrink-0">
          <Ban size={13} className="text-text-muted shrink-0" />
          <span className="text-[12px] text-text-primary font-medium truncate flex-1">{openedFile.name}</span>
          <button onClick={closeFile} className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors shrink-0">
            <X size={13} />
          </button>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted">
          <Ban size={28} className="opacity-20" />
          <span className="text-[12px]">Ce type de fichier ne peut pas être édité</span>
          <span className="text-[10px] opacity-50">{ext.toUpperCase()}</span>
        </div>
      </div>
    );
  }
  const langExt = getLangExtension(ext);
  // Capture the CodeMirror EditorView so we can programmatically open the
  // search panel when the Toolbar's Ctrl+F handler defers to us via the
  // viewer-find store. `basicSetup.searchKeymap = true` already installs the
  // keymap, but we also want the externally-triggered open path for
  // consistency with future viewers that might lack a native keymap.
  const cmViewRef = useRef<CMEditorView | null>(null);

  useEffect(() => {
    useViewerFindStore.getState().setHandler(() => {
      const view = cmViewRef.current;
      if (view) openSearchPanel(view);
    });
    return () => useViewerFindStore.getState().setHandler(null);
  }, []);

  // Include the search extension so the panel UI is available. Without this
  // the keymap exists but there's no panel implementation to open.
  const extensions: Extension[] = [oneDark, search()];
  if (langExt) extensions.push(langExt);
  // Word wrap + tab size are driven by Settings → Editor. These belong in the
  // `extensions` array (not basicSetup, which takes only booleans) so they can
  // carry a value. tabSize uses EditorState.tabSize for display width AND the
  // indentUnit-equivalent via a spaces string is left to CodeMirror defaults.
  if (settings.editorWordWrap) extensions.push(CMView.lineWrapping);
  extensions.push(EditorState.tabSize.of(settings.editorTabSize));
  const langName = LANG_NAMES[ext] ?? (ext ? ext.toUpperCase() : "Plain Text");

  return (
    <div className="flex-1 flex overflow-hidden bg-[#282c34]">
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-10 bg-surface-1 border-b border-border-subtle shrink-0">
        <FileCode size={13} className="text-text-muted shrink-0" />
        <span className="text-[12px] text-text-primary font-medium truncate flex-1 min-w-0">
          {openedFile.name}
        </span>
        <span className="text-[10px] text-text-muted bg-surface-3 px-1.5 py-0.5 rounded shrink-0">
          {langName}
        </span>
        {isDirty && (
          <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" title="Unsaved changes" />
        )}
        <button
          onClick={handleSave}
          disabled={!isDirty || saving}
          className="flex items-center gap-1 px-2.5 h-6 rounded text-[11px] bg-accent text-white disabled:opacity-30 hover:bg-accent/80 transition-colors shrink-0"
        >
          <Save size={10} />
          {saving ? "Saving…" : "Save"}
        </button>
        {!isRemote && (
          <button
            onClick={() => setSnapshotOpen((v) => !v)}
            title="Snapshots"
            className={`w-7 h-7 flex items-center justify-center rounded transition-colors shrink-0 ${snapshotOpen ? "text-accent bg-accent/10" : "text-text-muted hover:text-text-secondary hover:bg-surface-3"}`}
          >
            <History size={13} />
          </button>
        )}
        <button
          onClick={() => isDirty ? setConfirmClose(true) : closeFile()}
          className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors shrink-0"
          title="Close editor"
        >
          <X size={13} />
        </button>
      </div>

      {/* Dirty-close confirmation */}
      {confirmClose && (
        <div className="modal-backdrop-in fixed inset-0 z-[200] flex items-center justify-center bg-black/50">
          <div className="modal-content-in bg-surface-1 border border-border rounded-xl shadow-2xl w-80 p-5 flex flex-col gap-4">
            <div>
              <p className="text-[13px] font-semibold text-text-primary">Unsaved changes</p>
              <p className="text-[12px] text-text-secondary mt-1">
                Save changes to <strong className="text-text-primary">{openedFile.name}</strong> before closing?
              </p>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmClose(false)} className="px-3 h-7 rounded text-[12px] text-text-secondary hover:bg-surface-3 transition-colors">Cancel</button>
              <button onClick={() => { setConfirmClose(false); closeFile(); }} className="px-3 h-7 rounded text-[12px] text-red-400 hover:bg-red-500/10 transition-colors">Discard</button>
              <button onClick={async () => { await handleSave(); setConfirmClose(false); closeFile(); }} className="px-3 h-7 rounded text-[12px] bg-accent text-white hover:bg-accent/80 transition-colors">Save & Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Error bar */}
      {error && (
        <div className="px-3 py-1.5 bg-red-950/60 border-b border-red-900/50 text-red-400 text-[11px] shrink-0">
          {error}
        </div>
      )}

      {/* Editor body */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-text-muted text-[12px] animate-pulse">
          Loading…
        </div>
      ) : (
        <div className="flex-1 overflow-hidden">
          <CodeMirror
            value={content}
            height="100%"
            extensions={extensions}
            onCreateEditor={(view) => { cmViewRef.current = view; }}
            onChange={(val) => {
              setContent(val);
              // Only update cache after the file has been loaded (guards against empty-state pollution)
              if (activeTabId && isLoadedRef.current) {
                updateTabCache(activeTabId, val, originalRef.current);
              }
            }}
            onStatistics={(s: Statistics) =>
              setStats({ line: s.line.number, col: s.selectionAsSingle.head - s.line.from + 1 })
            }
            style={{ height: "100%", fontSize: "13px", fontFamily: "monospace" }}
            basicSetup={{
              lineNumbers: settings.editorLineNumbers,
              highlightActiveLineGutter: true,
              highlightSpecialChars: true,
              foldGutter: true,
              drawSelection: true,
              dropCursor: true,
              indentOnInput: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: true,
              rectangularSelection: true,
              crosshairCursor: false,
              highlightActiveLine: true,
              highlightSelectionMatches: true,
              closeBracketsKeymap: true,
              searchKeymap: true,
              tabSize: settings.editorTabSize,
            }}
          />
        </div>
      )}

      {/* Status bar */}
      <div className="flex items-center gap-4 px-3 h-6 bg-surface-1 border-t border-border-subtle shrink-0">
        <span className="text-[10px] text-text-muted">
          Ln {stats.line}, Col {stats.col}
        </span>
        <span className="text-[10px] text-text-muted">{langName}</span>
        <div className="flex-1" />
        {isDirty
          ? <span className="text-[10px] text-amber-400">Unsaved changes</span>
          : <span className="text-[10px] text-emerald-500">Saved</span>
        }
      </div>
    </div>

    {/* Snapshot side panel */}
    {snapshotOpen && openedFile && !isRemote && (
      <SnapshotPanel
        key={snapshotKey}
        filePath={openedFile.path}
        currentContent={content}
        onClose={() => setSnapshotOpen(false)}
        onRestored={() => {
          // Reload file content after restore
          invoke<string>("read_file_full", { path: openedFile.path })
            .then((text) => {
              setContent(text);
              setOriginalContent(text);
              if (activeTabId) updateTabCache(activeTabId, text, text);
            })
            .catch(() => {});
        }}
      />
    )}
    </div>
  );
}
