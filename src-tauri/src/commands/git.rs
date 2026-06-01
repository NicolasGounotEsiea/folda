//! Git integration — READ-ONLY. Status, branches, commits, diffs. No write ops
//! in V1: no stage, no commit, no push/pull, no branch switching. That's a
//! deliberate scope decision — nxs's job is "show me git context while I
//! browse", not "be a git client". A user who wants to act on the repo uses
//! their normal git tool.
//!
//! ## Architecture invariants
//!
//! - **Opt-in.** Every command assumes the caller has checked `settings.gitEnabled`
//!   on the frontend. We don't gate here so the commands stay deterministic and
//!   the frontend can disable git entirely without a roundtrip.
//! - **Detection is cached.** `get_repo_root` walks up looking for `.git` via
//!   `git2::Repository::discover`. Each result (positive AND negative) is cached
//!   in a process-wide LRU so navigating between siblings of a non-git folder
//!   is zero-cost after the first probe.
//! - **No write ops, ever.** If you add one, route it through a separate module
//!   so the read/write boundary stays explicit. Read-only also means: no auth,
//!   no network, no concurrent-write hazards with parallel git clients.
//! - **Concurrent access.** Another tool (VS Code, terminal git) may write the
//!   index while we read. libgit2 returns `ErrLock`/`ErrCorrupt` in that case;
//!   we wrap each command in a single 50ms retry and surface a stale-data hint
//!   to the frontend rather than crashing.
//! - **No persistent state.** No DB tables, no on-disk caches. Git itself is
//!   the source of truth; in-memory caches reset at every app start.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

// ── Detection cache ──────────────────────────────────────────────────────────
//
// Maps an arbitrary user path → its discovered repo root (or `None` if NOT in
// a repo — negative caching matters because most folders are not git repos and
// we don't want to re-walk on every navigation). LRU eviction keeps the cache
// bounded; CAP is generous because entries are cheap.

const DETECT_CACHE_CAP: usize = 64;

struct DetectCache {
    map: HashMap<PathBuf, Option<PathBuf>>,
    order: VecDeque<PathBuf>,
}

impl DetectCache {
    fn new() -> Self {
        Self { map: HashMap::new(), order: VecDeque::new() }
    }
    fn get(&self, key: &Path) -> Option<Option<PathBuf>> {
        self.map.get(key).cloned()
    }
    fn put(&mut self, key: PathBuf, value: Option<PathBuf>) {
        if !self.map.contains_key(&key) {
            self.order.push_back(key.clone());
            if self.order.len() > DETECT_CACHE_CAP {
                if let Some(evict) = self.order.pop_front() {
                    self.map.remove(&evict);
                }
            }
        }
        self.map.insert(key, value);
    }
    fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
    }
}

fn detect_cache() -> &'static Mutex<DetectCache> {
    static C: OnceLock<Mutex<DetectCache>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(DetectCache::new()))
}

