import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore } from "../store/useStore";

let _closing = false;

export async function saveAndClose() {
  if (_closing) return;
  _closing = true;
  const s = useStore.getState();
  const activeCtx = s.contexts.find((c) => c.id === s.activeContextId);
  if (activeCtx) {
    await invoke("update_context", {
      id: activeCtx.id, name: activeCtx.name, icon: activeCtx.icon,
      watchedPaths: activeCtx.watched_paths,
      lastPath: s.currentPath,
      activeTagIds: s.selectedTagIds,
      openTabs: s.folderTabs.map((t) => t.path),
      openFileTabs: s.tabs.map((t) => t.id),
    }).catch(console.error);
  }
  getCurrentWindow().destroy().catch(console.error);
}

export function isClosing() {
  return _closing;
}
