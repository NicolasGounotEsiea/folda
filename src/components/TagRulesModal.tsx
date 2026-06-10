import { invoke } from "@tauri-apps/api/core";
import { clsx } from "clsx";
import { Plus, Trash2, X, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { useStore } from "../store/useStore";
import type { Tag, TagRule } from "../types";

type RuleType = TagRule["rule_type"];

const RULE_TYPE_LABELS: Record<RuleType, string> = {
  ext:           "Extension is",
  name_contains: "Name contains",
  name_starts:   "Name starts with",
  path_contains: "Path contains",
  size_gt:       "Size greater than",
  size_lt:       "Size less than",
};

const RULE_TYPES: RuleType[] = ["ext", "name_contains", "name_starts", "path_contains", "size_gt", "size_lt"];
const SIZE_UNITS = ["B", "KB", "MB", "GB"];

function sizeToBytes(value: string, unit: string): string {
  const v = parseFloat(value) || 0;
  const multipliers: Record<string, number> = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };
  return String(Math.round(v * (multipliers[unit] ?? 1)));
}

function bytesToDisplay(bytes: string): { value: string; unit: string } {
  const b = parseInt(bytes, 10) || 0;
  if (b >= 1024 * 1024 * 1024) return { value: (b / (1024 * 1024 * 1024)).toFixed(1), unit: "GB" };
  if (b >= 1024 * 1024) return { value: (b / (1024 * 1024)).toFixed(1), unit: "MB" };
  if (b >= 1024) return { value: (b / 1024).toFixed(1), unit: "KB" };
  return { value: String(b), unit: "B" };
}

const TAG_COLORS = [
  "#6366f1","#ec4899","#f59e0b","#10b981","#3b82f6",
  "#8b5cf6","#ef4444","#14b8a6","#f43f5e","#84cc16",
];

interface NewRuleState {
  tagId: number | null;
  ruleType: RuleType;
  value: string;
  sizeUnit: string;
  creatingTag: boolean;
  newTagName: string;
  newTagColor: string;
}

interface EditRuleState {
  id: number;
  tagId: number;
  ruleType: RuleType;
  value: string;
  sizeUnit: string;
}

