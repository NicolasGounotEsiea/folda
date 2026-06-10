import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft, FileText, FolderOpen, GripVertical, Image, Pencil, Play, Plus, Sparkles, Trash2, Workflow, X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useToastStore } from "../store/useToastStore";
import { useTranslation } from "../utils/i18n";

// ── Types (mirror the Rust enums in commands/automation.rs) ───────────────────

type TriggerKind = "file_created" | "file_modified" | "file_renamed" | "manual";

type Condition =
  | { kind: "ext"; value: string }
  | { kind: "name_contains"; value: string }
  | { kind: "name_starts_with"; value: string }
  | { kind: "name_regex"; value: string }
  | { kind: "path_contains"; value: string }
  | { kind: "size_gt"; bytes: number }
  | { kind: "size_lt"; bytes: number }
  | { kind: "age_gt_days"; days: number }
  | { kind: "tag_has"; value: string };

type Action =
  | { kind: "move_to"; path: string }
  | { kind: "copy_to"; path: string }
  | { kind: "rename"; template: string }
  | { kind: "add_tag"; tag: string }
  | { kind: "remove_tag"; tag: string }
  | { kind: "trash" }
  | { kind: "notify"; message: string };

type ConditionLogic = "and" | "or";

interface AutomationRule {
  id: number;
  name: string;
  enabled: boolean;
  trigger_kind: TriggerKind;
  trigger_path: string;
  conditions: Condition[];
  condition_logic: ConditionLogic;
  actions: Action[];
  context_id: number;
  created_at: number;
  updated_at: number;
  last_fired_at: number | null;
  fire_count: number;
  last_error: string | null;
}

interface ActionOutcome {
  action: string;
  file_before: string;
  file_after: string;
  success: boolean;
  error?: string | null;
}

interface RunReport {
  dry_run: boolean;
  matched_files: number;
  actions_attempted: number;
  actions_succeeded: number;
  outcomes: ActionOutcome[];
}

const CONDITION_KINDS: Condition["kind"][] = [
  "ext", "name_contains", "name_starts_with", "name_regex",
  "path_contains", "size_gt", "size_lt", "age_gt_days", "tag_has",
];

const ACTION_KINDS: Action["kind"][] = [
  "move_to", "copy_to", "rename", "add_tag", "remove_tag", "trash", "notify",
];

function newCondition(kind: Condition["kind"]): Condition {
  switch (kind) {
    case "size_gt": case "size_lt": return { kind, bytes: 0 };
    case "age_gt_days": return { kind, days: 0 };
    default: return { kind, value: "" } as Condition;
  }
}

function newAction(kind: Action["kind"]): Action {
  switch (kind) {
    case "move_to": case "copy_to": return { kind, path: "" };
    case "rename": return { kind, template: "" };
    case "add_tag": case "remove_tag": return { kind, tag: "" };
    case "trash": return { kind };
    case "notify": return { kind, message: "" };
  }
}

// ── Preset library ────────────────────────────────────────────────────────────
//
// Pre-baked rules that surface in the empty state and via the "Templates" button.
// Each preset returns a DraftRule that's pushed into the editor — the user picks
// from the gallery, lands in the edit form with the rule pre-filled, can tweak
// before saving. We keep this list short and deliberately heterogeneous to
// teach by example (manual + watcher, with and without path edit, three of the
// action kinds, two of the more advanced conditions).
//
// The icon component is hardcoded per preset; the name + description come from
// i18n so both languages stay in sync.

interface Preset {
  id: string;
  icon: typeof Workflow;
  nameKey: keyof ReturnType<typeof useTranslation>;
  descKey: keyof ReturnType<typeof useTranslation>;
  /// Build the draft. The preset's display name is pulled from i18n via `nameKey`
  /// so French users get a French-named rule in the editor, English users English.
  /// Tag / path values stay literal — those are user-owned strings they'll edit.
  build: (name: string) => DraftRule;
}