// ── Public types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct RepoInfo {
    pub repo_root: String,
    /// `true` if HEAD is detached (no branch name).
    pub detached: bool,
    /// Empty string when detached or unborn.
    pub branch: String,
    /// Short SHA of HEAD (7 chars) or empty if the repo has no commits yet.
    pub head_sha: String,
    /// Commits ahead of upstream. `None` when there is no upstream configured.
    pub ahead: Option<usize>,
    pub behind: Option<usize>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileStatus {
    /// Tracked + working-tree differs from index.
    Modified,
    /// Newly created, not yet tracked (or staged-added but not committed yet).
    Added,
    /// Tracked but missing from working tree.
    Deleted,
    /// Renamed in the index.
    Renamed,
    /// Untracked file (not added).
    Untracked,
    /// Ignored via `.gitignore`.
    Ignored,
    /// Has unresolved merge conflicts.
    Conflicted,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileStatusEntry {
    pub path: String,        // path RELATIVE to repo root, forward slashes
    pub status: FileStatus,
    pub staged: bool,        // true if there are index changes (in addition to / instead of working tree)
}

#[derive(Debug, Clone, Serialize)]
pub struct RepoStatus {
    pub info: RepoInfo,
    pub changed_files: Vec<FileStatusEntry>,
    /// True if we hit ErrLock and the data may be slightly stale.
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    /// Unix timestamp of the branch tip's commit, or 0 if unavailable.
    pub last_commit_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitInfo {
    pub sha: String,
    pub short_sha: String,
    pub author_name: String,
    pub author_email: String,
    /// Unix timestamp.
    pub date: i64,
    /// Full message (first line + body). UI usually shows just the first line.
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitFileChange {
    pub path: String,
    pub change_type: String, // "A" | "M" | "D" | "R" | "T" — matches git's status letter
    pub diff: String,        // unified diff text
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitDiff {
    pub info: CommitInfo,
    pub files: Vec<CommitFileChange>,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn normalize_path_for_cache(path: &str) -> PathBuf {
    // Trim trailing slashes; libgit2 is finicky and the cache wants identity.
    PathBuf::from(path.trim_end_matches(['\\', '/']))
}

/// Runs `op` once, and on `ErrLock` / `ErrCorrupt` (concurrent writer hitting
/// the index) waits 50 ms and tries once more. Returns the final result + a
/// `stale` flag indicating we hit a transient error.
fn with_lock_retry<T>(mut op: impl FnMut() -> Result<T, git2::Error>) -> Result<(T, bool), git2::Error> {
    match op() {
        Ok(v) => Ok((v, false)),
        Err(e) if matches!(e.code(), git2::ErrorCode::Locked) => {
            std::thread::sleep(std::time::Duration::from_millis(50));
            op().map(|v| (v, true))
        }
        Err(e) => Err(e),
    }
}

fn file_status_from_flags(flags: git2::Status) -> Option<(FileStatus, bool)> {
    use git2::Status as S;
    // Order matters: conflicts dominate everything else; otherwise prefer the
    // most specific category.
    if flags.intersects(S::CONFLICTED) {
        return Some((FileStatus::Conflicted, false));
    }
    if flags.intersects(S::IGNORED) {
        return Some((FileStatus::Ignored, false));
    }
    let staged = flags.intersects(
        S::INDEX_NEW | S::INDEX_MODIFIED | S::INDEX_DELETED | S::INDEX_RENAMED | S::INDEX_TYPECHANGE,
    );
    if flags.intersects(S::WT_NEW) {
        return Some((FileStatus::Untracked, staged));
    }
    if flags.intersects(S::WT_DELETED) || flags.intersects(S::INDEX_DELETED) {
        return Some((FileStatus::Deleted, staged));
    }
    if flags.intersects(S::WT_RENAMED) || flags.intersects(S::INDEX_RENAMED) {
        return Some((FileStatus::Renamed, staged));
    }
    if flags.intersects(S::WT_MODIFIED) || flags.intersects(S::WT_TYPECHANGE) {
        return Some((FileStatus::Modified, staged));
    }
    if flags.intersects(S::INDEX_NEW) || flags.intersects(S::INDEX_MODIFIED) || flags.intersects(S::INDEX_TYPECHANGE) {
        return Some((FileStatus::Added, true));
    }
    None // clean — caller filters these out
}

fn build_repo_info(repo: &git2::Repository) -> RepoInfo {
    let repo_root = repo
        .workdir()
        .and_then(|p| p.to_str().map(|s| s.to_string()))
        .unwrap_or_default();

    let head = repo.head();
    let detached = repo.head_detached().unwrap_or(false);

    let (branch, head_sha) = match &head {
        Ok(r) => {
            let b = if detached {
                String::new()
            } else {
                r.shorthand().unwrap_or("").to_string()
            };
            let sha = r.target().map(|oid| {
                let s = oid.to_string();
                s.chars().take(7).collect::<String>()
            }).unwrap_or_default();
            (b, sha)
        }
        Err(_) => (String::new(), String::new()), // unborn HEAD on a fresh repo
    };

    let (ahead, behind) = if let Ok(h) = &head {
        h.target()
            .and_then(|local_oid| {
                let branch_name = h.shorthand()?;
                let local_branch = repo.find_branch(branch_name, git2::BranchType::Local).ok()?;
                let upstream = local_branch.upstream().ok()?;
                let upstream_oid = upstream.get().target()?;
                repo.graph_ahead_behind(local_oid, upstream_oid).ok()
            })
            .map(|(a, b)| (Some(a), Some(b)))
            .unwrap_or((None, None))
    } else {
        (None, None)
    };

    RepoInfo { repo_root, detached, branch, head_sha, ahead, behind }
}

// ── Tauri commands ───────────────────────────────────────────────────────────

/// Discover the repo root containing `path`, with cache. Returns `None` if the
/// path is not inside any git repo (negative-cached too).
#[tauri::command]
pub fn git_get_repo_root(path: String) -> Option<String> {
    let key = normalize_path_for_cache(&path);

    if let Ok(cache) = detect_cache().lock() {
        if let Some(hit) = cache.get(&key) {
            return hit.and_then(|p| p.to_str().map(|s| s.to_string()));
        }
    }

    // libgit2's `discover` walks up natively and handles `.git` files (worktrees,
    // submodules). Returns the path to the `.git` dir; we want the workdir parent.
    let result: Option<PathBuf> = git2::Repository::discover(&key)
        .ok()
        .and_then(|r| r.workdir().map(|p| p.to_path_buf()))
        .map(|p| PathBuf::from(p.to_string_lossy().trim_end_matches(['\\', '/']).to_string()));

    if let Ok(mut cache) = detect_cache().lock() {
        cache.put(key, result.clone());
    }

    result.and_then(|p| p.to_str().map(|s| s.to_string()))
}

/// Invalidate the entire detection cache. Called by the frontend when the user
/// toggles `gitEnabled` off→on so that any stale negatives are forgotten.
#[tauri::command]
pub fn git_clear_detection_cache() {
    if let Ok(mut cache) = detect_cache().lock() {
        cache.clear();
    }
}

/// Full status snapshot for a repo: branch info, ahead/behind, list of changed
/// files (with their statuses + a staged flag). Includes IGNORED entries when
/// `include_ignored` is true so the FileList can dim them.
#[tauri::command]
pub fn git_get_repo_status(repo_root: String, include_ignored: bool) -> Result<RepoStatus, String> {
    let repo = git2::Repository::open(&repo_root).map_err(|e| e.message().to_string())?;

    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(include_ignored);

    let (statuses, stale) = with_lock_retry(|| repo.statuses(Some(&mut opts)))
        .map_err(|e| e.message().to_string())?;

    let info = build_repo_info(&repo);

    let mut changed_files: Vec<FileStatusEntry> = Vec::new();
    for entry in statuses.iter() {
        if let Some((status, staged)) = file_status_from_flags(entry.status()) {
            if let Some(path) = entry.path() {
                changed_files.push(FileStatusEntry {
                    path: path.replace('\\', "/"),
                    status,
                    staged,
                });
            }
        }
    }

    Ok(RepoStatus { info, changed_files, stale })
}

/// All branches in the repo (local + remote). Sorted by last-commit-date desc
/// (current branch first regardless).
#[tauri::command]
pub fn git_get_branches(repo_root: String, include_remote: bool) -> Result<Vec<BranchInfo>, String> {
    let repo = git2::Repository::open(&repo_root).map_err(|e| e.message().to_string())?;

    let filter = if include_remote { None } else { Some(git2::BranchType::Local) };
    let iter = repo.branches(filter).map_err(|e| e.message().to_string())?;

    let mut out: Vec<BranchInfo> = Vec::new();
    for item in iter.flatten() {
        let (branch, btype) = item;
        let name = match branch.name() {
            Ok(Some(n)) => n.to_string(),
            _ => continue,
        };
        let is_current = branch.is_head();
        let last_commit_at = branch
            .get()
            .target()
            .and_then(|oid| repo.find_commit(oid).ok())
            .map(|c| c.time().seconds())
            .unwrap_or(0);

        out.push(BranchInfo {
            name,
            is_current,
            is_remote: matches!(btype, git2::BranchType::Remote),
            last_commit_at,
        });
    }

    // Current branch first, then by date desc.
    out.sort_by(|a, b| {
        b.is_current.cmp(&a.is_current).then(b.last_commit_at.cmp(&a.last_commit_at))
    });

    Ok(out)
}

/// Last `n` commits reachable from HEAD (newest first). Caps `n` to 200 — UI
/// loads more on scroll if needed (not implemented in V1 but the cap is here
/// so a misconfigured caller can't ask for 50 000).
#[tauri::command]
pub fn git_get_recent_commits(repo_root: String, n: usize) -> Result<Vec<CommitInfo>, String> {
    let n = n.min(200);
    let repo = git2::Repository::open(&repo_root).map_err(|e| e.message().to_string())?;

    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    if walk.push_head().is_err() {
        // Unborn HEAD or detached weirdness — return an empty list rather than failing.
        return Ok(Vec::new());
    }
    walk.set_sorting(git2::Sort::TIME).ok();

    let mut out: Vec<CommitInfo> = Vec::with_capacity(n);
    for oid in walk.flatten().take(n) {
        if let Ok(commit) = repo.find_commit(oid) {
            let author = commit.author();
            let sha = oid.to_string();
            let short_sha = sha.chars().take(7).collect::<String>();
            out.push(CommitInfo {
                sha,
                short_sha,
                author_name: author.name().unwrap_or("").to_string(),
                author_email: author.email().unwrap_or("").to_string(),
                date: commit.time().seconds(),
                message: commit.message().unwrap_or("").to_string(),
            });
        }
    }
    Ok(out)
}

/// Unified diff of a single working-tree file vs HEAD. Returns empty string
/// for clean files. `path` is relative to the repo root.
#[tauri::command]
pub fn git_get_file_diff(repo_root: String, path: String) -> Result<String, String> {
    let repo = git2::Repository::open(&repo_root).map_err(|e| e.message().to_string())?;

    let mut opts = git2::DiffOptions::new();
    opts.pathspec(&path)
        .context_lines(3)
        .interhunk_lines(1);

    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());

    let diff = repo
        .diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))
        .map_err(|e| e.message().to_string())?;

    let mut buf = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        let origin = line.origin();
        if matches!(origin, '+' | '-' | ' ') {
            buf.push(origin);
        }
        buf.push_str(std::str::from_utf8(line.content()).unwrap_or(""));
        true
    })
    .map_err(|e| e.message().to_string())?;

    Ok(buf)
}

