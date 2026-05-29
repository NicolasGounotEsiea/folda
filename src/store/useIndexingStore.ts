import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/// Lightweight per-path progress snapshot. One entry per workspace folder that
/// has emitted a `content-indexed` event during this session.
export interface IndexingState {
  indexed: number;
  total: number;
  current: string | null; // filename currently being processed, if any
}

interface Store {
  progress: Record<string, IndexingState>;
  /// Resolved when the global event listener is installed. Call `ensureListener()`
  /// from any component that wants live updates; the listener is created at most once.
  ensureListener: () => void;
}

let listenerSetup = false;
let unlistenFn: UnlistenFn | null = null;

export const useIndexingStore = create<Store>((set) => ({
  progress: {},
  ensureListener: () => {
    if (listenerSetup) return;
    listenerSetup = true;

    // The backend emits per-folder events with `indexed`/`total` aligned to the
    // global folder counters from get_indexing_stats. The event itself does NOT
    // carry the folder path — by design, since the indexer operates on a path
    // it received as input. So we apply events to ALL known badges that have a
    // matching `total`. With multiple folders indexing simultaneously this could
    // theoretically misroute, but in practice indexer runs are serial per folder
    // and total values differ between folders.
    listen<{ indexed?: number; total?: number; current?: string; done?: boolean }>(
      "content-indexed",
      (e) => {
        const { indexed, total, current, done } = e.payload;
        if (typeof indexed !== "number" || typeof total !== "number") return;
        set((s) => {
          const next = { ...s.progress };
          // Find the path entry matching this total (if any badge is mounted)
          let matched = false;
          for (const [path, st] of Object.entries(next)) {
            if (st.total === total) {
              next[path] = {
                indexed,
                total,
                current: done ? null : (current ?? st.current),
              };
              matched = true;
            }
          }
          // If no badge is tracking this total yet, store under a synthetic key
          // so the next badge to mount can pick it up by total match.
          if (!matched) {
            next[`__pending_${total}`] = {
              indexed,
              total,
              current: done ? null : (current ?? null),
            };
          }
          return { progress: next };
        });
      }
    ).then((fn) => { unlistenFn = fn; });
  },
}));

/// Manually seed a badge's slot when the initial stats are fetched. Returns the
/// path key under which the state was stored. Pending events for the same total
/// are migrated into this slot.
export function seedIndexingProgress(path: string, total: number, indexed: number) {
  useIndexingStore.setState((s) => {
    const next = { ...s.progress };
    const pendingKey = `__pending_${total}`;
    const pending = next[pendingKey];
    next[path] = pending
      ? { indexed: pending.indexed, total, current: pending.current }
      : { indexed, total, current: null };
    delete next[pendingKey];
    return { progress: next };
  });
}

/// Detach the global listener (used on app shutdown / HMR cleanup).
export function disposeIndexingListener() {
  unlistenFn?.();
  unlistenFn = null;
  listenerSetup = false;
}