const PRESETS: Preset[] = [
  {
    id: "tag-pdfs",
    icon: FileText,
    nameKey: "automationPresetTagPdfsName",
    descKey: "automationPresetTagPdfsDesc",
    build: (name) => ({
      name,
      enabled: true,
      trigger_kind: "manual",
      trigger_path: "",
      condition_logic: "and",
      conditions: [{ kind: "ext", value: "pdf" }],
      actions: [{ kind: "add_tag", tag: "Documents" }],
    }),
  },
  {
    id: "tag-images",
    icon: Image,
    nameKey: "automationPresetTagImagesName",
    descKey: "automationPresetTagImagesDesc",
    build: (name) => ({
      name,
      enabled: true,
      trigger_kind: "manual",
      trigger_path: "",
      condition_logic: "and",
      // Single regex covers the common image extensions in one rule.
      conditions: [{ kind: "name_regex", value: "\\.(jpg|jpeg|png|webp|heic)$" }],
      actions: [{ kind: "add_tag", tag: "Photos" }],
    }),
  },
  {
    id: "archive-screenshots",
    icon: Trash2,
    nameKey: "automationPresetArchiveScreenshotsName",
    descKey: "automationPresetArchiveScreenshotsDesc",
    build: (name) => ({
      name,
      enabled: true,
      trigger_kind: "manual",
      trigger_path: "",
      condition_logic: "and",
      conditions: [
        { kind: "name_starts_with", value: "Screenshot" },
        { kind: "age_gt_days", days: 30 },
      ],
      actions: [{ kind: "trash" }],
    }),
  },
  {
    id: "organize-pdfs-by-year",
    icon: FolderOpen,
    nameKey: "automationPresetOrganizePdfsName",
    descKey: "automationPresetOrganizePdfsDesc",
    build: (name) => ({
      name,
      enabled: true,
      trigger_kind: "file_created",
      // User must edit both paths — placeholders signal where.
      trigger_path: "",
      conditions: [{ kind: "ext", value: "pdf" }],
      condition_logic: "and",
      actions: [{ kind: "move_to", path: "C:\\Archive\\{year}" }],
    }),
  },
  {
    id: "clean-tmp",
    icon: Trash2,
    nameKey: "automationPresetCleanTmpName",
    descKey: "automationPresetCleanTmpDesc",
    build: (name) => ({
      name,
      enabled: true,
      trigger_kind: "manual",
      trigger_path: "",
      condition_logic: "and",
      conditions: [
        { kind: "ext", value: "tmp" },
        { kind: "age_gt_days", days: 7 },
      ],
      actions: [{ kind: "trash" }],
    }),
  },
];

// ── Modal ─────────────────────────────────────────────────────────────────────

type View =
  | { mode: "list" }
  | { mode: "edit"; draft: DraftRule; originalId: number | null }
  | { mode: "run"; rule: AutomationRule }
  | { mode: "presets" };

interface DraftRule {
  name: string;
  enabled: boolean;
  trigger_kind: TriggerKind;
  trigger_path: string;
  conditions: Condition[];
  condition_logic: ConditionLogic;
  actions: Action[];
}

function emptyDraft(): DraftRule {
  return {
    name: "",
    enabled: true,
    trigger_kind: "manual",
    trigger_path: "",
    conditions: [],
    condition_logic: "and",
    actions: [],
  };
}

