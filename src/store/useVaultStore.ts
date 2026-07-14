import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/**
 * Which vaults are currently unlocked, and for how long they've been idle.
 *
 * A DEDICATED store rather than fields on `useStore`: vault state is consumed by
 * a handful of components (FileList's padlocks, the status-bar badge, VaultView)
 * and changes on its own cadence (the Rust idle sweeper can lock a vault at any
 * moment). Putting it in the 800-line main store would make every unrelated
 * component that does `useStore()` re-render on every vault tick.
 *
 * The Rust side is the single source of truth — the master key lives there and
 * only there. This store is a *cache* of `vault_unlocked_list()`, refreshed
 * after every vault action and whenever the backend says a vault auto-locked.
 * It must never be treated as authoritative: a command can always come back
 * with "This vault is locked" if the sweeper won a race, and callers handle that.
 */

/**
 * Paths are compared case-insensitively with forward slashes — Windows hands us
 * `C:\Foo` from one command and `C:/Foo` from another, and Rust's `canonicalize`
 * adds a `\\?\` prefix. They are all the same vault, and a mismatch here would
 * show a padlock as "locked" on a vault that is actually open (or worse, the
 * reverse). Exported so every caller uses the SAME normalization — a second,
 * subtly-different implementation elsewhere is exactly how that bug appears.
 */
export function normVaultPath(path: string): string {
  return path
    .replace(/^\\\\\?\\/, "")   // strip Rust's canonicalize() UNC prefix
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}
const norm = normVaultPath;

export interface UnlockedVault {
  path: string;
  idleSecs: number;
}

interface VaultState {
  unlocked: UnlockedVault[];
  /** Normalized paths, for O(1) lookups from render paths. */
  unlockedSet: Set<string>;
  refresh: () => Promise<void>;
  isUnlocked: (path: string) => boolean;
}

export const useVaultStore = create<VaultState>((set, get) => ({
  unlocked: [],
  unlockedSet: new Set(),

  refresh: async () => {
    try {
      const list = await invoke<{ path: string; idle_secs: number }[]>("vault_unlocked_list");
      const unlocked = list.map((v) => ({ path: v.path, idleSecs: v.idle_secs }));
      set({
        unlocked,
        unlockedSet: new Set(unlocked.map((v) => norm(v.path))),
      });
    } catch {
      // A failed refresh must not leave a stale "unlocked" set that would let
      // the UI try to read a locked vault. Empty = locked = the safe default.
      set({ unlocked: [], unlockedSet: new Set() });
    }
  },

  isUnlocked: (path: string) => get().unlockedSet.has(norm(path)),
}));

/** Refresh the cache — call after any vault mutation (unlock/lock/create). */
export const refreshVaults = () => useVaultStore.getState().refresh();
