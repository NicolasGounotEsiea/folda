import { invoke } from "@tauri-apps/api/core";
import { Clock, File, Folder, FolderOpen, Workflow } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import type { Context, ListEntry } from "../types";
import { useTranslation } from "../utils/i18n";
import { isNoisyPath } from "../utils/noisePaths";

/**
 * Quick-start popover anchored under the app logo (Titlebar).
 *
 * Mouse-driven counterpart to the Ctrl+K command palette: surfaces "where do
 * I want to go right now?" without typing — current workspace label, the
 * top 5 recently-touched paths, and the workspaces switcher.
 *
 * Single intentional role — there's no settings link, no about, no changelog.
 * Adding more rows turns the popover into a mini-dashboard which doesn't fit
 * the ~280 px footprint. Keep the rule strict; the command palette has the
 * action surface area, this one has the navigation surface area.
 */

const POPOVER_WIDTH = 300;

interface RecentEntry {
  path: string;        // path to navigate to (file → parent folder)
  name: string;        // file or folder name to display
  fullPath: string;    // original activity-log path used for de-dup keys + tooltip
  isDir: boolean;
}

export function QuickStartPopover({
  anchorRect,
  anchorEl,
  onClose,
}: {
  anchorRect: DOMRect;
  /**
   * The DOM element that opened the popover (typically the logo button).
   * Excluded from the outside-click handler so the user can click the logo a
   * second time to close (the parent's onClick toggles state) without
   * triggering an immediate close-then-reopen race.
   */
  anchorEl: HTMLElement | null;
  onClose: () => void;
}) {
  const t = useTranslation();
  const {
    contexts, activeContextId, setContexts,
    setCurrentPath, setListEntries, pushNav,
    selectEntry, switchWorkspace, setViewMode,
  } = useStore();
  const popoverRef = useRef<HTMLDivElement>(null);

  // ─── Recents — last 30 days, deduplicated, noise-filtered, cap 5 ──────────
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  useEffect(() => {
    const now = Math.floor(Date.now() / 1000);
    invoke<Array<{ file_path: string; file_name: string; action: string }>>("get_timeline", {
      from: now - 30 * 86400, to: now, folder: null,
    }).then((entries) => {
      const seen = new Set<string>();
      const cmds: RecentEntry[] = [];
      for (const e of entries) {
        if (!e.file_name || seen.has(e.file_path)) continue;
        // Same noise filter the Ctrl+K palette uses — `.git/objects/…`,
        // `node_modules/…`, etc. don't belong here either. See utils/noisePaths.
        if (isNoisyPath(e.file_path)) continue;
        seen.add(e.file_path);
        const isDir = e.action === "navigated";
        const target = isDir
          ? e.file_path
          : e.file_path.replace(/\\/g, "/").split("/").slice(0, -1).join("\\");
        cmds.push({
          path: target,
          name: e.file_name,
          fullPath: e.file_path,
          isDir,
        });
        if (cmds.length >= 5) break;
      }
      setRecents(cmds);
    }).catch(() => {});
  }, []);

  // ─── Close on click outside and Esc ───────────────────────────────────────
  // We DON'T close on a click inside the popover itself — only outside. The
  // mousedown listener fires before the click action so by the time the
  // close handler runs, the click target hierarchy is still intact for the
  // contains() check.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const el = popoverRef.current;
      const target = e.target as Node;
      // Clicks on the popover itself stay; clicks on the anchor button are
      // delegated to the parent (which toggles open/close on click) so we
      // don't both close from here AND re-open from the click handler.
      if (el && el.contains(target)) return;
      if (anchorEl && anchorEl.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // stopImmediatePropagation prevents FileList's window-level Esc handler
        // (which clears selection) from firing too — closing the popover is the
        // single user-visible effect of Esc when the popover is open.
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    // Capture phase so we run BEFORE FileList's bubble-phase Esc handler that
    // clears selection — without this, dismissing the popover with Esc would
    // also wipe the user's file selection in the background pane. mousedown
    // doesn't need capture: there's no other window-level mousedown handler
    // racing it that we care about.
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [onClose, anchorEl]);

  // ─── Actions ──────────────────────────────────────────────────────────────
  const activeCtx = activeContextId !== null
    ? contexts.find((c) => c.id === activeContextId) ?? null
    : null;

  const navigateTo = async (path: string) => {
    if (!path) { onClose(); return; }
    setCurrentPath(path);
    pushNav(path);
    setViewMode("explorer");
    try {
      const entries = await invoke<ListEntry[]>("list_directory", {
        path, contextId: activeContextId ?? 0,
      });
      setListEntries(entries);
      selectEntry(null);
    } catch { /* folder may have moved — silent fallback, user can search */ }
    onClose();
  };

  // Replicates Sidebar's handleSwitch: persist current workspace's tabs +
  // last_path before swapping. Without the persist step the workspace we're
  // LEAVING would forget its open tabs and last folder. Kept local to this
  // file rather than promoted to a store helper for the moment — if a third
  // call site appears, extract.
  const switchToWorkspace = async (ctx: Context) => {
    if (ctx.id === activeContextId) { onClose(); return; }
    const state = useStore.getState();
    if (state.activeContextId !== null) {
      const cur = state.contexts.find((c) => c.id === state.activeContextId);
      if (cur) {
        await invoke("update_context", {
          id: cur.id, name: cur.name, icon: cur.icon,
          watchedPaths: cur.watched_paths,
          lastPath: state.currentPath,
          activeTagIds: state.selectedTagIds,
          openTabs: state.folderTabs.map((tab) => tab.path),
          openFileTabs: state.tabs.map((tab) => tab.id),
        }).catch(console.error);
      }
    }
    await invoke("set_active_context", { contextId: ctx.id }).catch(console.error);
    const restored = switchWorkspace(ctx.id);
    if (!restored) { onClose(); return; }
    const target = restored.lastPath;
    if (target) {
      pushNav(target);
      try {
        const entries = await invoke<ListEntry[]>("list_directory", {
          path: target, contextId: ctx.id,
        });
        setListEntries(entries);
        selectEntry(null);
      } catch { /* target folder moved — workspace still switched */ }
    }
    // Refresh contexts so the active-flag flip is reflected on next open.
    invoke<Context[]>("get_contexts").then(setContexts).catch(() => {});
    onClose();
  };

  // ─── Positioning ──────────────────────────────────────────────────────────
  // Anchor under-left of the logo. Clamp to the viewport's right edge so we
  // don't overflow on narrow windows (the titlebar shrinks but the popover
  // shouldn't paint off-screen).
  const top = Math.round(anchorRect.bottom + 6);
  const left = Math.min(
    Math.max(0, Math.round(anchorRect.left)),
    Math.max(0, window.innerWidth - POPOVER_WIDTH - 8),
  );

  return (
    <div
      ref={popoverRef}
      className="fixed z-[999] rounded-lg border border-border bg-surface-2 shadow-xl shadow-black/40 overflow-hidden modal-content-in"
      style={{ top, left, width: POPOVER_WIDTH }}
      role="dialog"
      aria-label={t.quickStartTitle}
    >
      {/* Workspace header */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-border-subtle bg-surface-1">
        <Workflow size={13} className="text-accent shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[10px] text-text-muted uppercase tracking-widest leading-none">
            {t.quickStartWorkspace}
          </div>
          <div className="text-[12px] text-text-primary truncate leading-tight mt-0.5">
            {activeCtx ? `${activeCtx.icon ?? ""} ${activeCtx.name}`.trim() : t.quickStartNoWorkspace}
          </div>
        </div>
      </div>

      {/* Recents */}
      <div className="py-1">
        <div className="px-3 pt-1 pb-1 flex items-center gap-1.5 text-[10px] text-text-muted uppercase tracking-widest">
          <Clock size={10} />
          <span>{t.quickStartRecent}</span>
        </div>
        {recents.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-text-muted italic">
            {t.quickStartNoRecent}
          </div>
        ) : (
          recents.map((r) => (
            <button
              key={r.fullPath}
              onClick={() => navigateTo(r.path)}
              title={r.fullPath}
              className="w-full flex items-center gap-2 px-3 h-7 text-left hover:bg-surface-3 transition-colors"
            >
              {r.isDir
                ? <Folder size={12} className="text-yellow-400 shrink-0" />
                : <File size={12} className="text-text-muted shrink-0" />}
              <span className="flex-1 min-w-0 text-[12px] text-text-primary truncate">{r.name}</span>
            </button>
          ))
        )}
      </div>

      {/* Workspaces switcher */}
      {contexts.length > 0 && (
        <div className="py-1 border-t border-border-subtle">
          <div className="px-3 pt-1 pb-1 flex items-center gap-1.5 text-[10px] text-text-muted uppercase tracking-widest">
            <FolderOpen size={10} />
            <span>{t.quickStartWorkspaces}</span>
          </div>
          {contexts.map((c) => {
            const isActive = c.id === activeContextId;
            return (
              <button
                key={c.id}
                onClick={() => switchToWorkspace(c)}
                className={
                  "w-full flex items-center gap-2 px-3 h-7 text-left transition-colors " +
                  (isActive
                    ? "bg-accent/10 text-accent"
                    : "text-text-primary hover:bg-surface-3")
                }
              >
                <span className="text-[12px] shrink-0 w-4 text-center">{c.icon || "•"}</span>
                <span className="flex-1 min-w-0 text-[12px] truncate">{c.name}</span>
                {isActive && (
                  <span className="text-[9px] text-accent uppercase tracking-widest shrink-0">
                    {t.quickStartActive}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
