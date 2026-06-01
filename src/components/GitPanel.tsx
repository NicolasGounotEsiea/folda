import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronRight, FileText, GitBranch, GitCommit, History, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useGitStore, type CommitDiff, type CommitInfo, type FileStatus } from "../store/useGitStore";
import { useStore } from "../store/useStore";
import { useToastStore } from "../store/useToastStore";
import { useTranslation } from "../utils/i18n";

// ── Visual mapping ────────────────────────────────────────────────────────────
//
// Status → color used in both badges (FileList) and the changed-files list here.
// Convention follows VSCode's source-control gutter palette so devs spot it
// without learning a new code.

export function statusColor(s: FileStatus): string {
  switch (s) {
    case "modified":   return "bg-amber-400";
    case "added":      return "bg-emerald-400";
    case "deleted":    return "bg-red-400";
    case "renamed":    return "bg-blue-400";
    case "untracked":  return "bg-sky-400";
    case "ignored":    return "bg-text-muted";
    case "conflicted": return "bg-pink-500";
  }
}

export function statusLetter(s: FileStatus): string {
  switch (s) {
    case "modified":   return "M";
    case "added":      return "A";
    case "deleted":    return "D";
    case "renamed":    return "R";
    case "untracked":  return "?";
    case "ignored":    return "!";
    case "conflicted": return "C";
  }
}

// ── Diff renderer ─────────────────────────────────────────────────────────────
//
// Simple colored unified-diff viewer. No CodeMirror dependency for V1 — just
// styled <pre> rows so we don't pay the bundle cost. Side-by-side mode lands
// in V2 if anyone asks.

