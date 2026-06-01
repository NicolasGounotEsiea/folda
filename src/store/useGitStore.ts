import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

// ── Backend type mirrors ─────────────────────────────────────────────────────

export type FileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "ignored"
  | "conflicted";

export interface FileStatusEntry {
  path: string;        // relative to repo root, forward slashes
  status: FileStatus;
  staged: boolean;
}

export interface RepoInfo {
  repo_root: string;
  detached: boolean;
  branch: string;
  head_sha: string;
  ahead: number | null;
  behind: number | null;
}

export interface RepoStatus {
  info: RepoInfo;
  changed_files: FileStatusEntry[];
  stale: boolean;
}

export interface BranchInfo {
  name: string;
  is_current: boolean;
  is_remote: boolean;
  last_commit_at: number;
}

export interface CommitInfo {
  sha: string;
  short_sha: string;
  author_name: string;
  author_email: string;
  date: number;
  message: string;
}

export interface CommitFileChange {
  path: string;
  change_type: string;
  diff: string;
}

export interface CommitDiff {
  info: CommitInfo;
  files: CommitFileChange[];
}

// ── Store ────────────────────────────────────────────────────────────────────
//
// Keyed on `currentPath` (the user's active directory). The store holds the
// LATEST resolved repo info for that directory; if the user navigates outside
// any git repo the slot is `null` and the UI hides the panel.
//
// Loading is path-aware via a `loadingFor` token so an in-flight request for
// path X that arrives AFTER the user navigated to Y is discarded — prevents
// stale data from flashing into the UI.

interface GitStoreState {
  /// The path we last requested status for. Used to ignore late responses.
  currentPath: string | null;
  loadingStatus: boolean;
  status: RepoStatus | null;       // null when not in a repo or not yet loaded
  branches: BranchInfo[];
  commits: CommitInfo[];
  /// O(1) lookup: relative-to-repo-root path → status. Built whenever `status`
  /// changes so FileList can flash badges without a re-scan per render.
  statusByPath: Map<string, FileStatusEntry>;

  refresh: (path: string, opts: { dimIgnored: boolean; recentCommitsCount: number }) => Promise<void>;
  clear: () => void;
}

export const useGitStore = create<GitStoreState>((set, get) => ({
  currentPath: null,
  loadingStatus: false,
  status: null,
  branches: [],
  commits: [],
  statusByPath: new Map(),

  clear: () => set({
    currentPath: null,
    loadingStatus: false,
    status: null,
    branches: [],
    commits: [],
    statusByPath: new Map(),
  }),

  refresh: async (path, opts) => {
    set({ currentPath: path, loadingStatus: true });

    // Step 1: discover the repo root for this path. Negative-cached on the
    // backend so this is ~free for non-git folders.
    const repoRoot = await invoke<string | null>("git_get_repo_root", { path })
      .catch(() => null);

    // Bail if the user navigated away mid-flight.
    if (get().currentPath !== path) return;

    if (!repoRoot) {
      set({ loadingStatus: false, status: null, branches: [], commits: [], statusByPath: new Map() });
      return;
    }

    // Step 2-4: status / branches / commits in parallel. Each is independent;
    // we can show the panel as soon as `status` arrives if the others lag.
    const [status, branches, commits] = await Promise.all([
      invoke<RepoStatus>("git_get_repo_status", {
        repoRoot, includeIgnored: opts.dimIgnored,
      }).catch(() => null),
      invoke<BranchInfo[]>("git_get_branches", {
        repoRoot, includeRemote: false,
      }).catch(() => []),
      invoke<CommitInfo[]>("git_get_recent_commits", {
        repoRoot, n: opts.recentCommitsCount,
      }).catch(() => []),
    ]);

    // Stale check again — Promise.all can take seconds on large repos.
    if (get().currentPath !== path) return;

    const map = new Map<string, FileStatusEntry>();
    if (status) {
      for (const f of status.changed_files) map.set(f.path, f);
    }

    set({
      loadingStatus: false,
      status,
      branches,
      commits,
      statusByPath: map,
    });
  },
}));

// ── Convenience: resolve a status for an absolute-path entry ─────────────────
//
// FileList entries have absolute paths; the backend returns paths relative to
// repo root. This helper does the substring math once per call.
export function statusForAbsolutePath(
  absolutePath: string,
  status: RepoStatus | null,
  statusByPath: Map<string, FileStatusEntry>,
): FileStatusEntry | null {
  if (!status) return null;
  const root = status.info.repo_root.replace(/\\/g, "/").replace(/\/+$/, "");
  const abs = absolutePath.replace(/\\/g, "/");
  if (!abs.startsWith(root + "/")) return null;
  const rel = abs.slice(root.length + 1);
  return statusByPath.get(rel) ?? null;
}