export function TagRulesModal({ onClose }: { onClose: () => void }) {
  const { tags, activeContextId, currentPath, setListEntries, setTags } = useStore();
  const [rules, setRules] = useState<TagRule[]>([]);
  const [editingRule, setEditingRule] = useState<EditRuleState | null>(null);
  const [newRule, setNewRule] = useState<NewRuleState>({
    tagId: tags.find((t) => !t.is_auto)?.id ?? null,
    ruleType: "ext",
    value: "",
    sizeUnit: "MB",
    creatingTag: false,
    newTagName: "",
    newTagColor: TAG_COLORS[0],
  });

  useEffect(() => {
    invoke<TagRule[]>("get_tag_rules", { contextId: activeContextId ?? 0 })
      .then(setRules)
      .catch(console.error);
  }, [activeContextId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreateTag = async () => {
    if (!newRule.newTagName.trim()) return;
    try {
      const id = await invoke<number>("create_tag", {
        name: newRule.newTagName.trim(),
        color: newRule.newTagColor,
      });
      const updatedTags = await invoke<Tag[]>("get_tags");
      setTags(updatedTags);
      setNewRule((r) => ({ ...r, tagId: id, creatingTag: false, newTagName: "" }));
    } catch (e) { console.error(e); }
  };

  const handleAdd = async () => {
    if (!newRule.tagId || !newRule.value.trim()) return;
    const isSizeRule = newRule.ruleType === "size_gt" || newRule.ruleType === "size_lt";
    const ruleValue = isSizeRule
      ? sizeToBytes(newRule.value, newRule.sizeUnit)
      : newRule.value.trim().toLowerCase();
    try {
      await invoke("create_tag_rule", {
        tagId: newRule.tagId,
        ruleType: newRule.ruleType,
        ruleValue,
        contextId: activeContextId ?? 0,
      });
      const updated = await invoke<TagRule[]>("get_tag_rules", { contextId: activeContextId ?? 0 });
      setRules(updated);
      // Refresh file list so new rules take effect immediately
      if (currentPath) {
        const entries = await invoke<unknown[]>("list_directory", {
          path: currentPath,
          contextId: activeContextId ?? 0,
        });
        setListEntries(entries as Parameters<typeof setListEntries>[0]);
      }
      setNewRule((r) => ({ ...r, value: "" }));
    } catch (e) { console.error(e); }
  };

  const handleDelete = async (id: number) => {
    try {
      await invoke("delete_tag_rule", { id });
      setRules((r) => r.filter((x) => x.id !== id));
      if (editingRule?.id === id) setEditingRule(null);
    } catch (e) { console.error(e); }
  };

  const handleStartEdit = (rule: TagRule) => {
    const isSz = rule.rule_type === "size_gt" || rule.rule_type === "size_lt";
    const { value, unit } = isSz ? bytesToDisplay(rule.rule_value) : { value: rule.rule_value, unit: "MB" };
    setEditingRule({ id: rule.id, tagId: rule.tag_id, ruleType: rule.rule_type as RuleType, value, sizeUnit: unit });
  };

  const handleSaveEdit = async () => {
    if (!editingRule || !editingRule.value.trim()) return;
    const isSz = editingRule.ruleType === "size_gt" || editingRule.ruleType === "size_lt";
    const ruleValue = isSz
      ? sizeToBytes(editingRule.value, editingRule.sizeUnit)
      : editingRule.value.trim().toLowerCase();
    try {
      await invoke("delete_tag_rule", { id: editingRule.id });
      await invoke("create_tag_rule", {
        tagId: editingRule.tagId,
        ruleType: editingRule.ruleType,
        ruleValue,
        contextId: activeContextId ?? 0,
      });
      const updated = await invoke<TagRule[]>("get_tag_rules", { contextId: activeContextId ?? 0 });
      setRules(updated);
      setEditingRule(null);
      if (currentPath) {
        const entries = await invoke<unknown[]>("list_directory", { path: currentPath, contextId: activeContextId ?? 0 });
        setListEntries(entries as Parameters<typeof setListEntries>[0]);
      }
    } catch (e) { console.error(e); }
  };

  const validRules = rules.filter((r) => tags.some((t) => t.id === r.tag_id));
  const tagById = (id: number): Tag | undefined => tags.find((t) => t.id === id);
  const userTags = tags.filter((t) => !t.is_auto);
  const isSizeRule = newRule.ruleType === "size_gt" || newRule.ruleType === "size_lt";

  return (
    <div className="modal-backdrop-in fixed inset-0 z-[300] flex items-center justify-center bg-black/60">
      <div className="modal-content-in bg-surface-1 border border-border rounded-xl shadow-2xl w-[540px] max-h-[80vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-border-subtle shrink-0">
          <Zap size={15} className="text-accent shrink-0" />
          <span className="text-[13px] font-semibold text-text-primary flex-1">Tag Rules</span>
          <span className="text-[11px] text-text-muted">Auto-tag files by condition</span>
          <button onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors ml-2">
            <X size={13} />
          </button>
        </div>

        {/* Rules list */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {validRules.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-text-muted">
              <Zap size={28} className="opacity-20" />
              <span className="text-[12px]">No rules yet — add one below</span>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {validRules.map((rule) => {
                const tag = tagById(rule.tag_id);
                const isEditingThis = editingRule?.id === rule.id;
                const isSz = rule.rule_type === "size_gt" || rule.rule_type === "size_lt";
                const displayVal = isSz ? (() => {
                  const { value, unit } = bytesToDisplay(rule.rule_value);
                  return `${value} ${unit}`;
                })() : rule.rule_value;

                if (isEditingThis && editingRule) {
                  const editIsSz = editingRule.ruleType === "size_gt" || editingRule.ruleType === "size_lt";
                  return (
                    <div key={rule.id} className="rounded-lg bg-surface-2 border border-accent/40 p-2.5 flex flex-col gap-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <select
                          value={editingRule.tagId}
                          onChange={(e) => setEditingRule((r) => r && ({ ...r, tagId: Number(e.target.value) }))}
                          className="h-7 px-2 rounded bg-surface-3 border border-border text-[12px] text-text-primary outline-none focus:border-accent"
                        >
                          {tags.filter((t) => !t.is_auto).map((t) => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </select>
                        <select
                          value={editingRule.ruleType}
                          onChange={(e) => setEditingRule((r) => r && ({ ...r, ruleType: e.target.value as RuleType }))}
                          className="h-7 px-2 rounded bg-surface-3 border border-border text-[12px] text-text-primary outline-none focus:border-accent"
                        >
                          {RULE_TYPES.map((rt) => <option key={rt} value={rt}>{RULE_TYPE_LABELS[rt]}</option>)}
                        </select>
                        <input
                          autoFocus
                          type={editIsSz ? "number" : "text"}
                          value={editingRule.value}
                          onChange={(e) => setEditingRule((r) => r && ({ ...r, value: e.target.value }))}
                          onKeyDown={(e) => { if (e.key === "Enter") handleSaveEdit(); if (e.key === "Escape") setEditingRule(null); }}
                          className="h-7 px-2 rounded bg-surface-3 border border-border text-[12px] text-text-primary outline-none focus:border-accent flex-1 min-w-[80px]"
                        />
                        {editIsSz && (
                          <select
                            value={editingRule.sizeUnit}
                            onChange={(e) => setEditingRule((r) => r && ({ ...r, sizeUnit: e.target.value }))}
                            className="h-7 px-2 rounded bg-surface-3 border border-border text-[12px] text-text-primary outline-none focus:border-accent"
                          >
                            {SIZE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                          </select>
                        )}
                      </div>
                      <div className="flex items-center justify-between">
                        <button onClick={() => handleDelete(rule.id)}
                          className="text-[11px] text-red-400 hover:text-red-300 transition-colors flex items-center gap-1">
                          <Trash2 size={10} /> Delete
                        </button>
                        <div className="flex items-center gap-1">
                          <button onClick={() => setEditingRule(null)}
                            className="h-5 px-2 rounded text-[11px] text-text-muted hover:bg-surface-3 transition-colors">
                            Cancel
                          </button>
                          <button onClick={handleSaveEdit} disabled={!editingRule.value.trim()}
                            className="h-5 px-2 rounded bg-accent text-white text-[11px] disabled:opacity-30 hover:bg-accent/80 transition-colors">
                            Save
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={rule.id}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-2 border border-border-subtle group">
                    {tag && (
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-medium shrink-0"
                        style={{ background: tag.color + "25", color: tag.color }}>
                        {tag.name}
                      </span>
                    )}
                    <span className="text-[11px] text-text-muted shrink-0">
                      {RULE_TYPE_LABELS[rule.rule_type]}
                    </span>
                    <span className="flex-1 text-[11px] text-text-primary font-mono truncate">
                      {displayVal}
                    </span>
                    {rule.context_id !== 0 && (
                      <span className="text-[9px] text-text-muted bg-surface-3 px-1.5 py-0.5 rounded shrink-0">workspace</span>
                    )}
                    <button
                      onClick={() => handleStartEdit(rule)}
                      className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-all shrink-0">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDelete(rule.id)}
                      className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-red-400 hover:bg-surface-3 transition-all shrink-0">
                      <Trash2 size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Add rule form */}
        <div className="px-5 py-4 border-t border-border-subtle bg-surface-2 rounded-b-xl shrink-0">
          <p className="text-[10px] text-text-muted uppercase tracking-widest mb-2">Add rule</p>

          {/* Inline new-tag form */}
          {newRule.creatingTag ? (
            <div className="flex flex-col gap-2 mb-3 p-3 rounded-lg bg-surface-3 border border-border">
              <p className="text-[10px] text-text-muted">New tag</p>
              <input
                autoFocus
                type="text"
                value={newRule.newTagName}
                onChange={(e) => setNewRule((r) => ({ ...r, newTagName: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateTag(); if (e.key === "Escape") setNewRule((r) => ({ ...r, creatingTag: false })); }}
                placeholder="Tag name…"
                className="h-7 px-2 rounded bg-surface-1 border border-border text-[12px] text-text-primary placeholder-text-muted outline-none focus:border-accent"
              />
              <div className="flex items-center gap-1.5 flex-wrap">
                {TAG_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setNewRule((r) => ({ ...r, newTagColor: c }))}
                    className={clsx("w-5 h-5 rounded-full transition-transform", newRule.newTagColor === c && "ring-2 ring-offset-1 ring-offset-surface-3 ring-white scale-110")}
                    style={{ background: c }}
                  />
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleCreateTag}
                  disabled={!newRule.newTagName.trim()}
                  className="h-7 px-3 rounded bg-accent text-white text-[12px] disabled:opacity-30 hover:bg-accent/80 transition-colors"
                >
                  Create tag
                </button>
                <button
                  onClick={() => setNewRule((r) => ({ ...r, creatingTag: false }))}
                  className="h-7 px-3 rounded bg-surface-1 border border-border text-[12px] text-text-muted hover:text-text-primary transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          <div className="flex items-center gap-2 flex-wrap">
            {/* Tag selector */}
            <div className="flex items-center gap-1">
              <select
                value={newRule.tagId ?? ""}
                onChange={(e) => setNewRule((r) => ({ ...r, tagId: Number(e.target.value) }))}
                className="h-7 px-2 rounded bg-surface-3 border border-border text-[12px] text-text-primary outline-none focus:border-accent"
              >
                <option value="" disabled>Tag…</option>
                {userTags.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <button
                onClick={() => setNewRule((r) => ({ ...r, creatingTag: !r.creatingTag }))}
                title="Create new tag"
                className="w-7 h-7 flex items-center justify-center rounded bg-surface-3 border border-border text-text-muted hover:text-accent hover:border-accent transition-colors"
              >
                <Plus size={12} />
              </button>
            </div>

            {/* Rule type */}
            <select
              value={newRule.ruleType}
              onChange={(e) => setNewRule((r) => ({ ...r, ruleType: e.target.value as RuleType }))}
              className="h-7 px-2 rounded bg-surface-3 border border-border text-[12px] text-text-primary outline-none focus:border-accent"
            >
              {RULE_TYPES.map((rt) => (
                <option key={rt} value={rt}>{RULE_TYPE_LABELS[rt]}</option>
              ))}
            </select>

            {/* Value */}
            <input
              type={isSizeRule ? "number" : "text"}
              value={newRule.value}
              onChange={(e) => setNewRule((r) => ({ ...r, value: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
              placeholder={isSizeRule ? "e.g. 10" : newRule.ruleType === "ext" ? "e.g. rs" : "value…"}
              className="h-7 px-2 rounded bg-surface-3 border border-border text-[12px] text-text-primary placeholder-text-muted outline-none focus:border-accent flex-1 min-w-[80px]"
            />

            {/* Size unit selector */}
            {isSizeRule && (
              <select
                value={newRule.sizeUnit}
                onChange={(e) => setNewRule((r) => ({ ...r, sizeUnit: e.target.value }))}
                className="h-7 px-2 rounded bg-surface-3 border border-border text-[12px] text-text-primary outline-none focus:border-accent"
              >
                {SIZE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            )}

            <button
              onClick={handleAdd}
              disabled={!newRule.tagId || !newRule.value.trim()}
              className="h-7 px-3 rounded bg-accent text-white text-[12px] disabled:opacity-30 hover:bg-accent/80 transition-colors flex items-center gap-1 shrink-0"
            >
              <Plus size={11} /> Add
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-5 py-3 border-t border-border-subtle shrink-0">
          <span className="text-[11px] text-text-muted">Rules apply automatically when browsing folders</span>
        </div>
      </div>
    </div>
  );
}
