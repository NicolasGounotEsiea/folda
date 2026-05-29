import { invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import { CalendarDays, CalendarPlus, Clock, Plus, StickyNote, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { DatePicker } from "./DatePicker";
import { TimePicker } from "./TimePicker";

interface Props {
  onClose: () => void;
}

interface Task {
  id: string;
  done: boolean;
  text: string;
  due?: string; // YYYY-MM-DD
}

interface NotesState {
  tasks: Task[];
  notes: string;
}

const EMPTY: NotesState = { tasks: [], notes: "" };

/// Parse the workspace note. New format is JSON ({ tasks, notes }). Older sessions
/// stored raw markdown; we keep their content under `notes` so nothing is lost.
function parseStored(raw: string): NotesState {
  if (!raw || !raw.trim()) return { ...EMPTY };
  try {
    const j = JSON.parse(raw);
    if (j && Array.isArray(j.tasks) && typeof j.notes === "string") {
      // Defensive normalization — accept both "YYYY-MM-DD" (date only)
      // and "YYYY-MM-DDTHH:MM" (date + time) for the due field.
      const tasks = j.tasks
        .filter((t: unknown): t is Task => !!t && typeof t === "object" && typeof (t as Task).text === "string")
        .map((t: Task) => ({
          id: typeof t.id === "string" ? t.id : Math.random().toString(36).slice(2, 10),
          done: !!t.done,
          text: t.text,
          due: typeof t.due === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(t.due) ? t.due : undefined,
        }));
      return { tasks, notes: j.notes };
    }
  } catch {
    /* not JSON, fall through to markdown migration */
  }
  return { tasks: [], notes: raw };
}

function serialize(state: NotesState): string {
  return JSON.stringify(state);
}

/// Returns just the YYYY-MM-DD portion of a stored due value, whether it has a time or not.
function dueDatePart(due: string): string { return due.slice(0, 10); }

/// Returns the HH:MM portion, or empty string if not set.
function dueTimePart(due: string): string { return due.length >= 16 ? due.slice(11, 16) : ""; }

/// "YYYY-MM-DD" comparison vs today (string compare is lexicographically correct for this format).
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDate(iso: string): string {
  // Locale-aware short date with optional time, e.g. "Jun 15" or "Jun 15 14:30"
  try {
    const datePart = dueDatePart(iso);
    const timePart = dueTimePart(iso);
    const [y, m, d] = datePart.split("-").map(Number);
    const shortDate = new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return timePart ? `${shortDate} ${timePart}` : shortDate;
  } catch {
    return iso;
  }
}

export function NotesPanel({ onClose }: Props) {
  const { activeContextId, contexts } = useStore();
  const ctxId = activeContextId ?? 0;
  const activeCtx = contexts.find((c) => c.id === activeContextId);

  const [state, setState] = useState<NotesState>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load when workspace changes
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    invoke<string>("get_workspace_note", { contextId: ctxId })
      .then((raw) => { if (!cancelled) { setState(parseStored(raw)); setLoaded(true); setSaved(true); } })
      .catch(() => { if (!cancelled) { setState(EMPTY); setLoaded(true); setSaved(true); } });
    return () => { cancelled = true; };
  }, [ctxId]);

  // Save core: actually writes to DB and notifies the toolbar.
  const persist = async (next: NotesState) => {
    try {
      await invoke("save_workspace_note", { contextId: ctxId, content: serialize(next) });
      setSaved(true);
      window.dispatchEvent(new CustomEvent("notes-updated", {
        detail: { contextId: ctxId, content: serialize(next) },
      }));
    } catch { /* keep saved=false so user knows */ }
  };

  /// Save IMMEDIATELY — for structural actions (toggle done, add, delete, change date).
  /// The user has finished their intent in one click; waiting 600ms makes it feel sluggish.
  const saveNow = (next: NotesState) => {
    setState(next);
    setSaved(false);
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    void persist(next);
  };

  /// DEBOUNCED save — for text typing where keystrokes arrive in rapid bursts.
  /// 300ms is short enough to feel responsive while still collapsing rapid input.
  const saveDebounced = (next: NotesState) => {
    setState(next);
    setSaved(false);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => { void persist(next); }, 300);
  };

  // Flush any pending debounced save on unmount
  useEffect(() => () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      invoke("save_workspace_note", { contextId: ctxId, content: serialize(state) }).catch(() => {});
    }
  }, [ctxId, state]);

  // ── Task mutations ──────────────────────────────────────────────────────
  const addTask = () => {
    const id = Math.random().toString(36).slice(2, 10);
    const next = { ...state, tasks: [...state.tasks, { id, done: false, text: "" }] };
    saveNow(next);
    setTimeout(() => {
      const inputs = document.querySelectorAll<HTMLInputElement>('[data-task-text-input="1"]');
      const last = inputs[inputs.length - 1];
      last?.focus();
    }, 30);
  };

  const updateTaskText = (id: string, text: string) => {
    // Text typing → debounced so we don't hit the DB on every keystroke.
    const next = {
      ...state,
      tasks: state.tasks.map((t) => (t.id === id ? { ...t, text } : t)),
    };
    saveDebounced(next);
  };

  const updateTaskStructural = (id: string, patch: Partial<Task>) => {
    // Toggle done, change due date → immediate save.
    const next = {
      ...state,
      tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    };
    saveNow(next);
  };

  const deleteTask = (id: string) => {
    const next = { ...state, tasks: state.tasks.filter((t) => t.id !== id) };
    saveNow(next);
  };

  // ── Sorted view: undone first, then by due date+time, then by index ─────
  // Overdue / due-today coloring is based on the DATE part only — a task
  // due "today at 17:00" should still appear amber the whole day, not flip
  // to red after the clock passes 17:00.
  const sortedTasks = useMemo(() => {
    const today = todayIso();
    return [...state.tasks].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      const adue = a.due ?? "";
      const bdue = b.due ?? "";
      if (adue && bdue) return adue.localeCompare(bdue); // works for both date and date+time
      if (adue && !bdue) return -1;
      if (!adue && bdue) return 1;
      return 0;
    }).map((t) => {
      const dateOnly = t.due ? t.due.slice(0, 10) : "";
      return {
        ...t,
        _overdue: !!(dateOnly && !t.done && dateOnly < today),
        _today:   !!(dateOnly && !t.done && dateOnly === today),
      };
    });
  }, [state.tasks]);

  const pendingCount = state.tasks.filter((t) => !t.done).length;

  return (
    <div className="flex flex-col h-full bg-surface-1 border-l border-border-subtle w-[340px] shrink-0 select-text">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-[48px] border-b border-border-subtle shrink-0">
        <StickyNote size={14} className="text-accent shrink-0" />
        <span className="text-[12px] font-semibold text-text-primary flex-1 truncate">
          Notes — {activeCtx ? `${activeCtx.icon} ${activeCtx.name}` : "Global"}
        </span>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
        >
          <X size={13} />
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-3 py-3 min-h-0 flex flex-col gap-3">
        {!loaded ? (
          <div className="text-[11px] text-text-muted italic">Loading…</div>
        ) : (
          <>
            {/* ─── Tasks ────────────────────────────────────────────────── */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-semibold text-text-muted tracking-widest uppercase">Tasks</span>
                <button
                  onClick={addTask}
                  title="Add task"
                  className="flex items-center gap-1 px-1.5 h-5 rounded text-[10px] text-accent hover:bg-accent/10 transition-colors"
                >
                  <Plus size={11} /> Add task
                </button>
              </div>

              {sortedTasks.length === 0 && (
                <p className="text-[11px] text-text-muted italic px-1 py-2">
                  No tasks yet. Click <span className="text-accent">+ Add task</span> to create one.
                </p>
              )}

              {sortedTasks.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  overdue={t._overdue}
                  dueToday={t._today}
                  onToggle={() => updateTaskStructural(t.id, { done: !t.done })}
                  onText={(text) => updateTaskText(t.id, text)}
                  onDue={(due) => updateTaskStructural(t.id, { due: due || undefined })}
                  onDelete={() => deleteTask(t.id)}
                />
              ))}
            </div>

            {/* ─── Notes ───────────────────────────────────────────────── */}
            <div className="flex flex-col gap-1 pt-2 border-t border-border-subtle">
              <span className="text-[10px] font-semibold text-text-muted tracking-widest uppercase mb-1">Notes</span>
              <textarea
                value={state.notes}
                onChange={(e) => saveDebounced({ ...state, notes: e.target.value })}
                placeholder="Free-form notes about this workspace…"
                rows={6}
                className="w-full bg-surface-2 border border-border rounded p-2 text-[12px] text-text-primary placeholder-text-muted outline-none focus:border-accent transition-colors resize-y leading-relaxed"
                spellCheck={false}
              />
            </div>
          </>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-1.5 border-t border-border-subtle shrink-0 flex items-center text-[10px] text-text-muted gap-2">
        <span>
          {pendingCount > 0 ? `${pendingCount} task${pendingCount === 1 ? "" : "s"} pending` : "No pending tasks"}
        </span>
        <span className="flex-1 text-right">
          {saved
            ? <span className="text-emerald-400/70">✓ Saved</span>
            : <span className="text-amber-400">Saving…</span>}
        </span>
      </div>
    </div>
  );
}

