import { invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import { Check, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useStore } from "../store/useStore";
import type { ListEntry } from "../types";

type Mode = "pattern" | "replace";

function applyPattern(
  name: string, ext: string, pattern: string, index: number,
  prefix: string, suffix: string,
): string {
  let result = pattern
    .replace(/\{name\}/g, name)
    .replace(/\{ext\}/g, ext)
    .replace(/\{n\}/g, String(index + 1))
    .replace(/\{nn\}/g, String(index + 1).padStart(2, "0"))
    .replace(/\{nnn\}/g, String(index + 1).padStart(3, "0"));
  return prefix + result + suffix + (ext ? "." + ext : "");
}

function applyReplace(
  fullName: string, find: string, replaceWith: string, caseSensitive: boolean,
): string {
  if (!find) return fullName;
  const flags = caseSensitive ? "g" : "gi";
  try {
    return fullName.replace(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags), replaceWith);
  } catch { return fullName; }
}

interface Props {
  entries: ListEntry[];
  onClose: () => void;
  onDone: () => void;
}

export function BulkRename({ entries, onClose, onDone }: Props) {
  useStore();
  const [mode, setMode] = useState<Mode>("replace");

  // Pattern mode
  const [pattern, setPattern] = useState("{name}");
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");

  // Replace mode
  const [find, setFind] = useState("");
  const [replaceWith, setReplaceWith] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);

  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Set<string>>(new Set());

  const previews = useMemo(() => {
    return entries.map((e, i) => {
      const dotIdx = e.name.lastIndexOf(".");
      const base = dotIdx > 0 ? e.name.slice(0, dotIdx) : e.name;
      const ext = dotIdx > 0 ? e.name.slice(dotIdx + 1) : "";

      let newName: string;
      if (mode === "pattern") {
        newName = applyPattern(base, ext, pattern, i, prefix, suffix);
      } else {
        newName = applyReplace(e.name, find, replaceWith, caseSensitive);
      }
      return { entry: e, newName, changed: newName !== e.name };
    });
  }, [entries, mode, pattern, prefix, suffix, find, replaceWith, caseSensitive]);

  const changedCount = previews.filter((p) => p.changed).length;

  const handleApply = async () => {
    setApplying(true);
    const newDone = new Set<string>();
    const newErrors = new Set<string>();

    for (const { entry, newName, changed } of previews) {
      if (!changed) continue;
      const parent = entry.path.replace(/\\/g, "/").split("/").slice(0, -1).join("\\");
      const newPath = (parent ? parent + "\\" : "") + newName;
      try {
        await invoke("rename_path", { oldPath: entry.path, newPath });
        newDone.add(entry.path);
      } catch {
        newErrors.add(entry.path);
      }
    }

    setDone(newDone);
    setErrors(newErrors);
    setApplying(false);
    if (newErrors.size === 0) {
      onDone();
    }
  };

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/60">
      <div className="bg-surface-2 border border-border rounded-xl shadow-2xl w-[600px] max-h-[80vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle shrink-0">
          <div>
            <h2 className="text-[14px] font-semibold text-text-primary">Bulk Rename</h2>
            <p className="text-[11px] text-text-muted mt-0.5">{entries.length} files selected</p>
          </div>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded text-text-muted hover:bg-surface-3 transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* Mode tabs */}
        <div className="flex items-center gap-1 px-5 pt-4 shrink-0">
          {(["replace", "pattern"] as Mode[]).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              className={clsx(
                "px-3 h-7 rounded text-[12px] transition-colors capitalize",
                mode === m ? "bg-accent text-white" : "bg-surface-3 text-text-muted hover:text-text-secondary"
              )}>
              {m === "replace" ? "Find & Replace" : "Pattern"}
            </button>
          ))}
        </div>

        {/* Controls */}
        <div className="px-5 py-4 shrink-0 flex flex-col gap-3">
          {mode === "replace" ? (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-[10px] text-text-muted mb-1 block">Find</label>
                  <input value={find} onChange={(e) => setFind(e.target.value)}
                    placeholder="Text to find…"
                    className="w-full h-7 px-2 rounded bg-surface-3 border border-border text-[12px] text-text-primary placeholder-text-muted outline-none focus:border-accent" />
                </div>
                <div className="flex-1">
                  <label className="text-[10px] text-text-muted mb-1 block">Replace with</label>
                  <input value={replaceWith} onChange={(e) => setReplaceWith(e.target.value)}
                    placeholder="Replacement…"
                    className="w-full h-7 px-2 rounded bg-surface-3 border border-border text-[12px] text-text-primary placeholder-text-muted outline-none focus:border-accent" />
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)}
                  className="w-3.5 h-3.5 rounded accent-accent" />
                <span className="text-[11px] text-text-muted">Case sensitive</span>
              </label>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div>
                <label className="text-[10px] text-text-muted mb-1 block">
                  Pattern — use <code className="bg-surface-3 px-1 rounded">{"{name}"}</code>, <code className="bg-surface-3 px-1 rounded">{"{ext}"}</code>, <code className="bg-surface-3 px-1 rounded">{"{n}"}</code>, <code className="bg-surface-3 px-1 rounded">{"{nn}"}</code>
                </label>
                <input value={pattern} onChange={(e) => setPattern(e.target.value)}
                  placeholder="{name}"
                  className="w-full h-7 px-2 rounded bg-surface-3 border border-border text-[12px] text-text-primary placeholder-text-muted outline-none focus:border-accent font-mono" />
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-[10px] text-text-muted mb-1 block">Prefix</label>
                  <input value={prefix} onChange={(e) => setPrefix(e.target.value)}
                    placeholder="Optional prefix…"
                    className="w-full h-7 px-2 rounded bg-surface-3 border border-border text-[12px] text-text-primary placeholder-text-muted outline-none focus:border-accent" />
                </div>
                <div className="flex-1">
                  <label className="text-[10px] text-text-muted mb-1 block">Suffix</label>
                  <input value={suffix} onChange={(e) => setSuffix(e.target.value)}
                    placeholder="Optional suffix…"
                    className="w-full h-7 px-2 rounded bg-surface-3 border border-border text-[12px] text-text-primary placeholder-text-muted outline-none focus:border-accent" />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Preview table */}
        <div className="flex-1 overflow-y-auto border-t border-border-subtle">
          <div className="grid grid-cols-[1fr_1fr_24px] gap-x-3 px-5 py-1.5 border-b border-border-subtle bg-surface-1 sticky top-0">
            <span className="text-[10px] text-text-muted uppercase tracking-wide">Original</span>
            <span className="text-[10px] text-text-muted uppercase tracking-wide">New name</span>
            <span />
          </div>
          {previews.map(({ entry, newName, changed }) => (
            <div key={entry.path}
              className={clsx("grid grid-cols-[1fr_1fr_24px] gap-x-3 px-5 py-1.5 border-b border-border-subtle/50",
                done.has(entry.path) && "opacity-40",
                errors.has(entry.path) && "bg-red-500/5")}>
              <span className="text-[11px] text-text-muted truncate">{entry.name}</span>
              <span className={clsx("text-[11px] truncate", changed ? "text-accent" : "text-text-muted")}>
                {newName}
              </span>
              <span className="flex items-center justify-center">
                {done.has(entry.path) && <Check size={12} className="text-emerald-400" />}
                {errors.has(entry.path) && <X size={12} className="text-red-400" />}
              </span>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-border-subtle shrink-0">
          <span className="text-[11px] text-text-muted">
            {changedCount} file{changedCount !== 1 ? "s" : ""} will be renamed
          </span>
          <div className="flex items-center gap-2">
            <button onClick={onClose}
              className="px-3 h-7 rounded text-[12px] text-text-secondary hover:bg-surface-3 transition-colors">
              Cancel
            </button>
            <button onClick={handleApply} disabled={changedCount === 0 || applying}
              className={clsx("px-4 h-7 rounded text-[12px] text-white transition-colors",
                changedCount === 0 || applying
                  ? "bg-accent/40 cursor-not-allowed"
                  : "bg-accent hover:bg-accent-glow")}>
              {applying ? "Renaming…" : `Rename ${changedCount}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
