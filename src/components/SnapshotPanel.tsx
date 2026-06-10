import { invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import { Clock, History, RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";

interface Snapshot {
  id: number;
  file_path: string;
  timestamp: number;
  size: number;
}

type DiffLine = { type: "keep" | "add" | "remove"; text: string };

function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const m = a.length, n = b.length;

  // LCS DP (O(m*n) — fine for code files ≤1 MB)
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const result: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) { result.push({ type: "keep",   text: a[i] }); i++; j++; }
    else if (j < n && (i >= m || dp[i + 1][j] <= dp[i][j + 1])) { result.push({ type: "add",    text: b[j] }); j++; }
    else                                                           { result.push({ type: "remove", text: a[i] }); i++; }
  }
  return result;
}

/** Collapse long unchanged runs, keeping `ctx` lines of context around changes. */
function collapseContext(lines: DiffLine[], ctx = 3): (DiffLine | { type: "sep"; skipped: number })[] {
  const changed = lines.map((l) => l.type !== "keep");
  const visible = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++)
    if (changed[i])
      for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++)
        visible[k] = true;

  const out: (DiffLine | { type: "sep"; skipped: number })[] = [];
  let skip = 0;
  for (let i = 0; i < lines.length; i++) {
    if (visible[i]) {
      if (skip > 0) { out.push({ type: "sep", skipped: skip }); skip = 0; }
      out.push(lines[i]);
    } else {
      skip++;
    }
  }
  if (skip > 0) out.push({ type: "sep", skipped: skip });
  return out;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

// ── Diff modal ────────────────────────────────────────────────────────────────

interface DiffModalProps {
  snap: Snapshot;
  snapContent: string;
  currentContent: string;
  onClose: () => void;
  onRestore: () => void;
  restoring: boolean;
}