/// Diff of all files changed in a single commit (vs its first parent).
/// Per-file unified diff text. For merge commits, diffs against the first
/// parent only — matching `git show`'s default behavior.
#[tauri::command]
pub fn git_get_commit_diff(repo_root: String, sha: String) -> Result<CommitDiff, String> {
    let repo = git2::Repository::open(&repo_root).map_err(|e| e.message().to_string())?;
    let oid = git2::Oid::from_str(&sha).map_err(|e| e.message().to_string())?;
    let commit = repo.find_commit(oid).map_err(|e| e.message().to_string())?;

    let info = CommitInfo {
        sha: oid.to_string(),
        short_sha: oid.to_string().chars().take(7).collect(),
        author_name: commit.author().name().unwrap_or("").to_string(),
        author_email: commit.author().email().unwrap_or("").to_string(),
        date: commit.time().seconds(),
        message: commit.message().unwrap_or("").to_string(),
    };

    let new_tree = commit.tree().map_err(|e| e.message().to_string())?;
    // First parent — None for root commit.
    let old_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());

    let diff = repo
        .diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), None)
        .map_err(|e| e.message().to_string())?;

    // Collect per-file diffs by accumulating into a per-delta buffer.
    let mut files: Vec<CommitFileChange> = Vec::new();
    let mut current_path = String::new();
    let mut current_change = String::new();
    let mut current_buf = String::new();

    diff.print(git2::DiffFormat::Patch, |delta, _hunk, line| {
        let new_path = delta
            .new_file()
            .path()
            .and_then(|p| p.to_str())
            .unwrap_or("")
            .replace('\\', "/");

        if new_path != current_path && !current_path.is_empty() {
            files.push(CommitFileChange {
                path: std::mem::take(&mut current_path),
                change_type: std::mem::take(&mut current_change),
                diff: std::mem::take(&mut current_buf),
            });
        }
        if current_path.is_empty() {
            current_path = new_path;
            current_change = match delta.status() {
                git2::Delta::Added => "A",
                git2::Delta::Deleted => "D",
                git2::Delta::Modified => "M",
                git2::Delta::Renamed => "R",
                git2::Delta::Typechange => "T",
                _ => "M",
            }
            .to_string();
        }

        let origin = line.origin();
        if matches!(origin, '+' | '-' | ' ') {
            current_buf.push(origin);
        }
        current_buf.push_str(std::str::from_utf8(line.content()).unwrap_or(""));
        true
    })
    .map_err(|e| e.message().to_string())?;

    if !current_path.is_empty() {
        files.push(CommitFileChange {
            path: current_path,
            change_type: current_change,
            diff: current_buf,
        });
    }

    Ok(CommitDiff { info, files })
}