export function AutomationsModal({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [view, setView] = useState<View>({ mode: "list" });
  const ref = useRef<HTMLDivElement>(null);

  const load = () =>
    invoke<AutomationRule[]>("get_automation_rules").then(setRules).catch((e) => {
      addToast({ type: "error", message: t.automationLoadFailed, detail: String(e) });
    });

  useEffect(() => { load(); }, []);

  // Dismiss on outside click (list view only — avoid losing edits accidentally)
  useEffect(() => {
    if (view.mode !== "list") return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", h, true);
    return () => window.removeEventListener("mousedown", h, true);
  }, [view.mode, onClose]);

  return (
    <div className="modal-backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        ref={ref}
        className="modal-content-in bg-surface-1 border border-border rounded-xl shadow-2xl w-[640px] max-w-[96vw] max-h-[88vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border-subtle">
          {view.mode !== "list" && (
            <button
              onClick={() => setView({ mode: "list" })}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-surface-3 text-text-muted hover:text-text-primary"
              title={t.cancel}
            >
              <ArrowLeft size={14} />
            </button>
          )}
          <Workflow size={16} className="text-accent shrink-0" />
          <span className="text-[13px] font-semibold text-text-primary flex-1">
            {view.mode === "list" ? t.automationsTitle
              : view.mode === "edit" ? (view.originalId === null ? t.automationNew : t.automationEdit)
              : view.mode === "presets" ? t.automationPresets
              : t.automationRunNow}
          </span>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-surface-3 text-text-muted hover:text-text-primary"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {view.mode === "list" && (
            <RulesList
              rules={rules}
              onNew={() => setView({ mode: "edit", draft: emptyDraft(), originalId: null })}
              onShowPresets={() => setView({ mode: "presets" })}
              onPickPreset={(preset) => setView({
                mode: "edit",
                draft: preset.build(t[preset.nameKey] as string),
                originalId: null,
              })}
              onEdit={(r) => setView({
                mode: "edit",
                draft: { name: r.name, enabled: r.enabled, trigger_kind: r.trigger_kind,
                  trigger_path: r.trigger_path, conditions: r.conditions,
                  // Defensive fallback for legacy rules deserialized without the field
                  // (defaults already handle this server-side, but belt-and-braces).
                  condition_logic: r.condition_logic ?? "and",
                  actions: r.actions },
                originalId: r.id,
              })}
              onRun={(r) => setView({ mode: "run", rule: r })}
              onDelete={async (r) => {
                if (!window.confirm(t.automationConfirmDelete.replace("{name}", r.name))) return;
                try {
                  await invoke("delete_automation_rule", { id: r.id });
                  addToast({ type: "success", message: t.automationDeleted });
                  load();
                } catch (e) {
                  addToast({ type: "error", message: t.automationDeleteFailed, detail: String(e) });
                }
              }}
              onToggle={async (r) => {
                try {
                  await invoke("toggle_automation_rule", { id: r.id });
                  load();
                } catch (e) {
                  addToast({ type: "error", message: t.automationSaveFailed, detail: String(e) });
                }
              }}
            />
          )}

          {view.mode === "edit" && (
            <RuleEditor
              draft={view.draft}
              onChange={(d) => setView({ ...view, draft: d })}
              onSave={async () => {
                const d = view.draft;
                if (!d.name.trim()) {
                  addToast({ type: "warning", message: t.automationNameRequired });
                  return;
                }
                try {
                  if (view.originalId === null) {
                    await invoke("create_automation_rule", { rule: {
                      name: d.name.trim(),
                      trigger_kind: d.trigger_kind,
                      trigger_path: d.trigger_path,
                      conditions: d.conditions,
                      condition_logic: d.condition_logic,
                      actions: d.actions,
                      context_id: 0,
                    } });
                  } else {
                    await invoke("update_automation_rule", { id: view.originalId, patch: {
                      name: d.name.trim(),
                      enabled: d.enabled,
                      trigger_kind: d.trigger_kind,
                      trigger_path: d.trigger_path,
                      conditions: d.conditions,
                      condition_logic: d.condition_logic,
                      actions: d.actions,
                    } });
                  }
                  addToast({ type: "success", message: t.automationSaved });
                  await load();
                  setView({ mode: "list" });
                } catch (e) {
                  addToast({ type: "error", message: t.automationSaveFailed, detail: String(e) });
                }
              }}
            />
          )}

          {view.mode === "run" && (
            <RunPanel
              rule={view.rule}
              onClose={() => setView({ mode: "list" })}
            />
          )}

          {view.mode === "presets" && (
            <PresetsGallery
              onPick={(preset) => {
                setView({
                  mode: "edit",
                  draft: preset.build(t[preset.nameKey] as string),
                  originalId: null,
                });
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── List view ────────────────────────────────────────────────────────────────

function RulesList({
  rules, onNew, onShowPresets, onPickPreset, onEdit, onRun, onDelete, onToggle,
}: {
  rules: AutomationRule[];
  onNew: () => void;
  onShowPresets: () => void;
  onPickPreset: (p: Preset) => void;
  onEdit: (r: AutomationRule) => void;
  onRun: (r: AutomationRule) => void;
  onDelete: (r: AutomationRule) => void;
  onToggle: (r: AutomationRule) => void;
}) {
  const t = useTranslation();
  return (
    <div className="px-5 py-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-text-muted leading-relaxed flex-1 pr-3">
          {t.automationHelp}
        </p>
        <button
          onClick={onShowPresets}
          title={t.automationPresetsHint}
          className="h-7 px-2.5 rounded border border-border text-[11px] text-text-secondary hover:bg-surface-3 transition-colors flex items-center gap-1 shrink-0"
        >
          <Sparkles size={11} /> {t.automationPresets}
        </button>
        <button
          onClick={onNew}
          className="h-7 px-3 rounded bg-accent text-white text-[11px] font-medium hover:bg-accent/90 transition-colors flex items-center gap-1 shrink-0"
        >
          <Plus size={11} /> {t.automationNew}
        </button>
      </div>

      {rules.length === 0 ? (
        // First-run experience: skip the empty wall, show the gallery directly.
        // One click on a preset → editor with the rule pre-filled → user can save
        // immediately. This is the "ah, I see what this does" moment.
        <div className="flex flex-col gap-2">
          <p className="text-[11px] text-text-muted">{t.automationEmptyTryPreset}</p>
          <PresetsGallery onPick={onPickPreset} />
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rules.map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-2 px-3 py-2 bg-surface-2 border border-border-subtle rounded-lg hover:bg-surface-3 transition-colors"
            >
              <button
                onClick={() => onToggle(r)}
                title={r.enabled ? t.automationDisable : t.automationEnable}
                className={`w-8 h-4 rounded-full relative transition-colors shrink-0 ${
                  r.enabled ? "bg-accent" : "bg-surface-3 border border-border"
                }`}
              >
                <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${
                  r.enabled ? "left-4" : "left-0.5"
                }`} />
              </button>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] font-medium text-text-primary truncate">{r.name}</span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-surface-3 text-text-muted uppercase tracking-wide shrink-0">
                    {triggerLabel(r.trigger_kind, t)}
                  </span>
                </div>
                <p className="text-[10px] text-text-muted truncate">
                  {summarizeRule(r, t)}
                </p>
                {/* Diagnostics: only shown once the rule has actually fired at least once. */}
                {r.fire_count > 0 && (
                  <p className="text-[10px] text-text-muted truncate" title={
                    r.last_error
                      ? t.automationDiagLastErrorTitle.replace("{error}", r.last_error)
                      : undefined
                  }>
                    {t.automationDiagFiredTimes
                      .replace("{n}", String(r.fire_count))
                      .replace("{when}", r.last_fired_at != null ? formatRelative(r.last_fired_at, t) : "—")}
                    {r.last_error && (
                      <span className="text-red-400 ml-1.5">
                        · ⚠ {t.automationDiagLastErrorChip}
                      </span>
                    )}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  onClick={() => onRun(r)}
                  title={t.automationRunNow}
                  className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-accent hover:bg-surface-3 transition-colors"
                >
                  <Play size={11} />
                </button>
                <button
                  onClick={() => onEdit(r)}
                  title={t.automationEdit}
                  className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
                >
                  <Pencil size={11} />
                </button>
                <button
                  onClick={() => onDelete(r)}
                  title={t.delete}
                  className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-red-400 hover:bg-surface-3 transition-colors"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatRelative(unixSec: number, t: ReturnType<typeof useTranslation>): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return t.automationDiagJustNow;
  if (diff < 3600) return t.automationDiagMinutesAgo.replace("{n}", String(Math.floor(diff / 60)));
  if (diff < 86400) return t.automationDiagHoursAgo.replace("{n}", String(Math.floor(diff / 3600)));
  return t.automationDiagDaysAgo.replace("{n}", String(Math.floor(diff / 86400)));
}

function triggerLabel(kind: TriggerKind, t: ReturnType<typeof useTranslation>): string {
  switch (kind) {
    case "file_created": return t.automationTriggerCreated;
    case "file_modified": return t.automationTriggerModified;
    case "file_renamed": return t.automationTriggerRenamed;
    case "manual": return t.automationTriggerManual;
  }
}

function summarizeRule(r: AutomationRule, t: ReturnType<typeof useTranslation>): string {
  // Only mention the logic when it's both visible (2+ conditions) AND non-default
  // (OR). A single AND condition doesn't need a "(all)" parenthetical — that would
  // be noise on the vast majority of rules.
  const logicHint = r.conditions.length >= 2 && r.condition_logic === "or"
    ? ` ${t.automationSummaryAnyHint}`
    : "";
  const conds = r.conditions.length === 0
    ? t.automationSummaryNoConditions
    : `${r.conditions.length} ${r.conditions.length > 1 ? t.automationSummaryConditionsPlural : t.automationSummaryConditionsSingular}${logicHint}`;
  const acts = `${r.actions.length} ${r.actions.length > 1 ? t.automationSummaryActionsPlural : t.automationSummaryActionsSingular}`;
  return `${conds} → ${acts}`;
}

// ── Editor view ──────────────────────────────────────────────────────────────

function RuleEditor({
  draft, onChange, onSave,
}: {
  draft: DraftRule;
  onChange: (d: DraftRule) => void;
  onSave: () => void;
}) {
  const t = useTranslation();

  const browseTrigger = async () => {
    const path = await open({ directory: true, multiple: false });
    if (typeof path === "string") onChange({ ...draft, trigger_path: path });
  };

  return (
    <div className="px-5 py-4 flex flex-col gap-4">
      {/* Name */}
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-text-muted uppercase tracking-widest">
          {t.automationFieldName}
        </label>
        <input
          autoFocus
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          placeholder={t.automationFieldNamePh}
          className="h-7 px-2.5 rounded bg-surface-2 border border-border text-[12px] text-text-primary placeholder-text-muted outline-none focus:border-accent"
        />
      </div>

      {/* Trigger kind */}
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-text-muted uppercase tracking-widest">
          {t.automationFieldTrigger}
        </label>
        <div className="flex gap-1">
          {(["file_created", "file_modified", "file_renamed", "manual"] as const).map((k) => (
            <button
              key={k}
              onClick={() => onChange({ ...draft, trigger_kind: k })}
              className={`flex-1 h-7 rounded text-[11px] border transition-colors ${
                draft.trigger_kind === k
                  ? "bg-accent/15 border-accent/40 text-accent"
                  : "bg-surface-2 border-border text-text-secondary hover:bg-surface-3"
              }`}
            >
              {triggerLabel(k, t)}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-text-muted">
          {triggerHelp(draft.trigger_kind, t)}
        </p>
      </div>

      {/* Trigger path (only for non-manual) */}
      {draft.trigger_kind !== "manual" && (
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-text-muted uppercase tracking-widest">
            {t.automationFieldScope}
          </label>
          <div className="flex gap-1">
            <input
              value={draft.trigger_path}
              onChange={(e) => onChange({ ...draft, trigger_path: e.target.value })}
              placeholder={t.automationFieldScopePh}
              className="flex-1 h-7 px-2.5 rounded bg-surface-2 border border-border text-[12px] text-text-primary placeholder-text-muted outline-none focus:border-accent font-mono"
            />
            <button
              onClick={browseTrigger}
              title={t.automationBrowse}
              className="h-7 px-2.5 rounded bg-surface-2 border border-border text-[11px] text-text-secondary hover:bg-surface-3 transition-colors flex items-center gap-1"
            >
              <FolderOpen size={11} /> {t.automationBrowse}
            </button>
          </div>
          <p className="text-[10px] text-text-muted">{t.automationFieldScopeHelp}</p>
        </div>
      )}

      {/* Conditions */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label className="text-[10px] text-text-muted uppercase tracking-widest">
            {t.automationFieldConditions}
          </label>
          <button
            onClick={() => onChange({ ...draft, conditions: [...draft.conditions, newCondition("ext")] })}
            className="flex items-center gap-0.5 text-[10px] text-accent hover:text-accent-glow transition-colors"
          >
            <Plus size={10} /> {t.automationAddCondition}
          </button>
        </div>
        {/* AND / OR combinator — only useful from 2 conditions onward but always
            shown so the user understands the default and can pre-set the mode
            before adding their second condition. Disabled visual state when
            there's 0 or 1 condition would feel clunky. */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-text-muted shrink-0">
            {t.automationConditionLogicLabel}
          </span>
          <div className="flex gap-0.5 rounded bg-surface-2 border border-border p-0.5">
            {(["and", "or"] as const).map((logic) => (
              <button
                key={logic}
                onClick={() => onChange({ ...draft, condition_logic: logic })}
                className={`px-2 h-5 rounded text-[10px] font-medium transition-colors ${
                  draft.condition_logic === logic
                    ? "bg-accent text-white"
                    : "text-text-secondary hover:text-text-primary"
                }`}
              >
                {logic === "and" ? t.automationConditionLogicAll : t.automationConditionLogicAny}
              </button>
            ))}
          </div>
        </div>
        {draft.conditions.length === 0 ? (
          <p className="text-[10px] text-text-muted italic">{t.automationNoConditions}</p>
        ) : (
          <div className="flex flex-col gap-1">
            {draft.conditions.map((cond, i) => (
              <ConditionRow
                key={i}
                cond={cond}
                onChange={(c) => {
                  const arr = [...draft.conditions];
                  arr[i] = c;
                  onChange({ ...draft, conditions: arr });
                }}
                onDelete={() => {
                  const arr = draft.conditions.filter((_, j) => j !== i);
                  onChange({ ...draft, conditions: arr });
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label className="text-[10px] text-text-muted uppercase tracking-widest">
            {t.automationFieldActions}
          </label>
          <button
            onClick={() => onChange({ ...draft, actions: [...draft.actions, newAction("add_tag")] })}
            className="flex items-center gap-0.5 text-[10px] text-accent hover:text-accent-glow transition-colors"
          >
            <Plus size={10} /> {t.automationAddAction}
          </button>
        </div>
        {draft.actions.length === 0 ? (
          <p className="text-[10px] text-text-muted italic">{t.automationNoActions}</p>
        ) : (
          <SortableActions
            actions={draft.actions}
            onActionsChange={(next) => onChange({ ...draft, actions: next })}
          />
        )}
      </div>

      <div className="flex justify-end gap-2 pt-2 border-t border-border-subtle">
        <button
          onClick={onSave}
          className="h-8 px-4 rounded-lg bg-accent text-white text-[12px] font-medium hover:bg-accent/90 transition-colors"
        >
          {t.save}
        </button>
      </div>
    </div>
  );
}

function triggerHelp(kind: TriggerKind, t: ReturnType<typeof useTranslation>): string {
  switch (kind) {
    case "file_created": return t.automationTriggerCreatedHelp;
    case "file_modified": return t.automationTriggerModifiedHelp;
    case "file_renamed": return t.automationTriggerRenamedHelp;
    case "manual": return t.automationTriggerManualHelp;
  }
}

function ConditionRow({
  cond, onChange, onDelete,
}: {
  cond: Condition;
  onChange: (c: Condition) => void;
  onDelete: () => void;
}) {
  const t = useTranslation();
  const numericKinds = new Set<Condition["kind"]>(["size_gt", "size_lt", "age_gt_days"]);

  const value: string = "value" in cond ? cond.value
    : "bytes" in cond ? String(cond.bytes)
    : "days" in cond ? String(cond.days)
    : "";

  const setValue = (raw: string) => {
    if (cond.kind === "size_gt" || cond.kind === "size_lt") {
      const n = Number(raw);
      onChange({ kind: cond.kind, bytes: Number.isFinite(n) ? n : 0 });
    } else if (cond.kind === "age_gt_days") {
      const n = Number(raw);
      onChange({ kind: "age_gt_days", days: Number.isFinite(n) ? n : 0 });
    } else {
      onChange({ ...cond, value: raw } as Condition);
    }
  };

  return (
    <div className="flex items-center gap-1">
      <select
        value={cond.kind}
        onChange={(e) => onChange(newCondition(e.target.value as Condition["kind"]))}
        className="h-7 px-2 rounded bg-surface-2 border border-border text-[11px] text-text-primary outline-none focus:border-accent"
      >
        {CONDITION_KINDS.map((k) => (
          <option key={k} value={k}>{conditionLabel(k, t)}</option>
        ))}
      </select>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={conditionPlaceholder(cond.kind, t)}
        type={numericKinds.has(cond.kind) ? "number" : "text"}
        className="flex-1 h-7 px-2 rounded bg-surface-2 border border-border text-[11px] text-text-primary placeholder-text-muted outline-none focus:border-accent font-mono"
      />
      <button
        onClick={onDelete}
        className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-red-400 hover:bg-surface-3 transition-colors"
        title={t.delete}
      >
        <X size={11} />
      </button>
    </div>
  );
}

function conditionLabel(k: Condition["kind"], t: ReturnType<typeof useTranslation>): string {
  switch (k) {
    case "ext": return t.automationCondExt;
    case "name_contains": return t.automationCondNameContains;
    case "name_starts_with": return t.automationCondNameStarts;
    case "name_regex": return t.automationCondNameRegex;
    case "path_contains": return t.automationCondPathContains;
    case "size_gt": return t.automationCondSizeGt;
    case "size_lt": return t.automationCondSizeLt;
    case "age_gt_days": return t.automationCondAgeGtDays;
    case "tag_has": return t.automationCondTagHas;
  }
}

function conditionPlaceholder(k: Condition["kind"], t: ReturnType<typeof useTranslation>): string {
  switch (k) {
    case "ext": return t.automationCondExtPh;
    case "name_contains": case "name_starts_with": return t.automationCondNamePh;
    case "name_regex": return t.automationCondRegexPh;
    case "path_contains": return t.automationCondPathPh;
    case "size_gt": case "size_lt": return t.automationCondBytesPh;
    case "age_gt_days": return t.automationCondDaysPh;
    case "tag_has": return t.automationCondTagPh;
  }
}

// ── Sortable actions ─────────────────────────────────────────────────────────

/// Pure reorder helper. `dragOverIdx` is the index of the row hovered; `position`
/// says whether the dropped item lands above or below it. Returns a new array
/// (or the same reference if no movement was required) so callers can compare
/// identity to avoid an unnecessary onChange.
///
/// Why the index dance: after splicing out the source, indices to its right
/// shift left by one. We compensate by subtracting 1 from `dragOverIdx` when
/// the source was above the target, then add 1 when dropping "below".
export function reorder<T>(
  items: T[],
  sourceIdx: number,
  dragOverIdx: number,
  position: "above" | "below",
): T[] {
  if (sourceIdx < 0 || sourceIdx >= items.length) return items;
  if (dragOverIdx < 0 || dragOverIdx >= items.length) return items;
  // Dropping onto yourself is always a no-op — without this guard, a drop with
  // position='below' on the source row would move it to the end of the list.
  if (sourceIdx === dragOverIdx) return items;
  let target = dragOverIdx > sourceIdx ? dragOverIdx - 1 : dragOverIdx;
  if (position === "below") target += 1;
  // Clamp to [0, items.length-1] AFTER removal (length-1 because we'll splice).
  target = Math.max(0, Math.min(items.length - 1, target));
  if (target === sourceIdx) return items;
  const arr = [...items];
  const [moved] = arr.splice(sourceIdx, 1);
  arr.splice(target, 0, moved);
  return arr;
}

interface DragState {
  sourceIdx: number;
  overIdx: number | null;
  position: "above" | "below";
}

function SortableActions({
  actions, onActionsChange,
}: {
  actions: Action[];
  onActionsChange: (next: Action[]) => void;
}) {
  const t = useTranslation();
  const [drag, setDrag] = useState<DragState | null>(null);

  const handleDragStart = (idx: number) => (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = "move";
    // setData is required by Firefox to actually start the drag; harmless elsewhere.
    e.dataTransfer.setData("text/plain", String(idx));
    setDrag({ sourceIdx: idx, overIdx: null, position: "above" });
  };

  const handleDragOver = (idx: number) => (e: React.DragEvent) => {
    if (drag === null) return;
    e.preventDefault(); // required to allow drop
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const position: "above" | "below" =
      e.clientY < rect.top + rect.height / 2 ? "above" : "below";
    // Avoid no-op re-renders when neither idx nor position changed.
    setDrag((prev) => {
      if (!prev) return prev;
      if (prev.overIdx === idx && prev.position === position) return prev;
      return { ...prev, overIdx: idx, position };
    });
  };

  const handleDrop = (idx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    if (!drag) return;
    const next = reorder(actions, drag.sourceIdx, idx, drag.position);
    if (next !== actions) onActionsChange(next);
    setDrag(null);
  };

  // Fires on the dragged element whenever the drag operation ends — whether the
  // drop succeeded, the user pressed Escape, or they dropped on an invalid target.
  // Always clear state so we don't leave a stale highlight.
  const handleDragEnd = () => setDrag(null);

  return (
    <div className="flex flex-col gap-1">
      {actions.map((act, i) => {
        const showAbove = drag?.overIdx === i && drag.position === "above" && drag.sourceIdx !== i;
        const showBelow = drag?.overIdx === i && drag.position === "below" && drag.sourceIdx !== i;
        return (
          <div
            key={i}
            onDragOver={handleDragOver(i)}
            onDrop={handleDrop(i)}
            className={drag?.sourceIdx === i ? "opacity-30" : ""}
          >
            {showAbove && <div className="h-0.5 bg-accent rounded mb-1" />}
            <div className="flex items-center gap-1">
              <button
                draggable
                onDragStart={handleDragStart(i)}
                onDragEnd={handleDragEnd}
                title={t.automationDragToReorder}
                className="w-5 h-7 flex items-center justify-center rounded text-text-muted hover:text-text-secondary hover:bg-surface-3 cursor-grab active:cursor-grabbing transition-colors shrink-0"
              >
                <GripVertical size={11} />
              </button>
              <div className="flex-1 min-w-0">
                <ActionRow
                  act={act}
                  onChange={(a) =>
                    onActionsChange(actions.map((x, j) => (j === i ? a : x)))
                  }
                  onDelete={() =>
                    onActionsChange(actions.filter((_, j) => j !== i))
                  }
                />
              </div>
            </div>
            {showBelow && <div className="h-0.5 bg-accent rounded mt-1" />}
          </div>
        );
      })}
    </div>
  );
}

function ActionRow({
  act, onChange, onDelete,
}: {
  act: Action;
  onChange: (a: Action) => void;
  onDelete: () => void;
}) {
  const t = useTranslation();
  const value: string = "path" in act ? act.path
    : "template" in act ? act.template
    : "tag" in act ? act.tag
    : "message" in act ? act.message
    : "";

  const setValue = (raw: string) => {
    switch (act.kind) {
      case "move_to": case "copy_to": onChange({ kind: act.kind, path: raw }); break;
      case "rename": onChange({ kind: "rename", template: raw }); break;
      case "add_tag": case "remove_tag": onChange({ kind: act.kind, tag: raw }); break;
      case "notify": onChange({ kind: "notify", message: raw }); break;
      case "trash": /* no value */ break;
    }
  };

  const pathKinds = new Set<Action["kind"]>(["move_to", "copy_to"]);
  const browse = async () => {
    const p = await open({ directory: true, multiple: false });
    if (typeof p === "string") setValue(p);
  };

  return (
    <div className="flex items-center gap-1">
      <select
        value={act.kind}
        onChange={(e) => onChange(newAction(e.target.value as Action["kind"]))}
        className="h-7 px-2 rounded bg-surface-2 border border-border text-[11px] text-text-primary outline-none focus:border-accent"
      >
        {ACTION_KINDS.map((k) => (
          <option key={k} value={k}>{actionLabel(k, t)}</option>
        ))}
      </select>
      {act.kind !== "trash" && (
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={actionPlaceholder(act.kind, t)}
          className="flex-1 h-7 px-2 rounded bg-surface-2 border border-border text-[11px] text-text-primary placeholder-text-muted outline-none focus:border-accent font-mono"
        />
      )}
      {act.kind === "trash" && (
        <span className="flex-1 text-[10px] text-text-muted italic px-2">{t.automationActionTrashHelp}</span>
      )}
      {pathKinds.has(act.kind) && (
        <button
          onClick={browse}
          title={t.automationBrowse}
          className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
        >
          <FolderOpen size={11} />
        </button>
      )}
      <button
        onClick={onDelete}
        className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-red-400 hover:bg-surface-3 transition-colors"
        title={t.delete}
      >
        <X size={11} />
      </button>
    </div>
  );
}

function actionLabel(k: Action["kind"], t: ReturnType<typeof useTranslation>): string {
  switch (k) {
    case "move_to": return t.automationActionMoveTo;
    case "copy_to": return t.automationActionCopyTo;
    case "rename": return t.automationActionRename;
    case "add_tag": return t.automationActionAddTag;
    case "remove_tag": return t.automationActionRemoveTag;
    case "trash": return t.automationActionTrash;
    case "notify": return t.automationActionNotify;
  }
}

function actionPlaceholder(k: Action["kind"], t: ReturnType<typeof useTranslation>): string {
  switch (k) {
    case "move_to": case "copy_to": return t.automationActionPathPh;
    case "rename": return t.automationActionRenamePh;
    case "add_tag": case "remove_tag": return t.automationActionTagPh;
    case "trash": return "";
    case "notify": return t.automationActionMessagePh;
  }
}

// ── Presets gallery ──────────────────────────────────────────────────────────

function PresetsGallery({ onPick }: { onPick: (preset: Preset) => void }) {
  const t = useTranslation();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {PRESETS.map((preset) => {
        const Icon = preset.icon;
        return (
          <button
            key={preset.id}
            onClick={() => onPick(preset)}
            className="flex items-start gap-2 text-left px-3 py-2.5 rounded-lg bg-surface-2 border border-border-subtle hover:bg-surface-3 hover:border-accent/40 transition-colors"
          >
            <Icon size={14} className="text-accent shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-medium text-text-primary leading-tight">
                {t[preset.nameKey] as string}
              </div>
              <p className="text-[10px] text-text-muted mt-0.5 leading-snug">
                {t[preset.descKey] as string}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Run-now view ─────────────────────────────────────────────────────────────

function RunPanel({
  rule, onClose,
}: { rule: AutomationRule; onClose: () => void }) {
  const t = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const [targetDir, setTargetDir] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [report, setReport] = useState<RunReport | null>(null);
  const [busy, setBusy] = useState(false);

  const browse = async () => {
    const p = await open({ directory: true, multiple: false });
    if (typeof p === "string") setTargetDir(p);
  };

  const run = async (dryRun: boolean) => {
    if (!targetDir.trim()) {
      addToast({ type: "warning", message: t.automationRunNoTarget });
      return;
    }
    setBusy(true);
    try {
      const r = await invoke<RunReport>("run_automation_rule_manual", {
        input: {
          rule_id: rule.id,
          target_dir: targetDir.trim(),
          dry_run: dryRun,
          recursive,
        },
      });
      setReport(r);
      if (!dryRun) {
        addToast({
          type: "success",
          message: t.automationRunDone.replace("{n}", String(r.actions_succeeded)),
        });
      }
    } catch (e) {
      addToast({ type: "error", message: t.automationRunFailed, detail: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-5 py-4 flex flex-col gap-3">
      <div className="text-[12px] text-text-primary font-medium">{rule.name}</div>

      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-text-muted uppercase tracking-widest">
          {t.automationRunTargetDir}
        </label>
        <div className="flex gap-1">
          <input
            autoFocus
            value={targetDir}
            onChange={(e) => setTargetDir(e.target.value)}
            placeholder={t.automationRunTargetDirPh}
            className="flex-1 h-7 px-2.5 rounded bg-surface-2 border border-border text-[12px] text-text-primary placeholder-text-muted outline-none focus:border-accent font-mono"
          />
          <button
            onClick={browse}
            className="h-7 px-2.5 rounded bg-surface-2 border border-border text-[11px] text-text-secondary hover:bg-surface-3 transition-colors flex items-center gap-1"
          >
            <FolderOpen size={11} /> {t.automationBrowse}
          </button>
        </div>
      </div>

      <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer">
        <input
          type="checkbox"
          checked={recursive}
          onChange={(e) => setRecursive(e.target.checked)}
        />
        {t.automationRunRecursive}
      </label>

      <div className="flex gap-2">
        <button
          onClick={() => run(true)}
          disabled={busy}
          className="h-8 px-3 rounded border border-border text-[11px] text-text-secondary hover:bg-surface-3 transition-colors disabled:opacity-50"
        >
          {t.automationRunDryRun}
        </button>
        <button
          onClick={() => run(false)}
          disabled={busy || !rule.enabled}
          title={!rule.enabled ? t.automationRunDisabled : undefined}
          className="h-8 px-3 rounded bg-accent text-white text-[11px] font-medium hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t.automationRunApply}
        </button>
        <button
          onClick={onClose}
          className="ml-auto h-8 px-3 rounded border border-border text-[11px] text-text-muted hover:bg-surface-3 transition-colors"
        >
          {t.close}
        </button>
      </div>

      {report && (
        <div className="border border-border-subtle rounded-lg overflow-hidden">
          <div className="px-3 py-2 bg-surface-2 text-[11px] text-text-secondary flex items-center gap-3">
            <span>
              {report.dry_run
                ? t.automationRunReportDry.replace("{matched}", String(report.matched_files)).replace("{actions}", String(report.actions_attempted))
                : t.automationRunReportLive
                    .replace("{ok}", String(report.actions_succeeded))
                    .replace("{total}", String(report.actions_attempted))}
            </span>
          </div>
          {report.outcomes.length > 0 && (
            <div className="max-h-48 overflow-y-auto">
              {report.outcomes.map((o, i) => (
                <div
                  key={i}
                  className={`px-3 py-1.5 text-[10px] border-t border-border-subtle font-mono ${
                    o.success ? "text-text-secondary" : "text-red-400"
                  }`}
                >
                  <div className="truncate">{o.action}</div>
                  <div className="text-text-muted truncate" title={o.file_before}>
                    {o.file_before}
                    {o.file_after && o.file_after !== o.file_before && ` → ${o.file_after}`}
                  </div>
                  {o.error && <div className="text-red-400 truncate" title={o.error}>{o.error}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
