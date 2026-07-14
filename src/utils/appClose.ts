import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore } from "../store/useStore";

let _closing = false;

export async function saveAndClose() {
  if (_closing) return;
  _closing = true;
  const s = useStore.getState();

  // Lock every open vault BEFORE the window dies.
  //
  // Two reasons this must happen here and not be left to the process exiting:
  //  1. The master keys are RAM-only, so they die with the process anyway — but
  //     the DECRYPTED TEMP FILES do not. `vault_lock_all` deletes them. Without
  //     this, a user who closes nxs with a vault open leaves plaintext copies of
  //     their most sensitive files sitting on disk until the next launch's
  //     startup sweep.
  //  2. `destroy()` is immediate and does not wait for pending IPC, so the call
  //     is awaited rather than fired and forgotten.
  //
  // Awaited but never allowed to BLOCK the close: a hung backend must not trap
  // the user in an app that won't quit, so failures are swallowed.
  if (s.settings.vaultLockOnClose) {
    await invoke("vault_lock_all").catch(console.error);
  }

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