/// Switch the working tree to a different local branch. The ONE write op we
/// expose — and we still don't touch history. `safe()` mode means libgit2
/// refuses to overwrite unsaved changes; we propagate that refusal verbatim
/// to the frontend so the user gets a clear "uncommitted changes" message
/// instead of silent data loss.
///
/// Refuses to checkout remote branches by name — caller must pass a LOCAL
/// branch (you can't sit on a remote ref). The frontend should filter the
/// branch list to local-only before exposing the button.
#[tauri::command]
pub fn git_checkout_branch(repo_root: String, branch_name: String) -> Result<(), String> {
    let repo = git2::Repository::open(&repo_root).map_err(|e| e.message().to_string())?;

    // Resolve the branch — must be local, must exist.
    let branch = repo
        .find_branch(&branch_name, git2::BranchType::Local)
        .map_err(|e| format!("Branch '{}' not found: {}", branch_name, e.message()))?;
    let reference = branch.into_reference();
    let ref_name = reference
        .name()
        .ok_or_else(|| "Branch reference has no name (corrupt ref?)".to_string())?
        .to_string();

    // Resolve target tree first — checkout needs an object, not a ref.
    let target = reference
        .peel_to_tree()
        .map_err(|e| format!("Cannot resolve branch tip tree: {}", e.message()))?;

    // checkout_tree with `safe()` matches `git checkout`'s default — refuses
    // when uncommitted changes would conflict. NO `force()` exposed: protecting
    // the user's working tree is non-negotiable for nxs.
    let mut opts = git2::build::CheckoutBuilder::new();
    opts.safe();
    repo.checkout_tree(target.as_object(), Some(&mut opts))
        .map_err(|e| match e.code() {
            git2::ErrorCode::Conflict => "Cannot switch — uncommitted changes would be overwritten. \
                 Commit, stash, or discard them first."
                .to_string(),
            _ => format!("Checkout failed: {}", e.message()),
        })?;

    // Move HEAD to the branch ref so subsequent commands see we're on it.
    repo.set_head(&ref_name)
        .map_err(|e| format!("Checkout succeeded but HEAD update failed: {}", e.message()))?;

    Ok(())
}