function DiffModal({ snap, snapContent, currentContent, onClose, onRestore, restoring }: DiffModalProps) {
  const lines = diffLines(snapContent, currentContent);
  const collapsed = collapseContext(lines);
  const added   = lines.filter((l) => l.type === "add").length;
  const removed = lines.filter((l) => l.type === "remove").length;
  const noDiff  = added === 0 && removed === 0;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div className="modal-backdrop-in fixed inset-0 z-[300] flex items-center justify-center bg-black/60">
      <div className="modal-content-in bg-surface-1 border border-border rounded-xl shadow-2xl flex flex-col w-[760px] max-w-[95vw] h-[80vh] max-h-[700px]">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 h-11 border-b border-border-subtle shrink-0">
          <History size={13} className="text-accent shrink-0" />
          <span className="text-[12px] font-medium text-text-primary flex-1 min-w-0 truncate">
            Snapshot #{snap.id} — {formatDate(snap.timestamp)}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            {noDiff ? (
              <span className="text-[10px] text-text-muted">Identical to current</span>
            ) : (
              <>
                {added   > 0 && <span className="text-[10px] text-emerald-400">+{added}</span>}
                {removed > 0 && <span className="text-[10px] text-red-400">-{removed}</span>}
              </>
            )}
            <button
              onClick={onRestore}
              disabled={restoring}
              className="flex items-center gap-1 h-6 px-2.5 rounded text-[11px] bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-40"
            >
              <RotateCcw size={10} />
              {restoring ? "Restoring…" : "Restore"}
            </button>
            <button
              onClick={onClose}
              className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
            >
              <X size={13} />
            </button>
          </div>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 px-4 h-7 border-b border-border-subtle bg-surface-0 shrink-0 text-[10px] text-text-muted">
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-red-500/30 inline-block" />Snapshot (removed in current)</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500/20 inline-block" />Current (added vs snapshot)</span>
        </div>

        {/* Diff body */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto font-mono text-[11px] bg-surface-0">
          {noDiff ? (
            <div className="flex items-center justify-center h-full text-text-muted text-[12px]">
              No differences — snapshot is identical to current file.
            </div>
          ) : (
            <table className="w-full border-collapse">
              <tbody>
                {collapsed.map((entry, idx) => {
                  if ("skipped" in entry) {
                    return (
                      <tr key={idx} className="bg-surface-2">
                        <td colSpan={3} className="px-4 py-0.5 text-[10px] text-text-muted select-none">
                          ···  {entry.skipped} unchanged line{entry.skipped > 1 ? "s" : ""}
                        </td>
                      </tr>
                    );
                  }
                  const l = entry as DiffLine;
                  const bg =
                    l.type === "add"    ? "bg-emerald-950/60 hover:bg-emerald-950/80" :
                    l.type === "remove" ? "bg-red-950/60 hover:bg-red-950/80" :
                    "hover:bg-surface-2";
                  const sign = l.type === "add" ? "+" : l.type === "remove" ? "−" : " ";
                  const signColor =
                    l.type === "add"    ? "text-emerald-400 select-none w-5 text-center" :
                    l.type === "remove" ? "text-red-400 select-none w-5 text-center" :
                    "text-text-muted select-none w-5 text-center";
                  return (
                    <tr key={idx} className={clsx("transition-colors", bg)}>
                      <td className={clsx("pl-4 pr-1 py-px", signColor)}>{sign}</td>
                      <td className="pr-4 py-px text-text-secondary whitespace-pre-wrap break-all">{l.text || " "}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

interface SnapshotPanelProps {
  filePath: string;
  currentContent?: string;
  isBinary?: boolean;
  onClose: () => void;
  onRestored: () => void;
}

export function SnapshotPanel({ filePath, currentContent, isBinary = false, onClose, onRestored }: SnapshotPanelProps) {
  const { settings } = useStore();
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  // Diff modal state
  const [diffSnap, setDiffSnap] = useState<Snapshot | null>(null);
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const snaps = await invoke<Snapshot[]>("get_snapshots", { filePath });
      setSnapshots(snaps);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [filePath]);

  useEffect(() => { load(); }, [load]);

  const handleManualSnapshot = async () => {
    setCreating(true);
    try {
      await invoke("create_snapshot", { filePath, maxCount: settings.snapshotMaxCount });
      await load();
    } catch { /* ignore */ }
    finally { setCreating(false); }
  };

  const handleOpenDiff = async (snap: Snapshot) => {
    setDiffLoading(true);
    setDiffSnap(snap);
    try {
      const content = await invoke<string>("get_snapshot_content", { snapshotId: snap.id });
      setDiffContent(content);
    } catch {
      setDiffContent("");
    } finally {
      setDiffLoading(false);
    }
  };

  const handleRestore = async (snap: Snapshot) => {
    setRestoring(snap.id);
    try {
      await invoke("restore_snapshot", { snapshotId: snap.id, filePath });
      setDiffSnap(null);
      setDiffContent(null);
      onRestored();
    } catch { /* ignore */ }
    finally { setRestoring(null); }
  };

  const handleDelete = async (snap: Snapshot) => {
    try {
      await invoke("delete_snapshot", { snapshotId: snap.id });
      setSnapshots((prev) => prev.filter((s) => s.id !== snap.id));
      if (diffSnap?.id === snap.id) { setDiffSnap(null); setDiffContent(null); }
    } catch { /* ignore */ }
  };

  return (
    <>
      <div className="w-64 shrink-0 bg-surface-1 border-l border-border-subtle flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-3 h-10 border-b border-border-subtle shrink-0">
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-text-primary">
            <History size={12} className="text-accent" />
            Snapshots
          </span>
          <div className="flex items-center gap-1">
            {(isBinary || settings.snapshotMode === "manual") && (
              <button
                onClick={handleManualSnapshot}
                disabled={creating}
                title="Create snapshot now"
                className="h-5 px-2 rounded text-[10px] bg-accent text-white disabled:opacity-40 hover:bg-accent/80 transition-colors"
              >
                {creating ? "Saving…" : "+ Save"}
              </button>
            )}
            <button
              onClick={onClose}
              className="w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
            >
              <X size={11} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-3 text-[10px] text-text-muted animate-pulse">Loading…</div>
          ) : snapshots.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-text-muted py-8">
              <Clock size={20} className="opacity-30" />
              <span className="text-[10px]">No snapshots yet</span>
              {settings.snapshotMode === "manual" && (
                <span className="text-[10px] opacity-60">Click "+ Save" to create one</span>
              )}
              {isBinary && settings.snapshotMode === "auto" && (
                <span className="text-[10px] opacity-60">Use "+ Save" to create one manually</span>
              )}
            </div>
          ) : (
            <div className="flex flex-col">
              {snapshots.map((snap, i) => (
                <button
                  key={snap.id}
                  onClick={() => { if (!isBinary) handleOpenDiff(snap); }}
                  className={clsx(
                    "group text-left flex flex-col gap-0.5 px-3 py-2 border-b border-border-subtle w-full",
                    "hover:bg-surface-2 transition-colors",
                    !isBinary && diffSnap?.id === snap.id && "bg-surface-2 ring-1 ring-inset ring-accent/30",
                    isBinary && "cursor-default"
                  )}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[10px] text-text-secondary font-mono">
                      {i === 0 ? (
                        <span className="text-accent font-semibold">Latest</span>
                      ) : (
                        `#${snapshots.length - i}`
                      )}
                    </span>
                    <span className="text-[9px] text-text-muted">{formatSize(snap.size)}</span>
                  </div>
                  <span className="text-[10px] text-text-muted leading-relaxed">
                    {formatDate(snap.timestamp)}
                  </span>
                  <div className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleRestore(snap); }}
                      disabled={restoring === snap.id}
                      title="Restore this snapshot"
                      className="flex items-center gap-0.5 h-5 px-1.5 rounded text-[10px] bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-40"
                    >
                      <RotateCcw size={9} />
                      {restoring === snap.id ? "Restoring…" : "Restore"}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(snap); }}
                      title="Delete snapshot"
                      className="w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      <Trash2 size={9} />
                    </button>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Diff modal — text files only */}
      {!isBinary && diffSnap && (
        diffLoading ? (
          <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60">
            <span className="text-text-muted text-[12px] animate-pulse">Loading diff…</span>
          </div>
        ) : diffContent !== null ? (
          <DiffModal
            snap={diffSnap}
            snapContent={diffContent}
            currentContent={currentContent ?? ""}
            onClose={() => { setDiffSnap(null); setDiffContent(null); }}
            onRestore={() => handleRestore(diffSnap)}
            restoring={restoring === diffSnap.id}
          />
        ) : null
      )}
    </>
  );
}
