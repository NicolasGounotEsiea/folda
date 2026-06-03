import { create } from "zustand";

/// When a file viewer mounts, it registers a `handler` that's called when the
/// user presses Ctrl+F. The viewer is responsible for showing its own find UI
/// (CodeMirror search panel, custom find bar, focus a filter input, …).
///
/// When NO viewer is mounted (or the active viewer doesn't support find),
/// the Toolbar's Ctrl+F handler falls back to focusing the global search bar
/// — preserving the historical behavior.
///
/// Always set `handler` to null on viewer unmount, otherwise the next user
/// Ctrl+F would invoke a stale closure pointing at a disposed editor instance.
interface ViewerFindStore {
  handler: (() => void) | null;
  setHandler: (h: (() => void) | null) => void;
}

export const useViewerFindStore = create<ViewerFindStore>((set) => ({
  handler: null,
  setHandler: (handler) => set({ handler }),
}));