/// One entry of a per-file history: a commit that touched the file + the
/// diff of just that file in that commit.
#[derive(Debug, Clone, Serialize)]
pub struct FileHistoryEntry {
    pub commit: CommitInfo,
    pub diff: String,
}

/// Commits that touched a specific file, newest first. `path` is RELATIVE to
/// repo root. Returns at most `n` entries. We bound the upstream traversal at
/// `MAX_TRAVERSE` commits so a giant repo doesn't make us walk forever — if
/// the file hasn't been touched recently, we stop and return whatever we got.
#[tauri::command]
pub fn git_get_file_history(repo_root: String, path: String, n: usize) -> Result<Vec<FileHistoryEntry>, String> {
    const MAX_TRAVERSE: usize = 1000;
    let n = n.min(50);

    let repo = git2::Repository::open(&repo_root).map_err(|e| e.message().to_string())?;
    let path_buf = std::path::PathBuf::from(&path);

    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    if walk.push_head().is_err() {
        return Ok(Vec::new());
    }
    walk.set_sorting(git2::Sort::TIME).ok();

    let mut out: Vec<FileHistoryEntry> = Vec::with_capacity(n);

    for (traversed, oid) in walk.flatten().enumerate() {
        if traversed >= MAX_TRAVERSE || out.len() >= n {
            break;
        }

        let commit = match repo.find_commit(oid) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let new_tree = match commit.tree() { Ok(t) => t, Err(_) => continue };
        let old_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());

        // Pathspec-filtered diff: cheap when the file didn't change in this commit.
        let mut diff_opts = git2::DiffOptions::new();
        diff_opts.pathspec(&path).context_lines(3);

        let diff = match repo.diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), Some(&mut diff_opts)) {
            Ok(d) => d,
            Err(_) => continue,
        };

        // Check if any delta in the diff actually targets our path. pathspec
        // alone can match by directory prefix in some configs — confirm.
        let mut touched = false;
        diff.foreach(
            &mut |delta, _| {
                let new_p = delta.new_file().path().map(|p| p.to_path_buf());
                let old_p = delta.old_file().path().map(|p| p.to_path_buf());
                if new_p.as_deref() == Some(&path_buf) || old_p.as_deref() == Some(&path_buf) {
                    touched = true;
                }
                true
            },
            None, None, None,
        ).ok();

        if !touched {
            continue;
        }

        // Format the per-file diff.
        let mut buf = String::new();
        let _ = diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
            let origin = line.origin();
            if matches!(origin, '+' | '-' | ' ') {
                buf.push(origin);
            }
            buf.push_str(std::str::from_utf8(line.content()).unwrap_or(""));
            true
        });

        let author = commit.author();
        let sha = oid.to_string();
        out.push(FileHistoryEntry {
            commit: CommitInfo {
                short_sha: sha.chars().take(7).collect(),
                sha,
                author_name: author.name().unwrap_or("").to_string(),
                author_email: author.email().unwrap_or("").to_string(),
                date: commit.time().seconds(),
                message: commit.message().unwrap_or("").to_string(),
            },
            diff: buf,
        });
    }

    Ok(out)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_cache_evicts_oldest_when_full() {
        let mut c = DetectCache::new();
        for i in 0..DETECT_CACHE_CAP + 5 {
            c.put(PathBuf::from(format!("/p/{}", i)), None);
        }
        assert_eq!(c.map.len(), DETECT_CACHE_CAP, "cache size must stay capped");
        // Oldest 5 evicted, newest 64 kept
        assert!(c.get(Path::new("/p/0")).is_none());
        assert!(c.get(Path::new("/p/4")).is_none());
        assert!(c.get(Path::new("/p/5")).is_some());
    }

    #[test]
    fn detect_cache_returns_negative_results_as_some_none() {
        // Negative cache: we store "this path is NOT in a repo" as Some(None)
        // so callers can distinguish "never probed" from "probed, not in repo".
        let mut c = DetectCache::new();
        c.put(PathBuf::from("/some/path"), None);
        assert_eq!(c.get(Path::new("/some/path")), Some(None));
        assert_eq!(c.get(Path::new("/other")), None);
    }

    #[test]
    fn normalize_path_strips_trailing_separators() {
        assert_eq!(normalize_path_for_cache("C:\\foo\\"), PathBuf::from("C:\\foo"));
        assert_eq!(normalize_path_for_cache("/home/x/"), PathBuf::from("/home/x"));
        assert_eq!(normalize_path_for_cache("C:\\foo"), PathBuf::from("C:\\foo"));
    }

    #[test]
    fn file_status_conflict_dominates_other_flags() {
        let flags = git2::Status::CONFLICTED | git2::Status::WT_MODIFIED;
        let (status, _) = file_status_from_flags(flags).unwrap();
        assert!(matches!(status, FileStatus::Conflicted));
    }

    #[test]
    fn file_status_ignored_classified_correctly() {
        let (status, staged) = file_status_from_flags(git2::Status::IGNORED).unwrap();
        assert!(matches!(status, FileStatus::Ignored));
        assert!(!staged);
    }

    #[test]
    fn file_status_staged_modify_sets_staged_flag() {
        let flags = git2::Status::INDEX_MODIFIED | git2::Status::WT_MODIFIED;
        let (status, staged) = file_status_from_flags(flags).unwrap();
        assert!(matches!(status, FileStatus::Modified));
        assert!(staged, "INDEX_* flags should set staged=true alongside WT change");
    }

    #[test]
    fn file_status_clean_returns_none() {
        assert!(file_status_from_flags(git2::Status::CURRENT).is_none());
    }
}
