import { invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import { Clock } from "lucide-react";
import { useEffect, useState } from "react";
import { useStore } from "../store/useStore";
import type { ActivityEntry, ListEntry } from "../types";

function formatTime(unixSecs: number): string {
  return new Date(unixSecs * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDay(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

function groupByDay(entries: ActivityEntry[]): [string, ActivityEntry[]][] {
  const groups = new Map<string, ActivityEntry[]>();
  for (const e of entries) {
    const key = new Date(e.timestamp * 1000).toDateString();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }
  return [...groups.entries()].map(([, entries]) => [
    formatDay(entries[0].timestamp),
    entries,
  ]);
}

const ACTION_META: Record<string, { color: string; label: string }> = {
  created:  { color: "#22c55e", label: "Created"  },
  modified: { color: "#6366f1", label: "Modified" },
  opened:   { color: "#f59e0b", label: "Opened"   },
  renamed:  { color: "#06b6d4", label: "Renamed"  },
  deleted:  { color: "#ef4444", label: "Deleted"  },
  tagged:   { color: "#ec4899", label: "Tagged"   },
};

const ALL_ACTIONS = Object.keys(ACTION_META);

const RANGE_OPTIONS = [
  { label: "Today",    days: 1  },
  { label: "7 days",   days: 7  },
  { label: "30 days",  days: 30 },
  { label: "90 days",  days: 90 },
];

export function TimelineView() {
  const { currentPath, setCurrentPath, setListEntries, selectEntry, setViewMode, pushNav } = useStore();
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [rangeDays, setRangeDays] = useState(7);
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set());

  const toggleFilter = (action: string) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(action)) next.delete(action);
      else next.add(action);
      return next;
    });
  };

  const handleEntryClick = async (entry: ActivityEntry) => {
    const filePath = entry.file_path.replace(/\//g, "\\");
    const parts = filePath.split("\\");
    const parentPath = parts.slice(0, -1).join("\\") || filePath;
    try {
      const listEntries = await invoke<ListEntry[]>("list_directory", { path: parentPath });
      setCurrentPath(parentPath);
      pushNav(parentPath);
      setListEntries(listEntries);
      const match = listEntries.find((e) => e.path.replace(/\//g, "\\") === filePath);
      if (match && !match.is_dir) {
        selectEntry({
          kind: "file",
          entry: {
            id: match.id ?? -1,
            path: match.path,
            name: match.name,
            extension: match.extension,
            size: match.size,
            created_at: 0,
            modified_at: match.modified_at,
            accessed_at: 0,
            tags: match.tags,
          },
        });
      }
      setViewMode("explorer");
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    setLoading(true);
    const now = Math.floor(Date.now() / 1000);
    const from = now - rangeDays * 24 * 60 * 60;
    invoke<ActivityEntry[]>("get_timeline", { from, to: now, folder: currentPath || null })
      .then(setEntries)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [currentPath, rangeDays]);

  const visibleEntries = activeFilters.size === 0
    ? entries
    : entries.filter((e) => activeFilters.has(e.action));

  const groups = groupByDay(visibleEntries);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Filter bar */}
      <div className="shrink-0 flex items-center gap-2 px-6 py-2.5 border-b border-border-subtle bg-surface-1 flex-wrap">
        {/* Range selector */}
        <div className="flex items-center gap-0.5 mr-2">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              onClick={() => setRangeDays(opt.days)}
              className={clsx(
                "h-6 px-2.5 rounded text-[11px] transition-colors",
                rangeDays === opt.days
                  ? "bg-surface-3 text-text-primary font-medium"
                  : "text-text-muted hover:text-text-secondary hover:bg-surface-3"
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="w-px h-4 bg-border-subtle shrink-0" />

        {/* Action filters */}
        <div className="flex items-center gap-1 flex-wrap">
          {ALL_ACTIONS.map((action) => {
            const meta = ACTION_META[action];
            const active = activeFilters.has(action);
            return (
              <button
                key={action}
                onClick={() => toggleFilter(action)}
                className={clsx(
                  "h-6 px-2.5 rounded text-[11px] transition-all border",
                  active ? "border-transparent" : "border-transparent text-text-muted hover:text-text-secondary"
                )}
                style={active
                  ? { background: meta.color + "22", color: meta.color, borderColor: meta.color + "55" }
                  : undefined}
              >
                {meta.label}
              </button>
            );
          })}
          {activeFilters.size > 0 && (
            <button
              onClick={() => setActiveFilters(new Set())}
              className="h-6 px-2 rounded text-[11px] text-text-muted hover:text-text-primary transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Timeline content */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-full text-text-muted text-[12px]">
            Loading timeline…
          </div>
        ) : visibleEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-text-muted">
            <Clock size={28} className="opacity-20" />
            <span className="text-[12px]">No activity</span>
            <span className="text-[11px] opacity-60">
              {currentPath
                ? "No events in this folder for the selected period"
                : "Open and edit files to start tracking activity"}
            </span>
          </div>
        ) : (
          <div className="max-w-2xl mx-auto flex flex-col gap-8">
            {groups.map(([day, dayEntries]) => (
              <div key={day}>
                <h2 className="text-[11px] font-semibold text-text-muted uppercase tracking-widest mb-3">
                  {day}
                  <span className="ml-2 font-normal normal-case tracking-normal opacity-60">
                    {dayEntries.length} event{dayEntries.length !== 1 ? "s" : ""}
                  </span>
                </h2>
                <div className="relative flex flex-col gap-0">
                  <div className="absolute left-[7px] top-2 bottom-2 w-px bg-border" />
                  {dayEntries.map((entry) => {
                    const meta = ACTION_META[entry.action] ?? { color: "#555", label: entry.action };
                    return (
                      <button
                        key={entry.id}
                        onClick={() => handleEntryClick(entry)}
                        className="flex items-start gap-4 py-2 group text-left w-full rounded px-1 hover:bg-surface-2 transition-colors"
                      >
                        <div
                          className="w-3.5 h-3.5 rounded-full border-2 border-surface-1 shrink-0 mt-0.5 z-10"
                          style={{ background: meta.color }}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className="text-[10px] font-medium px-1.5 py-0.5 rounded capitalize shrink-0"
                              style={{ background: meta.color + "22", color: meta.color }}
                            >
                              {meta.label}
                            </span>
                            <span className="text-[12px] text-text-primary truncate">
                              {entry.file_name}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px] text-text-muted">{formatTime(entry.timestamp)}</span>
                            {entry.app_name && (
                              <span className="text-[10px] text-text-muted">via {entry.app_name}</span>
                            )}
                            <span className="text-[10px] text-text-muted opacity-0 group-hover:opacity-60 transition-opacity truncate max-w-[200px]">
                              {entry.file_path.replace(/\\/g, "/").split("/").slice(-3, -1).join("/")}
                            </span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