export function DiffView({ diff }: { diff: string }) {
  if (!diff) {
    return (
      <p className="text-[10px] text-text-muted italic px-3 py-2">No textual diff (binary file, mode change, or already clean)</p>
    );
  }
  const lines = diff.split("\n");
  // Cap visual height — large diffs would otherwise hog the entire scroll region.
  // Internal scroll keeps the diff scannable without breaking the panel layout.
  return (
    <pre className="text-[10px] leading-tight font-mono overflow-auto" style={{ maxHeight: 300 }}>
      {lines.map((line, i) => {
        // We never strip the leading +/-/space because the backend already
        // ensures every non-header line starts with one of them.
        let cls = "text-text-secondary";
        if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index "))
          cls = "text-text-muted";
        else if (line.startsWith("@@"))
          cls = "text-blue-400 bg-blue-500/5";
        else if (line.startsWith("+"))
          cls = "text-emerald-400 bg-emerald-500/5";
        else if (line.startsWith("-"))
          cls = "text-red-400 bg-red-500/5";
        return (
          <div key={i} className={`px-3 ${cls}`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

// ── Per-file inline diff (working tree vs HEAD) ───────────────────────────────

export function FileDiff({ repoRoot, path }: { repoRoot: string; path: string }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    invoke<string>("git_get_file_diff", { repoRoot, path })
      .then(setDiff)
      .catch(() => setDiff(""))
      .finally(() => setLoading(false));
  }, [repoRoot, path]);

  if (loading) return <p className="text-[10px] text-text-muted px-3 py-2">Loading diff…</p>;
  return <DiffView diff={diff ?? ""} />;
}

// ── Per-commit diff (lazy) ────────────────────────────────────────────────────

function CommitDetail({ repoRoot, sha }: { repoRoot: string; sha: string }) {
  const [detail, setDetail] = useState<CommitDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [openIdx, setOpenIdx] = useState<number | null>(0); // first file expanded by default

  useEffect(() => {
    setLoading(true);
    invoke<CommitDiff>("git_get_commit_diff", { repoRoot, sha })
      .then((d) => { setDetail(d); setOpenIdx(d.files.length > 0 ? 0 : null); })
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [repoRoot, sha]);

  if (loading) return <p className="text-[10px] text-text-muted px-3 py-2">Loading commit…</p>;
  if (!detail) return <p className="text-[10px] text-red-400 px-3 py-2">Could not load commit</p>;

  return (
    <div className="flex flex-col gap-1.5 py-1.5">
      <div className="px-3 text-[10px] text-text-muted">
        {detail.files.length} file{detail.files.length === 1 ? "" : "s"} changed
      </div>
      {detail.files.map((f, i) => (
        <div key={i} className="border-t border-border-subtle pt-1.5">
          <button
            onClick={() => setOpenIdx(openIdx === i ? null : i)}
            className="w-full flex items-center gap-1.5 px-3 py-1 text-[11px] text-text-secondary hover:bg-surface-3 transition-colors text-left"
          >
            {openIdx === i ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            <span className="text-[9px] font-mono uppercase text-text-muted w-3 shrink-0">{f.change_type}</span>
            <span className="truncate flex-1" title={f.path}>{f.path}</span>
          </button>
          {openIdx === i && <DiffView diff={f.diff} />}
        </div>
      ))}
    </div>
  );
}

// ── Helper: relative timestamp ────────────────────────────────────────────────

export function formatRelativeDate(unixSec: number, t: ReturnType<typeof useTranslation>): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return t.gitJustNow;
  if (diff < 3600) return t.gitMinutesAgo.replace("{n}", String(Math.floor(diff / 60)));
  if (diff < 86400) return t.gitHoursAgo.replace("{n}", String(Math.floor(diff / 3600)));
  if (diff < 86400 * 30) return t.gitDaysAgo.replace("{n}", String(Math.floor(diff / 86400)));
  // Older: show the date.
  return new Date(unixSec * 1000).toLocaleDateString();
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function GitPanel() {
  const t = useTranslation();
  const settings = useStore((s) => s.settings);
  const currentPath = useStore((s) => s.currentPath);

  const status = useGitStore((s) => s.status);
  const branches = useGitStore((s) => s.branches);
  const commits = useGitStore((s) => s.commits);
  const loading = useGitStore((s) => s.loadingStatus);
  const refresh = useGitStore((s) => s.refresh);
  const clear = useGitStore((s) => s.clear);

  // Section open/close state (changed files / branches / commits) — local to
  // the panel, not persisted. "Changes" open by default since it's the most
  // common look.
  const [showChanges, setShowChanges] = useState(true);
  const [showBranches, setShowBranches] = useState(false);
  const [showCommits, setShowCommits] = useState(true);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  // Panel-wide collapse: when true, only the header (branch + ahead/behind) is
  // shown. Local state — re-expand on next mount is fine, no need for storage.
  const [collapsed, setCollapsed] = useState(false);
  // True while a checkout is in flight — disables the branches list to prevent
  // a double-click triggering two simultaneous switches.
  const [checkingOut, setCheckingOut] = useState(false);

  // Trigger a refresh whenever the user navigates OR git is freshly enabled.
  useEffect(() => {
    if (!settings.gitEnabled || !currentPath) {
      clear();
      return;
    }
    refresh(currentPath, {
      dimIgnored: settings.gitDimIgnored,
      recentCommitsCount: settings.gitRecentCommitsCount,
    });
  }, [settings.gitEnabled, settings.gitDimIgnored, settings.gitRecentCommitsCount, currentPath, refresh, clear]);

  // Don't render if git is disabled or current path is not in a repo.
  if (!settings.gitEnabled) return null;
  if (loading && !status) {
    return (
      <div className="px-3 py-2 border-t border-border-subtle flex items-center gap-1.5 text-[11px] text-text-muted">
        <Loader2 size={11} className="animate-spin" /> {t.gitLoading}
      </div>
    );
  }
  if (!status) return null;

  const branchLabel = status.info.detached
    ? `(detached @ ${status.info.head_sha})`
    : status.info.branch || "(unborn)";

  return (
    // Cap total panel height + make the sections region scrollable. Without
    // this, a repo with 100 changed files would push the Automations/Trash
    // sections below it off-screen. Header stays sticky so the user always
    // knows which branch they're looking at while scrolling.
    <div
      className="border-t border-border-subtle flex flex-col text-[12px] shrink-0"
      style={{ maxHeight: "45vh" }}
    >
      {/* Header — branch + ahead/behind + collapse toggle. Clicking anywhere on
          the header except the chevron does nothing (kept for affordance). The
          chevron is the only collapse trigger. */}
      <div className="px-3 py-2 flex items-center gap-2 bg-surface-2/40 shrink-0 border-b border-border-subtle">
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="w-4 h-4 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors shrink-0"
          title={collapsed ? t.gitExpand : t.gitCollapse}
        >
          {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
        </button>
        <GitBranch size={12} className="text-accent shrink-0" />
        <span className="text-text-primary font-medium truncate flex-1" title={branchLabel}>
          {branchLabel}
        </span>
        {status.info.ahead != null && status.info.behind != null && (
          <span className="text-[10px] text-text-muted shrink-0" title={t.gitAheadBehindTitle}>
            ↑{status.info.ahead} ↓{status.info.behind}
          </span>
        )}
        {status.stale && (
          <span className="text-[9px] text-amber-400" title={t.gitStaleHint}>⚠ stale</span>
        )}
      </div>

      {/* Sections region — only rendered when expanded. Folded state shows only
          the header, freeing screen real estate without unmounting the panel. */}
      {!collapsed && (
      <div className="flex-1 overflow-y-auto min-h-0">

      {/* Changed files */}
      <Section
        label={`${t.gitChanges} (${status.changed_files.filter((f) => f.status !== "ignored").length})`}
        open={showChanges}
        onToggle={() => setShowChanges((v) => !v)}
      >
        {status.changed_files.length === 0 ? (
          <p className="px-3 py-1 text-[10px] text-text-muted italic">{t.gitNoChanges}</p>
        ) : (
          status.changed_files
            .filter((f) => f.status !== "ignored")
            .map((f) => (
              // No border between rows — relies on hover highlight + tight
              // spacing for separation. The previous border-b/40 looked like a
              // wall of rails in the dark theme.
              <div key={f.path}>
                <button
                  onClick={() => setExpandedFile(expandedFile === f.path ? null : f.path)}
                  className="w-full flex items-center gap-1.5 px-3 py-1 hover:bg-surface-3 transition-colors text-left"
                >
                  {expandedFile === f.path ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
                  <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${statusColor(f.status)}`} />
                  <span className="text-[9px] font-mono uppercase text-text-muted w-2 shrink-0">
                    {statusLetter(f.status)}
                  </span>
                  <span className="truncate text-[11px] text-text-secondary" title={f.path}>
                    {f.path}
                  </span>
                  {f.staged && (
                    <span className="text-[8px] uppercase tracking-wide text-emerald-400 shrink-0">staged</span>
                  )}
                </button>
                {expandedFile === f.path && (
                  <div className="bg-surface-0/50">
                    <FileDiff repoRoot={status.info.repo_root} path={f.path} />
                  </div>
                )}
              </div>
            ))
        )}
      </Section>

      {/* Branches — click to checkout. We use `window.confirm` (native, ugly
          but reliable) rather than a custom modal because checkout is a rare
          action and an "are you sure" dialog is fully accessible by default. */}
      <Section
        label={`${t.gitBranches} (${branches.length})`}
        open={showBranches}
        onToggle={() => setShowBranches((v) => !v)}
      >
        {branches.length === 0 ? (
          <p className="px-3 py-1 text-[10px] text-text-muted italic">{t.gitNoBranches}</p>
        ) : (
          branches.map((b) => (
            <button
              key={b.name}
              disabled={b.is_current || b.is_remote || checkingOut}
              onClick={async () => {
                if (b.is_current || b.is_remote) return;
                const msg = t.gitCheckoutConfirm.replace("{name}", b.name);
                if (!window.confirm(msg)) return;
                setCheckingOut(true);
                try {
                  await invoke("git_checkout_branch", {
                    repoRoot: status.info.repo_root,
                    branchName: b.name,
                  });
                  // Refresh the git state for currentPath. The file watcher will
                  // also fire as files change on disk, but explicit refresh is
                  // snappier and ensures the UI reflects the new branch before
                  // the user clicks anything else.
                  await useGitStore.getState().refresh(currentPath ?? status.info.repo_root, {
                    dimIgnored: settings.gitDimIgnored,
                    recentCommitsCount: settings.gitRecentCommitsCount,
                  });
                  // Refresh the file list too — files may have been added /
                  // removed / modified by the checkout.
                  if (currentPath) {
                    try {
                      const entries = await invoke<import("../types").ListEntry[]>("list_directory", {
                        path: currentPath,
                        contextId: useStore.getState().activeContextId ?? 0,
                      });
                      useStore.getState().setListEntries(entries);
                    } catch { /* directory may have disappeared on the new branch */ }
                  }
                  useToastStore.getState().addToast({
                    type: "success",
                    message: t.gitCheckoutSuccess.replace("{name}", b.name),
                  });
                } catch (e) {
                  useToastStore.getState().addToast({
                    type: "error",
                    message: t.gitCheckoutFailed,
                    detail: String(e),
                  });
                } finally {
                  setCheckingOut(false);
                }
              }}
              className={`w-full text-left px-3 py-1 flex items-center gap-1.5 text-[11px] transition-colors ${
                b.is_current
                  ? "text-accent cursor-default"
                  : b.is_remote
                    ? "text-text-muted italic cursor-not-allowed"
                    : "text-text-secondary hover:bg-surface-3 hover:text-text-primary cursor-pointer"
              } ${checkingOut && !b.is_current ? "opacity-50 cursor-wait" : ""}`}
              title={b.is_current ? t.gitCurrentBranch : b.is_remote ? t.gitRemoteBranchUnclickable : t.gitClickToCheckout}
            >
              <GitBranch size={9} className="shrink-0" />
              <span className="truncate flex-1" title={b.name}>{b.name}</span>
              {b.last_commit_at > 0 && (
                <span className="text-[9px] text-text-muted shrink-0">
                  {formatRelativeDate(b.last_commit_at, t)}
                </span>
              )}
            </button>
          ))
        )}
      </Section>

      {/* Commits */}
      <Section
        label={`${t.gitCommits} (${commits.length})`}
        open={showCommits}
        onToggle={() => setShowCommits((v) => !v)}
      >
        {commits.length === 0 ? (
          <p className="px-3 py-1 text-[10px] text-text-muted italic">{t.gitNoCommits}</p>
        ) : (
          commits.map((c) => (
            <CommitRow
              key={c.sha}
              commit={c}
              repoRoot={status.info.repo_root}
              expanded={expandedCommit === c.sha}
              onToggle={() => setExpandedCommit(expandedCommit === c.sha ? null : c.sha)}
            />
          ))
        )}
      </Section>
      </div>
      )}
    </div>
  );
}

function Section({
  label, open, onToggle, children,
}: {
  label: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  // Section dividers were `border-border-subtle/60` — too contrasty in the dark
  // theme, especially where they stacked with the header's own border. We use
  // `border-border-subtle/25` (almost imperceptible) and let the all-caps header
  // text + slight bg tint do the visual separation work. `first:border-t-0`
  // prevents a double-line at the boundary with the panel header.
  return (
    <div className="border-t border-border-subtle/25 first:border-t-0">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-widest text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors bg-surface-2/30"
      >
        {open ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
        <span className="flex-1 text-left">{label}</span>
      </button>
      {open && <div className="pb-1">{children}</div>}
    </div>
  );
}

function CommitRow({
  commit, repoRoot, expanded, onToggle,
}: {
  commit: CommitInfo; repoRoot: string; expanded: boolean; onToggle: () => void;
}) {
  const t = useTranslation();
  // First line of the message — the rest is body that we don't show in the row.
  const subject = useMemo(() => commit.message.split("\n", 1)[0] ?? "", [commit.message]);

  return (
    // No row-level border. Each commit is already a 2-line block (subject + meta);
    // a touch of py-1.5 gives the breathing room that separators used to provide.
    // The expanded body keeps its top border because the visual context shift
    // (from list of commits to diff content) genuinely warrants a hard line.
    <div>
      <button
        onClick={onToggle}
        className="w-full px-3 py-1.5 hover:bg-surface-3 transition-colors text-left"
      >
        <div className="flex items-center gap-1.5">
          {expanded
            ? <ChevronDown size={9} className="text-text-muted shrink-0" />
            : <GitCommit size={9} className="text-text-muted shrink-0" />}
          <span className="text-[11px] text-text-secondary truncate flex-1" title={subject}>
            {subject || "(empty message)"}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 pl-4 text-[9px] text-text-muted">
          <span className="font-mono">{commit.short_sha}</span>
          <span>·</span>
          <span className="truncate">{commit.author_name}</span>
          <span>·</span>
          <span className="shrink-0">{formatRelativeDate(commit.date, t)}</span>
        </div>
      </button>
      {expanded && (
        <div className="bg-surface-0/50 border-t border-border-subtle/30">
          <CommitDetail repoRoot={repoRoot} sha={commit.sha} />
        </div>
      )}
    </div>
  );
}

// Re-export for compat with the file-list badge wiring.
export { History, FileText };
