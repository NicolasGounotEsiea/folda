import { invoke } from "@tauri-apps/api/core";
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
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
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

const ACTION_COLORS: Record<string, string> = {
  created: "#22c55e",
  modified: "#6366f1",
  opened: "#f59e0b",
  tagged: "#ec4899",
};

export function TimelineView() {
  const { currentPath, setCurrentPath, setListEntries, selectEntry, setViewMode, pushNav } = useStore();
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const handleEntryClick = async (entry: ActivityEntry) => {
    // Normalise to backslashes for Windows API calls
    const filePath = entry.file_path.replace(/\//g, "\\");
    const parts = filePath.split("\\");
    const parentPath = parts.slice(0, -1).join("\\") || filePath;
    try {
      const listEntries = await invoke<ListEntry[]>("list_directory", { path: parentPath });
      setCurrentPath(parentPath);
      pushNav(parentPath);
      setListEntries(listEntries);
      const match = listEntries.find(
        (e) => e.path.replace(/\//g, "\\") === filePath
      );
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
    const weekAgo = now - 7 * 24 * 60 * 60;
    invoke<ActivityEntry[]>("get_timeline", { from: weekAgo, to: now, folder: currentPath || null })
      .then(setEntries)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [currentPath]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted text-[12px]">
        Loading timeline…
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted">
        <Clock size={28} className="opacity-20" />
        <span className="text-[12px]">No recent activity</span>
        <span className="text-[11px] opacity-60">
          {currentPath ? "No activity in this folder" : "Open a folder to start tracking file activity"}
        </span>
      </div>
    );
  }

  const groups = groupByDay(entries);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto flex flex-col gap-8">
        {groups.map(([day, dayEntries]) => (
          <div key={day}>
            <h2 className="text-[11px] font-semibold text-text-muted uppercase tracking-widest mb-3">
              {day}
            </h2>
            <div className="relative flex flex-col gap-0">
              <div className="absolute left-[7px] top-2 bottom-2 w-px bg-border" />
              {dayEntries.map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => handleEntryClick(entry)}
                  className="flex items-start gap-4 py-2 group text-left w-full rounded px-1 hover:bg-surface-2 transition-colors"
                >
                  <div
                    className="w-3.5 h-3.5 rounded-full border-2 border-surface-1 shrink-0 mt-0.5 z-10"
                    style={{ background: ACTION_COLORS[entry.action] ?? "#555" }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-[10px] font-medium px-1.5 py-0.5 rounded capitalize"
                        style={{
                          background: (ACTION_COLORS[entry.action] ?? "#555") + "22",
                          color: ACTION_COLORS[entry.action] ?? "#888",
                        }}
                      >
                        {entry.action}
                      </span>
                      <span className="text-[12px] text-text-primary truncate">
                        {entry.file_name}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-text-muted">
                        {formatTime(entry.timestamp)}
                      </span>
                      {entry.app_name && (
                        <span className="text-[10px] text-text-muted">
                          via {entry.app_name}
                        </span>
                      )}
                      <span className="text-[10px] text-text-muted opacity-0 group-hover:opacity-60 transition-opacity truncate max-w-[180px]">
                        {entry.file_path.replace(/\\/g, "/").split("/").slice(-2).join("/")}
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