// ─── Individual task row ──────────────────────────────────────────────────
function TaskRow({
  task, overdue, dueToday,
  onToggle, onText, onDue, onDelete,
}: {
  task: Task;
  overdue: boolean;
  dueToday: boolean;
  onToggle: () => void;
  onText: (v: string) => void;
  onDue: (v: string) => void;
  onDelete: () => void;
}) {
  // Custom popovers — anchored to the trigger button via its bounding rect.
  const [picker, setPicker] = useState<"date" | "time" | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const dateBtnRef = useRef<HTMLButtonElement>(null);
  const timeBtnRef = useRef<HTMLButtonElement>(null);

  const openDate = () => {
    const r = dateBtnRef.current?.getBoundingClientRect();
    if (r) { setAnchor(r); setPicker("date"); }
  };
  const openTime = () => {
    const r = timeBtnRef.current?.getBoundingClientRect();
    if (r) { setAnchor(r); setPicker("time"); }
  };

  const datePart = task.due ? dueDatePart(task.due) : "";
  const timePart = task.due ? dueTimePart(task.due) : "";
  const hasTime = !!timePart;

  // Apply a new date (keeps existing time if any). Empty clears everything.
  const onPickDate = (newDate: string) => {
    if (!newDate) { onDue(""); setPicker(null); return; }
    onDue(timePart ? `${newDate}T${timePart}` : newDate);
    // Don't close — let the user pick "Today" / change month freely until they click outside.
    // But for typical click-on-day usage we close immediately.
    setPicker(null);
  };

  // Apply a new time (requires a date; keeps it). Empty clears just the time.
  const onPickTime = (newTime: string) => {
    if (!datePart) { setPicker(null); return; }
    if (!newTime) { onDue(datePart); setPicker(null); return; }
    onDue(`${datePart}T${newTime}`);
    // Live commit pattern in TimePicker → no need to close on every keystroke.
  };

  return (
    <div className="group relative flex items-center gap-1.5 px-1 py-1 rounded hover:bg-surface-2/50 transition-colors">
      <input
        type="checkbox"
        checked={task.done}
        onChange={onToggle}
        className="cursor-pointer accent-accent w-3.5 h-3.5 shrink-0"
      />
      <input
        type="text"
        data-task-text-input="1"
        value={task.text}
        onChange={(e) => onText(e.target.value)}
        placeholder="Task…"
        className={clsx(
          "flex-1 min-w-0 bg-transparent text-[12px] outline-none border-b border-transparent focus:border-border transition-colors px-1",
          task.done ? "line-through text-text-muted" : "text-text-primary"
        )}
      />

      {/* Date chip — shows date (and time if present), click → change date */}
      {task.due ? (
        <button
          ref={dateBtnRef}
          onClick={openDate}
          title="Change due date"
          className={clsx(
            "flex items-center gap-1 px-1.5 h-5 rounded text-[10px] font-medium shrink-0 transition-colors",
            task.done
              ? "text-text-muted bg-surface-3"
              : overdue
                ? "text-red-300 bg-red-500/15 hover:bg-red-500/25"
                : dueToday
                  ? "text-amber-300 bg-amber-500/15 hover:bg-amber-500/25"
                  : "text-accent bg-accent/10 hover:bg-accent/20"
          )}
        >
          <CalendarDays size={9} />
          {formatDate(task.due)}
        </button>
      ) : (
        <button
          ref={dateBtnRef}
          onClick={openDate}
          title="Set due date"
          className="opacity-0 group-hover:opacity-100 flex items-center justify-center w-5 h-5 rounded text-text-muted hover:text-accent hover:bg-accent/10 transition-all shrink-0"
        >
          <CalendarPlus size={11} />
        </button>
      )}

      {/* Time button — only when a date is set. Hidden until hover unless time is set. */}
      {task.due && (
        <button
          ref={timeBtnRef}
          onClick={openTime}
          title={hasTime ? "Change time" : "Add time"}
          className={clsx(
            "flex items-center justify-center w-5 h-5 rounded transition-all shrink-0",
            hasTime
              ? "text-accent hover:bg-accent/10"
              : "opacity-0 group-hover:opacity-100 text-text-muted hover:text-accent hover:bg-accent/10"
          )}
        >
          <Clock size={11} />
        </button>
      )}

      {/* Custom popover pickers */}
      {picker === "date" && anchor && (
        <DatePicker
          value={datePart}
          anchor={anchor}
          onChange={onPickDate}
          onClose={() => setPicker(null)}
        />
      )}
      {picker === "time" && anchor && (
        <TimePicker
          value={timePart}
          anchor={anchor}
          onChange={onPickTime}
          onClose={() => setPicker(null)}
        />
      )}

      {/* Clear due date (and time) */}
      {task.due && (
        <button
          onClick={() => onDue("")}
          title="Remove due date"
          className="opacity-0 group-hover:opacity-100 flex items-center justify-center w-4 h-4 rounded text-text-muted hover:text-text-primary transition-all shrink-0"
        >
          <X size={9} />
        </button>
      )}

      {/* Delete task */}
      <button
        onClick={onDelete}
        title="Delete task"
        className="opacity-0 group-hover:opacity-100 flex items-center justify-center w-5 h-5 rounded text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-all shrink-0"
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}
