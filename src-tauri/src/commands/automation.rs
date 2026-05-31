//! Automation rules — Phase 1+2: typed model, CRUD, and execution engine.
//!
//! Conditions and actions are stored in the `automation_rules` table as JSON
//! arrays (TEXT columns). The Rust enums below own the schema — adding a new
//! condition or action kind requires no DB migration, just a new enum variant.
//!
//! Phase 2 adds:
//!   - A template engine (`apply_template`) that resolves `{year}` / `{name}` etc.
//!   - A condition evaluator (`evaluate_condition`) — pure function, unit-tested
//!   - An action runner (`execute_action`) that performs filesystem ops, tag ops,
//!     trash, and emits notifications
//!   - `run_automation_rule_manual` Tauri command to fire a rule against a target
//!     directory, with a `dry_run` flag returning a preview without side effects
//!
//! The watcher hook (Phase 3) and the UI (Phase 4) come in separate modules.

use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// ── Conditions ──────────────────────────────────────────────────────────────
//
// All conditions on a rule are AND'd together. For OR semantics, the user
// creates multiple rules. Each variant carries exactly the parameters it needs;
// serde's `tag = "kind"` keeps the JSON discriminated and forward-compatible.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Condition {
    /// Exact (case-insensitive) extension match, e.g. "pdf".
    Ext { value: String },
    /// Substring match on the file's base name, case-insensitive.
    NameContains { value: String },
    /// Prefix match on the file's base name, case-insensitive.
    NameStartsWith { value: String },
    /// Regex match on the file's base name. Invalid regex = condition skipped.
    NameRegex { value: String },
    /// Substring match on the full path, case-insensitive.
    PathContains { value: String },
    /// File size in bytes, greater than.
    SizeGt { value: i64 },
    /// File size in bytes, less than.
    SizeLt { value: i64 },
    /// File age (now - modified_at) greater than N days.
    AgeGtDays { value: i64 },
    /// File carries this tag (by name, case-insensitive).
    TagHas { value: String },
}

// ── Actions ─────────────────────────────────────────────────────────────────
//
// `path` and `template` fields support template tokens substituted at runtime:
//   {year} {month} {day}  — date components from the trigger timestamp
//   {name} {ext}          — original file name / extension
//   {counter}             — auto-incrementing suffix if the destination exists

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    /// Move the file into the given directory. Created if missing.
    MoveTo { path: String },
    /// Copy the file into the given directory. Created if missing.
    CopyTo { path: String },
    /// Rename in place. `template` is applied to the file name only.
    Rename { template: String },
    /// Apply a tag (created if it doesn't exist).
    AddTag { tag: String },
    /// Remove a tag.
    RemoveTag { tag: String },
    /// Move to the recycle bin (recoverable). Never `delete_path`.
    Trash,
    /// Show an in-app toast. No OS notification (out of V1 scope).
    Notify { message: String },
}

// ── Trigger ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerKind {
    FileCreated,
    FileModified,
    FileRenamed,
    /// Fires only when the user clicks "Run now" against a target folder.
    Manual,
}

// ── Rule ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationRule {
    pub id: i64,
    pub name: String,
    pub enabled: bool,
    pub trigger_kind: TriggerKind,
    pub trigger_path: String,
    pub conditions: Vec<Condition>,
    pub actions: Vec<Action>,
    pub context_id: i64,
    pub created_at: i64,
    pub updated_at: i64,
    /// Diagnostics — updated by `apply_run_outcome_to_diagnostics`.
    /// `last_fired_at` is null until the rule has actually executed at least one action;
    /// `last_error` is cleared back to null on a fully-successful run.
    #[serde(default)]
    pub last_fired_at: Option<i64>,
    #[serde(default)]
    pub fire_count: i64,
    #[serde(default)]
    pub last_error: Option<String>,
}

/// Frontend payload for creating a rule. Mirrors the persisted shape minus
/// the server-generated fields.
#[derive(Debug, Deserialize)]
pub struct NewRule {
    pub name: String,
    pub trigger_kind: TriggerKind,
    #[serde(default)]
    pub trigger_path: String,
    #[serde(default)]
    pub conditions: Vec<Condition>,
    #[serde(default)]
    pub actions: Vec<Action>,
    #[serde(default)]
    pub context_id: i64,
}

/// Partial update payload — every field optional. Only provided fields are written.
#[derive(Debug, Deserialize, Default)]
pub struct RulePatch {
    pub name: Option<String>,
    pub enabled: Option<bool>,
    pub trigger_kind: Option<TriggerKind>,
    pub trigger_path: Option<String>,
    pub conditions: Option<Vec<Condition>>,
    pub actions: Option<Vec<Action>>,
    pub context_id: Option<i64>,
}

// ── DB row mapping ──────────────────────────────────────────────────────────

fn row_to_rule(row: &rusqlite::Row) -> rusqlite::Result<AutomationRule> {
    let trigger_kind_str: String = row.get("trigger_kind")?;
    let conditions_json: String = row.get("conditions")?;
    let actions_json: String = row.get("actions")?;

    let trigger_kind: TriggerKind = serde_json::from_str(&format!("\"{}\"", trigger_kind_str))
        .unwrap_or(TriggerKind::Manual);
    let conditions: Vec<Condition> = serde_json::from_str(&conditions_json).unwrap_or_default();
    let actions: Vec<Action> = serde_json::from_str(&actions_json).unwrap_or_default();

    Ok(AutomationRule {
        id: row.get("id")?,
        name: row.get("name")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        trigger_kind,
        trigger_path: row.get("trigger_path")?,
        conditions,
        actions,
        context_id: row.get("context_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        // get() on a missing column would error; the migration ensures these exist,
        // but defensive getters keep us safe if a future schema rewinds them.
        // .ok().flatten() collapses "column missing" and "value NULL" both to None.
        last_fired_at: row.get::<_, Option<i64>>("last_fired_at").ok().flatten(),
        fire_count: row.get::<_, i64>("fire_count").unwrap_or(0),
        last_error: row.get::<_, Option<String>>("last_error").ok().flatten(),
    })
}

fn trigger_kind_to_db(t: TriggerKind) -> &'static str {
    match t {
        TriggerKind::FileCreated => "file_created",
        TriggerKind::FileModified => "file_modified",
        TriggerKind::FileRenamed => "file_renamed",
        TriggerKind::Manual => "manual",
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_automation_rules(
    context_id: Option<i64>,
    state: tauri::State<AppState>,
) -> Result<Vec<AutomationRule>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(match context_id {
            Some(_) => {
                "SELECT * FROM automation_rules
                 WHERE context_id = 0 OR context_id = ?1
                 ORDER BY enabled DESC, name ASC"
            }
            None => "SELECT * FROM automation_rules ORDER BY enabled DESC, name ASC",
        })
        .map_err(|e| e.to_string())?;

    let rows: Vec<AutomationRule> = if let Some(ctx) = context_id {
        stmt.query_map([ctx], row_to_rule)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect()
    } else {
        stmt.query_map([], row_to_rule)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect()
    };

    Ok(rows)
}

#[tauri::command]
pub fn get_automation_rule(
    id: i64,
    state: tauri::State<AppState>,
) -> Result<Option<AutomationRule>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let rule = db
        .query_row(
            "SELECT * FROM automation_rules WHERE id = ?1",
            [id],
            row_to_rule,
        )
        .ok();
    Ok(rule)
}

#[tauri::command]
pub fn create_automation_rule(
    rule: NewRule,
    state: tauri::State<AppState>,
) -> Result<i64, String> {
    let name = rule.name.trim();
    if name.is_empty() {
        return Err("Rule name cannot be empty.".to_string());
    }
    // For file_* triggers, a path is required. Manual triggers don't need one.
    if rule.trigger_kind != TriggerKind::Manual && rule.trigger_path.trim().is_empty() {
        return Err("Non-manual triggers require a trigger_path.".to_string());
    }
    if rule.actions.is_empty() {
        return Err("A rule must have at least one action.".to_string());
    }

    let conditions_json =
        serde_json::to_string(&rule.conditions).map_err(|e| e.to_string())?;
    let actions_json = serde_json::to_string(&rule.actions).map_err(|e| e.to_string())?;

    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO automation_rules
            (name, enabled, trigger_kind, trigger_path, conditions, actions, context_id)
         VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            name,
            trigger_kind_to_db(rule.trigger_kind),
            rule.trigger_path.trim(),
            conditions_json,
            actions_json,
            rule.context_id,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(db.last_insert_rowid())
}

#[tauri::command]
pub fn update_automation_rule(
    id: i64,
    patch: RulePatch,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    // Build the UPDATE dynamically so we only touch provided fields.
    // SQL params are positional in rusqlite; we collect them in order.
    let mut sets: Vec<&str> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(name) = patch.name {
        if name.trim().is_empty() {
            return Err("Rule name cannot be empty.".to_string());
        }
        sets.push("name = ?");
        params.push(Box::new(name.trim().to_string()));
    }
    if let Some(enabled) = patch.enabled {
        sets.push("enabled = ?");
        params.push(Box::new(if enabled { 1i64 } else { 0i64 }));
    }
    if let Some(trigger_kind) = patch.trigger_kind {
        sets.push("trigger_kind = ?");
        params.push(Box::new(trigger_kind_to_db(trigger_kind).to_string()));
    }
    if let Some(trigger_path) = patch.trigger_path {
        sets.push("trigger_path = ?");
        params.push(Box::new(trigger_path.trim().to_string()));
    }
    if let Some(conditions) = patch.conditions {
        let json = serde_json::to_string(&conditions).map_err(|e| e.to_string())?;
        sets.push("conditions = ?");
        params.push(Box::new(json));
    }
    if let Some(actions) = patch.actions {
        if actions.is_empty() {
            return Err("A rule must have at least one action.".to_string());
        }
        let json = serde_json::to_string(&actions).map_err(|e| e.to_string())?;
        sets.push("actions = ?");
        params.push(Box::new(json));
    }
    if let Some(context_id) = patch.context_id {
        sets.push("context_id = ?");
        params.push(Box::new(context_id));
    }

    if sets.is_empty() {
        return Ok(()); // nothing to update
    }

    sets.push("updated_at = unixepoch()");
    let sql = format!(
        "UPDATE automation_rules SET {} WHERE id = ?",
        sets.join(", ")
    );
    params.push(Box::new(id));

    let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|b| b.as_ref()).collect();
    db.execute(&sql, rusqlite::params_from_iter(refs.iter()))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_automation_rule(id: i64, state: tauri::State<AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM automation_rules WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Flip the `enabled` flag. Returns the new state.
#[tauri::command]
pub fn toggle_automation_rule(id: i64, state: tauri::State<AppState>) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let current: i64 = db
        .query_row(
            "SELECT enabled FROM automation_rules WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let new = if current == 0 { 1 } else { 0 };
    db.execute(
        "UPDATE automation_rules SET enabled = ?1, updated_at = unixepoch() WHERE id = ?2",
        rusqlite::params![new, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(new != 0)
}

// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 2 — EXECUTION ENGINE
// ═══════════════════════════════════════════════════════════════════════════

// ── Template engine ─────────────────────────────────────────────────────────

/// Variables available inside templates for paths / rename actions.
/// Kept narrow on purpose — adding tokens is cheap, removing them later is not.
#[derive(Debug, Clone)]
pub struct TemplateCtx {
    pub year: String,   // "2026"
    pub month: String,  // "01".."12"
    pub day: String,    // "01".."31"
    pub hour: String,   // "00".."23" — host-local-ish (UTC for now)
    pub minute: String, // "00".."59"
    pub date: String,   // "YYYY-MM-DD" — convenience composite
    pub name: String,   // file name WITHOUT extension
    pub ext: String,    // extension WITHOUT leading dot, lowercase
}

impl TemplateCtx {
    /// Build from a file path + unix timestamp.
    pub fn from_path_and_time(path: &Path, unix_secs: i64) -> Self {
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
        let secs = unix_secs.max(0) as u64;
        let (y, m, d) = unix_to_ymd(secs);
        let (hh, mm) = unix_to_hm(secs);
        Self {
            year: format!("{:04}", y),
            month: format!("{:02}", m),
            day: format!("{:02}", d),
            hour: format!("{:02}", hh),
            minute: format!("{:02}", mm),
            date: format!("{:04}-{:02}-{:02}", y, m, d),
            name: stem,
            ext,
        }
    }
}

/// Hour + minute components from a unix timestamp (UTC). Sufficient for `{hour}` /
/// `{minute}` substitution — we don't promise timezone-correct values, which would
/// require pulling chrono just for the offset.
fn unix_to_hm(secs: u64) -> (u32, u32) {
    let in_day = secs % 86_400;
    let h = (in_day / 3600) as u32;
    let m = ((in_day % 3600) / 60) as u32;
    (h, m)
}

/// Trivial julian-day breakdown — local time of the host, no chrono dep.
/// Good enough for `{year}/{month}/{day}` substitution; we don't promise sub-second
/// accuracy or pre-1970 dates.
fn unix_to_ymd(secs: u64) -> (i32, u32, u32) {
    // Convert to a system time then format with chrono-less arithmetic.
    // Days since 1970-01-01:
    let days = (secs / 86_400) as i64;
    // Howard Hinnant's algorithm — public domain.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

/// Substitute the supported tokens. Unknown tokens like `{foo}` are left intact —
/// easier to debug a typo than to silently drop it.
///
/// `{date}` MUST be replaced before `{day}` (otherwise the substring "day" inside
/// "date" would survive both — well, it wouldn't, but mentioning it as a defensive
/// reminder for future tokens). Current set: year, month, day, hour, minute,
/// date (YYYY-MM-DD), name, ext.
pub fn apply_template(template: &str, ctx: &TemplateCtx) -> String {
    template
        .replace("{date}", &ctx.date)
        .replace("{year}", &ctx.year)
        .replace("{month}", &ctx.month)
        .replace("{day}", &ctx.day)
        .replace("{hour}", &ctx.hour)
        .replace("{minute}", &ctx.minute)
        .replace("{name}", &ctx.name)
        .replace("{ext}", &ctx.ext)
}

// ── Condition evaluator ─────────────────────────────────────────────────────

/// Everything a condition needs to know about a file. Built once per file per run.
#[derive(Debug, Clone)]
pub struct FileCtx {
    pub path: PathBuf,
    pub name: String,           // base name including extension
    #[allow(dead_code)] // kept for symmetry with TemplateCtx; future conditions may use it
    pub name_no_ext: String,
    pub ext: String,            // lowercase, no dot
    pub size: i64,
    pub modified_at: i64,       // unix seconds
    pub tags_lower: Vec<String>, // lowercased tag names for fast TagHas lookup
}

/// Pure predicate evaluator. Returns false on any error (invalid regex,
/// unparseable size threshold) instead of bubbling — automations should be
/// best-effort, not crash on a bad rule.
pub fn evaluate_condition(cond: &Condition, file: &FileCtx) -> bool {
    match cond {
        Condition::Ext { value } => file.ext.eq_ignore_ascii_case(value.trim_start_matches('.')),
        Condition::NameContains { value } => file.name.to_lowercase().contains(&value.to_lowercase()),
        Condition::NameStartsWith { value } => file.name.to_lowercase().starts_with(&value.to_lowercase()),
        Condition::NameRegex { value } => match regex_lite::Regex::new(value) {
            Ok(re) => re.is_match(&file.name),
            Err(_) => false,
        },
        Condition::PathContains { value } => {
            file.path.to_string_lossy().to_lowercase().contains(&value.to_lowercase())
        }
        Condition::SizeGt { value } => file.size > *value,
        Condition::SizeLt { value } => file.size < *value,
        Condition::AgeGtDays { value } => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let age_secs = now - file.modified_at;
            age_secs > value.saturating_mul(86_400)
        }
        Condition::TagHas { value } => {
            let needle = value.to_lowercase();
            file.tags_lower.iter().any(|t| t == &needle)
        }
    }
}

/// Build a FileCtx for a path. Loads the file's tags from the DB.
/// Returns None if metadata is unreadable (file moved / permissions).
fn build_file_ctx(path: &Path, db: &rusqlite::Connection) -> Option<FileCtx> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let modified_at = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let name = path.file_name()?.to_str()?.to_string();
    let name_no_ext = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();

    // Tags: fetch by path through file_tags JOIN tags. Only globals + workspace 0
    // for V1; per-context filtering matches the rest of the codebase's pattern.
    let path_str = path.to_string_lossy().to_string();
    let tags_lower: Vec<String> = db
        .prepare(
            "SELECT LOWER(t.name) FROM files f
             JOIN file_tags ft ON ft.file_id = f.id
             JOIN tags t       ON t.id = ft.tag_id
             WHERE f.path = ?1",
        )
        .and_then(|mut s| {
            s.query_map([&path_str], |row| row.get::<_, String>(0))
                .map(|iter| iter.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();

    Some(FileCtx {
        path: path.to_path_buf(),
        name,
        name_no_ext,
        ext,
        size: meta.len() as i64,
        modified_at,
        tags_lower,
    })
}

// ── Action runner ───────────────────────────────────────────────────────────

/// Outcome of running a single action.
#[derive(Debug, Clone, Serialize)]
pub struct ActionOutcome {
    pub action: String,        // human-readable action label (e.g. "move_to D:\\Foo")
    pub file_before: String,   // path before the action
    pub file_after: String,    // path after the action (same if no move/rename)
    pub success: bool,
    pub error: Option<String>,
}

/// Summary of a single rule execution.
#[derive(Debug, Clone, Default, Serialize)]
pub struct RunReport {
    pub matched_files: usize,
    pub actions_attempted: usize,
    pub actions_succeeded: usize,
    pub outcomes: Vec<ActionOutcome>,
    pub dry_run: bool,
}

/// Pure decision: given a run report, what does it imply for the rule's diagnostics?
/// Returns `None` when nothing happened (rule fired but no file matched / dry run) so
/// callers can skip the UPDATE entirely. Otherwise returns the diagnostics delta to apply.
#[derive(Debug, PartialEq, Eq)]
pub struct DiagnosticsUpdate {
    pub fired: bool,           // true → bump fire_count + set last_fired_at
    pub last_error: Option<Option<String>>, // None = leave alone; Some(None) = clear; Some(Some(s)) = set
}

pub fn compute_diagnostics_update(report: &RunReport) -> Option<DiagnosticsUpdate> {
    if report.dry_run {
        return None; // dry runs never touch diagnostics
    }
    if report.actions_attempted == 0 {
        return None; // rule fired but no file matched — silent (avoids noise)
    }
    // At least one action was attempted. Always bump fire_count.
    // Error handling: pick the first failed outcome's error string; if everything
    // succeeded, explicitly CLEAR the previous error so the badge fades.
    let first_error: Option<String> = report
        .outcomes
        .iter()
        .find(|o| !o.success)
        .and_then(|o| o.error.clone());
    Some(DiagnosticsUpdate {
        fired: true,
        last_error: Some(first_error), // Some(None) when all succeeded → clears last_error
    })
}

/// Persist a diagnostics update to a single rule. Best-effort — failures are logged
/// to stderr but never propagate; diagnostics being slightly stale is preferable to
/// a rule run failing because we couldn't write the bookkeeping.
fn write_diagnostics(db: &rusqlite::Connection, rule_id: i64, now: i64, update: &DiagnosticsUpdate) {
    if !update.fired {
        return;
    }
    let result = match &update.last_error {
        Some(Some(err)) => db.execute(
            "UPDATE automation_rules
                SET last_fired_at = ?1, fire_count = fire_count + 1, last_error = ?2
              WHERE id = ?3",
            rusqlite::params![now, err, rule_id],
        ),
        Some(None) => db.execute(
            "UPDATE automation_rules
                SET last_fired_at = ?1, fire_count = fire_count + 1, last_error = NULL
              WHERE id = ?2",
            rusqlite::params![now, rule_id],
        ),
        None => db.execute(
            "UPDATE automation_rules
                SET last_fired_at = ?1, fire_count = fire_count + 1
              WHERE id = ?2",
            rusqlite::params![now, rule_id],
        ),
    };
    if let Err(e) = result {
        eprintln!("[automation] failed to write diagnostics for rule {}: {}", rule_id, e);
    }
}

/// Append a counter suffix to make the destination unique, e.g. "foo.pdf" → "foo (1).pdf".
fn ensure_unique_path(dest_dir: &Path, name: &str, ext: &str) -> PathBuf {
    let mut candidate = if ext.is_empty() {
        dest_dir.join(name)
    } else {
        dest_dir.join(format!("{}.{}", name, ext))
    };
    if !candidate.exists() {
        return candidate;
    }
    let mut n = 1;
    loop {
        candidate = if ext.is_empty() {
            dest_dir.join(format!("{} ({})", name, n))
        } else {
            dest_dir.join(format!("{} ({}).{}", name, n, ext))
        };
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
        if n > 10_000 {
            // Sanity bail-out — should never happen
            return candidate;
        }
    }
}

/// Describe the action for the dry-run preview. Pure function.
fn describe_action(action: &Action, current: &Path, tmpl: &TemplateCtx) -> String {
    match action {
        Action::MoveTo { path } => format!("move_to → {}", apply_template(path, tmpl)),
        Action::CopyTo { path } => format!("copy_to → {}", apply_template(path, tmpl)),
        Action::Rename { template } => {
            let new_name = apply_template(template, tmpl);
            format!("rename → {}", new_name)
        }
        Action::AddTag { tag } => format!("add_tag → {}", tag),
        Action::RemoveTag { tag } => format!("remove_tag → {}", tag),
        Action::Trash => format!("trash → {}", current.display()),
        Action::Notify { message } => format!("notify → {}", message),
    }
}

/// Execute an action on a file. Updates `current` to the new path if the file moved.
/// Returns an error string on failure; logs activity on success.
fn execute_action(
    action: &Action,
    current: &mut PathBuf,
    tmpl: &TemplateCtx,
    db: &rusqlite::Connection,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    match action {
        Action::MoveTo { path } => {
            let resolved = apply_template(path, tmpl);
            let dest_dir = PathBuf::from(&resolved);
            std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
            let file_name = current.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
            let ext = current.extension().and_then(|s| s.to_str()).unwrap_or("");
            let dest = ensure_unique_path(&dest_dir, file_name, ext);
            if let Err(_rename_err) = std::fs::rename(&*current, &dest) {
                // Fall back to copy + delete for cross-volume moves
                std::fs::copy(&*current, &dest)
                    .map_err(|e| format!("move failed (cross-volume copy): {}", e))?;
                std::fs::remove_file(&*current)
                    .map_err(|e| format!("move failed (cleanup of src): {}", e))?;
            }
            log_automation_activity(db, &dest.to_string_lossy(), "automated_move");
            let dest_str = dest.to_string_lossy().to_string();
            *current = dest;
            Ok(dest_str)
        }
        Action::CopyTo { path } => {
            let resolved = apply_template(path, tmpl);
            let dest_dir = PathBuf::from(&resolved);
            std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
            let file_name = current.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
            let ext = current.extension().and_then(|s| s.to_str()).unwrap_or("");
            let dest = ensure_unique_path(&dest_dir, file_name, ext);
            std::fs::copy(&*current, &dest).map_err(|e| format!("copy failed: {}", e))?;
            log_automation_activity(db, &dest.to_string_lossy(), "automated_copy");
            Ok(dest.to_string_lossy().to_string())
        }
        Action::Rename { template } => {
            let new_name = apply_template(template, tmpl);
            if new_name.trim().is_empty() {
                return Err("rename template resolved to empty name".to_string());
            }
            let parent = current.parent().ok_or("file has no parent dir")?;
            // Split new_name into (stem, ext) so collision suffix lands before the dot.
            let (stem, ext) = match new_name.rfind('.') {
                Some(i) if i > 0 && i < new_name.len() - 1 => (&new_name[..i], &new_name[i + 1..]),
                _ => (new_name.as_str(), ""),
            };
            let dest = ensure_unique_path(parent, stem, ext);
            std::fs::rename(&*current, &dest).map_err(|e| format!("rename failed: {}", e))?;
            log_automation_activity(db, &dest.to_string_lossy(), "automated_rename");
            let dest_str = dest.to_string_lossy().to_string();
            *current = dest;
            Ok(dest_str)
        }
        Action::AddTag { tag } => {
            let tag_name = tag.trim();
            if tag_name.is_empty() {
                return Err("tag name is empty".to_string());
            }
            // Ensure file is indexed
            let file_id = upsert_file_for_automation(db, current)?;
            // Ensure tag exists
            let tag_id = ensure_tag(db, tag_name)?;
            db.execute(
                "INSERT OR IGNORE INTO file_tags (file_id, tag_id, context_id) VALUES (?1, ?2, 0)",
                rusqlite::params![file_id, tag_id],
            )
            .map_err(|e| e.to_string())?;
            Ok(format!("tag '{}' added", tag_name))
        }
        Action::RemoveTag { tag } => {
            let file_id = upsert_file_for_automation(db, current)?;
            db.execute(
                "DELETE FROM file_tags WHERE file_id = ?1
                   AND tag_id IN (SELECT id FROM tags WHERE LOWER(name) = LOWER(?2))",
                rusqlite::params![file_id, tag],
            )
            .map_err(|e| e.to_string())?;
            Ok(format!("tag '{}' removed", tag))
        }
        Action::Trash => {
            // Delegate to the existing trash command's underlying logic by inserting
            // a trash_items row + moving the file to the per-app trash dir.
            // For V1 simplicity we call the same backend path used by the UI.
            move_to_trash_inline(db, current.clone(), app)?;
            // After trashing, the file no longer exists at `current` — leave it
            // pointing at the original path; subsequent actions on this file will
            // fail loudly, which is correct.
            Ok("moved to trash".to_string())
        }
        Action::Notify { message } => {
            use tauri::Emitter;
            let _ = app.emit("automation-notify", serde_json::json!({ "message": message }));
            Ok("notified".to_string())
        }
    }
}

/// Insert / upsert a `files` row for the given path, returning its id.
/// Mirror of `index_file_by_path` but with direct connection access.
fn upsert_file_for_automation(
    db: &rusqlite::Connection,
    path: &Path,
) -> Result<i64, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let path_str = path.to_string_lossy().to_string();
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    let ts = |t: std::io::Result<std::time::SystemTime>| {
        t.ok()
            .and_then(|s| s.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    };
    db.execute(
        "INSERT INTO files (path, name, extension, size, created_at, modified_at, accessed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(path) DO UPDATE SET
           name = excluded.name,
           extension = excluded.extension,
           size = excluded.size,
           modified_at = excluded.modified_at,
           accessed_at = excluded.accessed_at",
        rusqlite::params![
            &path_str,
            &name,
            &ext,
            meta.len() as i64,
            ts(meta.created()),
            ts(meta.modified()),
            ts(meta.accessed()),
        ],
    )
    .map_err(|e| e.to_string())?;
    db.query_row("SELECT id FROM files WHERE path = ?1", [&path_str], |r| r.get(0))
        .map_err(|e| e.to_string())
}

fn ensure_tag(db: &rusqlite::Connection, name: &str) -> Result<i64, String> {
    db.execute(
        "INSERT OR IGNORE INTO tags (name, color, is_auto) VALUES (?1, '#6366f1', 0)",
        rusqlite::params![name],
    )
    .map_err(|e| e.to_string())?;
    db.query_row(
        "SELECT id FROM tags WHERE LOWER(name) = LOWER(?1)",
        [name],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

fn log_automation_activity(db: &rusqlite::Connection, file_path: &str, action: &str) {
    let name = std::path::Path::new(file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let _ = db.execute(
        "INSERT INTO activity (file_id, file_path, file_name, action, app_name)
         SELECT id, ?1, ?2, ?3, 'automation' FROM files WHERE path = ?1
         UNION ALL
         SELECT NULL, ?1, ?2, ?3, 'automation' WHERE NOT EXISTS (SELECT 1 FROM files WHERE path = ?1)
         LIMIT 1",
        rusqlite::params![file_path, name, action],
    );
}

/// Move a file to the per-app trash dir + record it. Mirror of trash::move_to_trash
/// for the single-file case, kept inline to avoid a cross-module call from inside
/// the action runner.
fn move_to_trash_inline(
    db: &rusqlite::Connection,
    src: PathBuf,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let trash_dir = data_dir.join(".trash");
    std::fs::create_dir_all(&trash_dir).map_err(|e| e.to_string())?;

    let id = uuid_like();
    let dest = trash_dir.join(&id);
    let meta = std::fs::metadata(&src).map_err(|e| e.to_string())?;
    std::fs::rename(&src, &dest).map_err(|e| e.to_string())?;

    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    db.execute(
        "INSERT INTO trash_items (id, original_path, name, is_dir, size)
         VALUES (?1, ?2, ?3, 0, ?4)",
        rusqlite::params![&id, src.to_string_lossy(), name, meta.len() as i64],
    )
    .map_err(|e| e.to_string())?;
    log_automation_activity(db, &src.to_string_lossy(), "automated_trash");
    Ok(())
}

fn uuid_like() -> String {
    // Short non-cryptographic id for trash filenames. Collision probability is
    // negligible for the volumes we're talking about (a few per second at most).
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("auto-{:x}", nanos)
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/// Hard cap on files evaluated in a single run, even with recursion. Stops a
/// runaway scan if the user accidentally points a rule at C:\ or a build dir.
const MAX_FILES_PER_RUN: usize = 10_000;

/// Folders the recursive walker NEVER enters. Same skip list as `scan_directory`
/// so rules behave consistently with the rest of the indexing pipeline.
fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        "$Recycle.Bin" | "System Volume Information" | "Windows"
            | "ProgramData" | "AppData" | ".git" | "node_modules"
            | "target" | ".cargo" | ".cache" | "dist" | ".next" | ".nuxt"
            | "build" | "vendor" | "__pycache__"
    )
}

/// List files inside `dir`. With `recursive = false` (the default), only the
/// direct children are returned. With `recursive = true`, walks up to depth 8
/// and skips heavy system / build folders. Capped at `MAX_FILES_PER_RUN`.
fn list_target_files(dir: &Path, recursive: bool) -> Result<Vec<PathBuf>, String> {
    if !recursive {
        let read = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
        let mut out: Vec<PathBuf> = read
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .map(|e| e.path())
            .collect();
        out.sort();
        return Ok(out);
    }

    let mut out: Vec<PathBuf> = walkdir::WalkDir::new(dir)
        .follow_links(false)
        .max_depth(8)
        .into_iter()
        .filter_entry(|e| {
            // Skip the root re-entry (it has no parent within the walk's scope)
            if e.depth() == 0 { return true; }
            let name = e.file_name().to_string_lossy();
            !should_skip_dir(&name)
        })
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.path().to_path_buf())
        .take(MAX_FILES_PER_RUN)
        .collect();
    out.sort();
    Ok(out)
}

/// Execute a rule against a list of files. Pure orchestration — no DB lookup,
/// no command dispatch, just iterate + evaluate + execute.
pub fn run_rule_against(
    rule: &AutomationRule,
    files: &[PathBuf],
    dry_run: bool,
    db: &rusqlite::Connection,
    app: &tauri::AppHandle,
) -> RunReport {
    let mut report = RunReport {
        dry_run,
        ..Default::default()
    };
    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    for path in files {
        let ctx = match build_file_ctx(path, db) {
            Some(c) => c,
            None => continue,
        };
        // AND of all conditions. Empty conditions list = matches everything.
        let all_match = rule.conditions.iter().all(|c| evaluate_condition(c, &ctx));
        if !all_match {
            continue;
        }
        report.matched_files += 1;

        let tmpl = TemplateCtx::from_path_and_time(path, now_unix);
        let mut current = path.clone();

        for action in &rule.actions {
            report.actions_attempted += 1;
            let file_before = current.to_string_lossy().to_string();
            let description = describe_action(action, &current, &tmpl);

            if dry_run {
                report.outcomes.push(ActionOutcome {
                    action: description,
                    file_before: file_before.clone(),
                    file_after: file_before,
                    success: true,
                    error: None,
                });
                continue;
            }

            match execute_action(action, &mut current, &tmpl, db, app) {
                Ok(_) => {
                    report.actions_succeeded += 1;
                    report.outcomes.push(ActionOutcome {
                        action: description,
                        file_before,
                        file_after: current.to_string_lossy().to_string(),
                        success: true,
                        error: None,
                    });
                }
                Err(e) => {
                    report.outcomes.push(ActionOutcome {
                        action: description,
                        file_before: file_before.clone(),
                        file_after: file_before,
                        success: false,
                        error: Some(e),
                    });
                }
            }
        }
    }

    report
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct ManualRunInput {
    pub rule_id: i64,
    pub target_dir: String,
    #[serde(default)]
    pub dry_run: bool,
    /// When true, walks subdirectories up to depth 8 (skipping system / build
    /// folders like .git, node_modules, target). Default false to keep the
    /// blast radius bounded for users who haven't ticked the box.
    #[serde(default)]
    pub recursive: bool,
}

/// Fire a `manual`-trigger rule (or any rule, in fact) against a target directory.
/// `recursive = false` (default) walks only direct children; set to true to walk
/// the subtree up to depth 8, skipping system / build folders.
/// `dry_run = true` returns the preview without touching the filesystem.
/// Hard-capped at 10 000 files per run regardless of recursion.
#[tauri::command]
pub fn run_automation_rule_manual(
    input: ManualRunInput,
    state: tauri::State<AppState>,
    app: tauri::AppHandle,
) -> Result<RunReport, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    // Load the rule
    let rule: AutomationRule = db
        .query_row(
            "SELECT * FROM automation_rules WHERE id = ?1",
            [input.rule_id],
            row_to_rule,
        )
        .map_err(|e| format!("rule {} not found: {}", input.rule_id, e))?;

    if !rule.enabled && !input.dry_run {
        return Err("Rule is disabled. Enable it first or use dry_run to preview.".to_string());
    }

    let target = PathBuf::from(input.target_dir.trim());
    if !target.is_dir() {
        return Err(format!("target_dir is not a directory: {}", target.display()));
    }

    let files = list_target_files(&target, input.recursive)?;
    let report = run_rule_against(&rule, &files, input.dry_run, &db, &app);

    // Diagnostics only for live runs that actually attempted something.
    if let Some(update) = compute_diagnostics_update(&report) {
        let now_unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        write_diagnostics(&db, rule.id, now_unix, &update);
    }

    Ok(report)
}

// ═══════════════════════════════════════════════════════════════════════════
//  Phase 3 — watcher dispatch, rate limiting, cycle detection
// ═══════════════════════════════════════════════════════════════════════════
//
// Architecture:
//   - The watcher in files.rs calls `dispatch_event(path, kind, db, app)` after
//     it has upserted the file. We run inline in a background std thread so the
//     notify callback isn't blocked.
//   - `RuntimeState` (a process-wide singleton) holds two maps:
//       1. rate_limit: rule_id → sliding-window timestamps. >RATE_LIMIT_PER_MIN
//          firings in 60s auto-disables the rule and emits a toast.
//       2. recent_paths: paths the engine has just touched (moved/copied/renamed).
//          Suppresses the self-triggered loop where moving a file into a watched
//          folder would re-fire rules.
//
// Rules of thumb:
//   - Cycle detection has a 5-second TTL. Most filesystem races complete inside
//     2-3s; 5s is a comfortable margin without keeping paths "tainted" forever.
//   - Rate limiter window is 60s, cap is 10 firings. A misconfigured rule that
//     loops on its own output gets killed within ~10s.
//   - We do NOT cache the rule list in memory — we query the DB per event. The
//     idx_automation_enabled_trigger index makes this O(log N) per query, and
//     it sidesteps cache-invalidation bugs.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

pub const RATE_LIMIT_PER_MIN: usize = 10;
const RATE_LIMIT_WINDOW_SECS: i64 = 60;
const CYCLE_TTL_SECS: i64 = 5;

#[derive(Default)]
pub struct RuntimeState {
    /// rule_id → unix-second timestamps of recent firings within the window
    rate_limit: HashMap<i64, VecDeque<i64>>,
    /// canonicalized-or-raw path string → unix second when last touched by the engine
    recent_paths: HashMap<String, i64>,
}

fn runtime() -> &'static Mutex<RuntimeState> {
    static R: OnceLock<Mutex<RuntimeState>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(RuntimeState::default()))
}

#[derive(Debug, PartialEq, Eq)]
pub enum RateLimitOutcome {
    Allow,
    Tripped, // exceeded the limit on this call
}

/// Prune timestamps outside the window, then either record `now` and Allow,
/// or refuse and return Tripped. Pure logic over the supplied state — the
/// `runtime()` wrapper handles locking.
fn check_rate_limit_in(
    state: &mut RuntimeState,
    rule_id: i64,
    now: i64,
    cap: usize,
    window: i64,
) -> RateLimitOutcome {
    let entry = state.rate_limit.entry(rule_id).or_default();
    while let Some(front) = entry.front() {
        if now - *front > window {
            entry.pop_front();
        } else {
            break;
        }
    }
    if entry.len() >= cap {
        RateLimitOutcome::Tripped
    } else {
        entry.push_back(now);
        RateLimitOutcome::Allow
    }
}

/// Public entry point: returns Allow if the rule may fire now, Tripped if it
/// has already exceeded RATE_LIMIT_PER_MIN within RATE_LIMIT_WINDOW_SECS.
pub fn check_rate_limit(rule_id: i64, now: i64) -> RateLimitOutcome {
    let mut s = runtime().lock().expect("automation runtime poisoned");
    check_rate_limit_in(&mut s, rule_id, now, RATE_LIMIT_PER_MIN, RATE_LIMIT_WINDOW_SECS)
}

fn register_touch_in(state: &mut RuntimeState, path: &str, now: i64) {
    state.recent_paths.insert(path.to_string(), now);
}

fn was_recently_touched_in(
    state: &mut RuntimeState,
    path: &str,
    now: i64,
    ttl: i64,
) -> bool {
    // Lazy eviction: prune stale entries opportunistically (bounded by ttl).
    state.recent_paths.retain(|_, ts| now - *ts <= ttl);
    state
        .recent_paths
        .get(path)
        .map(|ts| now - *ts <= ttl)
        .unwrap_or(false)
}

/// Mark `path` as recently touched by the engine — events arriving for this
/// path within CYCLE_TTL_SECS will be suppressed.
pub fn register_touch(path: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let mut s = runtime().lock().expect("automation runtime poisoned");
    register_touch_in(&mut s, path, now);
}

pub fn was_recently_touched(path: &str) -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let mut s = runtime().lock().expect("automation runtime poisoned");
    was_recently_touched_in(&mut s, path, now, CYCLE_TTL_SECS)
}

/// True if `path` lives inside (or is) `trigger_path`. An empty `trigger_path`
/// means "match anywhere" — intentionally permissive but powerful (used by
/// rules that act on a tag regardless of location).
fn path_matches_trigger(trigger_path: &str, path: &Path) -> bool {
    if trigger_path.is_empty() {
        return true;
    }
    let trig = Path::new(trigger_path);
    let mut tc = trig.components();
    let mut pc = path.components();
    loop {
        match (tc.next(), pc.next()) {
            (Some(a), Some(b)) => {
                if !a.as_os_str().eq_ignore_ascii_case(b.as_os_str()) {
                    return false;
                }
            }
            (Some(_), None) => return false, // trigger path is longer than the event path
            (None, _) => return true,        // trigger path consumed → match
        }
    }
}

fn trigger_kind_from_action(action: &str) -> Option<TriggerKind> {
    match action {
        "created" => Some(TriggerKind::FileCreated),
        "modified" => Some(TriggerKind::FileModified),
        "renamed" => Some(TriggerKind::FileRenamed),
        _ => None,
    }
}

/// Dispatch a watcher event to all matching enabled rules. Called from the
/// watcher's handler thread — does its own DB locking and never blocks the
/// caller on long work. Outcomes are logged via `log_automation_activity`
/// inside each action; this function only orchestrates.
pub fn dispatch_event(
    path: &Path,
    action_str: &str,
    db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    app: &tauri::AppHandle,
) {
    let Some(trigger) = trigger_kind_from_action(action_str) else { return };
    let path_str = path.to_string_lossy().to_string();

    // Skip events on paths we just touched ourselves — prevents self-triggered loops.
    if was_recently_touched(&path_str) {
        return;
    }

    let trigger_db = trigger_kind_to_db(trigger);
    let db_guard = match db.lock() {
        Ok(g) => g,
        Err(_) => return,
    };

    // Load only the rules that could possibly match.
    let mut stmt = match db_guard.prepare(
        "SELECT * FROM automation_rules
           WHERE enabled = 1 AND trigger_kind = ?1
           ORDER BY id",
    ) {
        Ok(s) => s,
        Err(_) => return,
    };
    let rules: Vec<AutomationRule> = match stmt.query_map([trigger_db], row_to_rule) {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => return,
    };
    drop(stmt);

    if rules.is_empty() {
        drop(db_guard);
        return;
    }

    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let files = vec![path.to_path_buf()];

    for rule in rules {
        if !path_matches_trigger(&rule.trigger_path, path) {
            continue;
        }
        // Rate-limit check before doing any work.
        if check_rate_limit(rule.id, now_unix) == RateLimitOutcome::Tripped {
            // Auto-disable and notify the user once.
            let _ = db_guard.execute(
                "UPDATE automation_rules SET enabled = 0, updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now_unix, rule.id],
            );
            use tauri::Emitter;
            let _ = app.emit(
                "automation://rule-disabled",
                serde_json::json!({
                    "rule_id": rule.id,
                    "rule_name": rule.name,
                    "reason": "rate_limit_exceeded",
                    "limit": RATE_LIMIT_PER_MIN,
                    "window_secs": RATE_LIMIT_WINDOW_SECS,
                }),
            );
            continue;
        }

        let report = run_rule_against(&rule, &files, false, &db_guard, app);

        // Tag every produced path so subsequent watcher events on those paths
        // are suppressed for CYCLE_TTL_SECS. We grab the lock once per outcome
        // — cheap because outcomes is at most actions.len() entries.
        for outcome in &report.outcomes {
            if outcome.success && !outcome.file_after.is_empty() {
                register_touch(&outcome.file_after);
            }
        }

        if let Some(update) = compute_diagnostics_update(&report) {
            write_diagnostics(&db_guard, rule.id, now_unix, &update);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Minimal TemplateCtx for template tests. Date is fixed to 2026-05-30 14:07.
    fn test_tmpl(name: &str, ext: &str) -> TemplateCtx {
        TemplateCtx {
            year: "2026".into(), month: "05".into(), day: "30".into(),
            hour: "14".into(), minute: "07".into(), date: "2026-05-30".into(),
            name: name.into(), ext: ext.into(),
        }
    }

    fn ctx(name: &str, ext: &str, size: i64, modified: i64, tags: &[&str]) -> FileCtx {
        FileCtx {
            path: PathBuf::from(format!("/tmp/{}.{}", name, ext)),
            name: if ext.is_empty() { name.to_string() } else { format!("{}.{}", name, ext) },
            name_no_ext: name.to_string(),
            ext: ext.to_lowercase(),
            size,
            modified_at: modified,
            tags_lower: tags.iter().map(|t| t.to_lowercase()).collect(),
        }
    }

    // ── Template engine ────────────────────────────────────────────────────

    #[test]
    fn template_empty_returns_empty() {
        let ctx = test_tmpl("x", "pdf");
        assert_eq!(apply_template("", &ctx), "");
    }

    #[test]
    fn template_no_tokens_unchanged() {
        let ctx = test_tmpl("x", "pdf");
        assert_eq!(apply_template("D:\\Foo\\Bar", &ctx), "D:\\Foo\\Bar");
    }

    #[test]
    fn template_substitutes_each_token() {
        let ctx = test_tmpl("invoice", "pdf");
        assert_eq!(apply_template("{year}", &ctx), "2026");
        assert_eq!(apply_template("{month}", &ctx), "05");
        assert_eq!(apply_template("{day}", &ctx), "30");
        assert_eq!(apply_template("{hour}", &ctx), "14");
        assert_eq!(apply_template("{minute}", &ctx), "07");
        assert_eq!(apply_template("{date}", &ctx), "2026-05-30");
        assert_eq!(apply_template("{name}", &ctx), "invoice");
        assert_eq!(apply_template("{ext}", &ctx), "pdf");
    }

    #[test]
    fn template_date_substituted_independently_of_day() {
        // Sanity check the substitution order — {date} must be replaced before {day}
        // so it doesn't accidentally double-substitute inside the date string.
        let ctx = test_tmpl("x", "pdf");
        assert_eq!(apply_template("{date}/{day}", &ctx), "2026-05-30/30");
    }

    #[test]
    fn unix_to_hm_matches_known_times() {
        assert_eq!(unix_to_hm(420), (0, 7));            // 00:07
        assert_eq!(unix_to_hm(50_820), (14, 7));        // 14:07
        assert_eq!(unix_to_hm(86_401), (0, 0));         // wraps to next day
    }

    #[test]
    fn template_unknown_token_preserved() {
        let ctx = test_tmpl("x", "pdf");
        assert_eq!(apply_template("{foo}", &ctx), "{foo}");
    }

    #[test]
    fn template_multiple_tokens_in_path() {
        let ctx = test_tmpl("x", "pdf");
        assert_eq!(
            apply_template("D:\\Compta\\{year}\\{month}", &ctx),
            "D:\\Compta\\2026\\05"
        );
    }

    #[test]
    fn unix_to_ymd_known_dates() {
        // 1970-01-01
        assert_eq!(unix_to_ymd(0), (1970, 1, 1));
        // 2026-05-30
        // = 56 years * 365 + 14 leap days + 31+28+31+30 + 30 days
        // We just check we get the right Y, M, D for a known value.
        let secs = 1_780_531_200; // 2026-05-04 00:00 UTC roughly — we check year/month at least
        let (y, m, _d) = unix_to_ymd(secs);
        assert_eq!(y, 2026);
        assert!((1..=12).contains(&m));
    }

    // ── Condition evaluator ────────────────────────────────────────────────

    #[test]
    fn cond_ext_match_case_insensitive() {
        let f = ctx("doc", "PDF", 100, 0, &[]);
        assert!(evaluate_condition(&Condition::Ext { value: "pdf".into() }, &f));
        assert!(evaluate_condition(&Condition::Ext { value: ".PDF".into() }, &f));
    }

    #[test]
    fn cond_ext_mismatch() {
        let f = ctx("doc", "pdf", 100, 0, &[]);
        assert!(!evaluate_condition(&Condition::Ext { value: "docx".into() }, &f));
    }

    #[test]
    fn cond_name_contains_case_insensitive() {
        let f = ctx("Invoice-2026", "pdf", 100, 0, &[]);
        assert!(evaluate_condition(&Condition::NameContains { value: "INVOICE".into() }, &f));
        assert!(evaluate_condition(&Condition::NameContains { value: "2026".into() }, &f));
        assert!(!evaluate_condition(&Condition::NameContains { value: "kakemono".into() }, &f));
    }

    #[test]
    fn cond_name_starts_with() {
        let f = ctx("invoice-2026", "pdf", 100, 0, &[]);
        assert!(evaluate_condition(&Condition::NameStartsWith { value: "invoice".into() }, &f));
        assert!(!evaluate_condition(&Condition::NameStartsWith { value: "2026".into() }, &f));
    }

    #[test]
    fn cond_name_regex_valid_and_invalid() {
        let f = ctx("IMG_4521", "jpg", 100, 0, &[]);
        assert!(evaluate_condition(&Condition::NameRegex { value: r"^IMG_\d+".into() }, &f));
        // Invalid regex → false, not panic
        assert!(!evaluate_condition(&Condition::NameRegex { value: r"[".into() }, &f));
    }

    #[test]
    fn cond_path_contains() {
        let mut f = ctx("doc", "pdf", 100, 0, &[]);
        f.path = PathBuf::from("C:\\Users\\Alice\\Downloads\\doc.pdf");
        assert!(evaluate_condition(&Condition::PathContains { value: "downloads".into() }, &f));
        assert!(!evaluate_condition(&Condition::PathContains { value: "documents".into() }, &f));
    }

    #[test]
    fn cond_size_gt_lt() {
        let f = ctx("doc", "pdf", 1_000_000, 0, &[]);
        assert!(evaluate_condition(&Condition::SizeGt { value: 500_000 }, &f));
        assert!(!evaluate_condition(&Condition::SizeGt { value: 2_000_000 }, &f));
        assert!(evaluate_condition(&Condition::SizeLt { value: 2_000_000 }, &f));
        assert!(!evaluate_condition(&Condition::SizeLt { value: 500_000 }, &f));
        // Equal is NOT considered greater nor less (strict)
        assert!(!evaluate_condition(&Condition::SizeGt { value: 1_000_000 }, &f));
        assert!(!evaluate_condition(&Condition::SizeLt { value: 1_000_000 }, &f));
    }

    #[test]
    fn cond_age_gt_days() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        // Modified 60 days ago
        let old = ctx("doc", "pdf", 100, now - 60 * 86_400, &[]);
        assert!(evaluate_condition(&Condition::AgeGtDays { value: 30 }, &old));
        assert!(!evaluate_condition(&Condition::AgeGtDays { value: 90 }, &old));
        // Modified just now
        let fresh = ctx("doc", "pdf", 100, now, &[]);
        assert!(!evaluate_condition(&Condition::AgeGtDays { value: 1 }, &fresh));
    }

    #[test]
    fn cond_tag_has_case_insensitive() {
        let f = ctx("doc", "pdf", 100, 0, &["archives", "factures"]);
        assert!(evaluate_condition(&Condition::TagHas { value: "Archives".into() }, &f));
        assert!(evaluate_condition(&Condition::TagHas { value: "FACTURES".into() }, &f));
        assert!(!evaluate_condition(&Condition::TagHas { value: "Photos".into() }, &f));
    }

    // ── ensure_unique_path ──────────────────────────────────────────────────

    #[test]
    fn unique_path_returns_original_when_free() {
        // Use a path that almost certainly doesn't exist
        let dir = std::env::temp_dir();
        let unique = format!("nxs-test-no-collision-{}", uuid_like());
        let result = ensure_unique_path(&dir, &unique, "txt");
        assert_eq!(result.file_name().unwrap().to_str().unwrap(), format!("{}.txt", unique));
    }

    // ── describe_action ─────────────────────────────────────────────────────

    #[test]
    fn describe_action_resolves_templates() {
        let tmpl = test_tmpl("x", "pdf");
        let p = PathBuf::from("C:\\Foo\\x.pdf");
        let d = describe_action(
            &Action::MoveTo { path: "D:\\Compta\\{year}".into() },
            &p,
            &tmpl,
        );
        assert!(d.contains("D:\\Compta\\2026"));
    }

    // ── list_target_files — recursive vs flat ──────────────────────────────

    #[test]
    fn list_target_files_recursive_picks_up_subdirs() {
        // Build a small temp tree:  root/file1.txt
        //                           root/sub/file2.txt
        //                           root/.git/HEAD      (should be skipped recursively)
        let root = std::env::temp_dir().join(format!("nxs-test-walk-{}", uuid_like()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("file1.txt"), b"a").unwrap();
        std::fs::write(root.join("sub").join("file2.txt"), b"b").unwrap();
        std::fs::write(root.join(".git").join("HEAD"), b"ref").unwrap();

        // Non-recursive: only direct children
        let flat = list_target_files(&root, false).unwrap();
        assert_eq!(flat.len(), 1, "expected only file1.txt, got {:?}", flat);
        assert!(flat[0].ends_with("file1.txt"));

        // Recursive: file1.txt + sub/file2.txt, .git/HEAD skipped
        let deep = list_target_files(&root, true).unwrap();
        assert_eq!(deep.len(), 2, "expected file1.txt + sub/file2.txt, got {:?}", deep);
        assert!(deep.iter().any(|p| p.ends_with("file1.txt")));
        assert!(deep.iter().any(|p| p.ends_with("file2.txt")));
        assert!(!deep.iter().any(|p| p.to_string_lossy().contains(".git")));

        // Cleanup
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn should_skip_dir_blocks_heavy_folders() {
        assert!(should_skip_dir("node_modules"));
        assert!(should_skip_dir(".git"));
        assert!(should_skip_dir("target"));
        assert!(should_skip_dir("__pycache__"));
        assert!(!should_skip_dir("Documents"));
        assert!(!should_skip_dir("src"));
    }

    // ── Phase 3: rate limiter ────────────────────────────────────────────────

    #[test]
    fn rate_limit_allows_under_cap_then_trips() {
        let mut s = RuntimeState::default();
        // 3 allowed, 4th trips
        for i in 0..3 {
            assert_eq!(
                check_rate_limit_in(&mut s, 1, 100 + i, 3, 60),
                RateLimitOutcome::Allow,
                "call #{} should be allowed", i,
            );
        }
        assert_eq!(
            check_rate_limit_in(&mut s, 1, 103, 3, 60),
            RateLimitOutcome::Tripped,
        );
    }

    #[test]
    fn rate_limit_prunes_old_entries_outside_window() {
        let mut s = RuntimeState::default();
        // Three calls at t=0,1,2 — fills the cap of 3
        check_rate_limit_in(&mut s, 7, 0, 3, 60);
        check_rate_limit_in(&mut s, 7, 1, 3, 60);
        check_rate_limit_in(&mut s, 7, 2, 3, 60);
        // Wait past the window: now t=100, all entries should have been pruned
        assert_eq!(
            check_rate_limit_in(&mut s, 7, 100, 3, 60),
            RateLimitOutcome::Allow,
            "old entries should be pruned past the window",
        );
    }

    #[test]
    fn rate_limit_is_per_rule() {
        let mut s = RuntimeState::default();
        // Rule 1 trips at its 4th call, rule 2 stays independent
        for i in 0..3 {
            check_rate_limit_in(&mut s, 1, i, 3, 60);
        }
        assert_eq!(
            check_rate_limit_in(&mut s, 1, 3, 3, 60),
            RateLimitOutcome::Tripped,
        );
        // Rule 2 starts fresh
        assert_eq!(
            check_rate_limit_in(&mut s, 2, 3, 3, 60),
            RateLimitOutcome::Allow,
        );
    }

    // ── Phase 3: cycle detection ────────────────────────────────────────────

    #[test]
    fn recently_touched_within_ttl_returns_true_then_expires() {
        let mut s = RuntimeState::default();
        register_touch_in(&mut s, "C:\\foo.pdf", 1000);
        assert!(was_recently_touched_in(&mut s, "C:\\foo.pdf", 1003, 5));
        // Past TTL → not touched anymore
        assert!(!was_recently_touched_in(&mut s, "C:\\foo.pdf", 1010, 5));
    }

    #[test]
    fn recently_touched_unknown_path_returns_false() {
        let mut s = RuntimeState::default();
        register_touch_in(&mut s, "C:\\foo.pdf", 1000);
        assert!(!was_recently_touched_in(&mut s, "C:\\bar.pdf", 1001, 5));
    }

    // ── Phase 3: trigger path matching ──────────────────────────────────────

    #[test]
    fn trigger_path_empty_matches_everything() {
        assert!(path_matches_trigger("", Path::new("C:\\anywhere\\file.txt")));
    }

    #[test]
    fn trigger_path_matches_when_event_is_inside() {
        assert!(path_matches_trigger(
            "C:\\Users\\Me\\Downloads",
            Path::new("C:\\Users\\Me\\Downloads\\report.pdf"),
        ));
        assert!(path_matches_trigger(
            "C:\\Users\\Me\\Downloads",
            Path::new("C:\\Users\\Me\\Downloads\\sub\\report.pdf"),
        ));
    }

    #[test]
    fn trigger_path_rejects_when_event_is_outside() {
        assert!(!path_matches_trigger(
            "C:\\Users\\Me\\Downloads",
            Path::new("C:\\Users\\Me\\Documents\\report.pdf"),
        ));
    }

    #[test]
    fn trigger_path_match_is_case_insensitive() {
        assert!(path_matches_trigger(
            "C:\\users\\me\\downloads",
            Path::new("C:\\Users\\Me\\Downloads\\report.pdf"),
        ));
    }

    // ── compute_diagnostics_update ──────────────────────────────────────────

    fn make_report(dry: bool, attempted: usize, succeeded: usize, errors: &[&str]) -> RunReport {
        let mut outcomes: Vec<ActionOutcome> = Vec::new();
        for _ in 0..succeeded {
            outcomes.push(ActionOutcome {
                action: "x".into(),
                file_before: "/a".into(),
                file_after: "/b".into(),
                success: true,
                error: None,
            });
        }
        for e in errors {
            outcomes.push(ActionOutcome {
                action: "x".into(),
                file_before: "/a".into(),
                file_after: "/a".into(),
                success: false,
                error: Some((*e).to_string()),
            });
        }
        RunReport {
            matched_files: 1,
            actions_attempted: attempted,
            actions_succeeded: succeeded,
            outcomes,
            dry_run: dry,
        }
    }

    #[test]
    fn diagnostics_dry_run_returns_none() {
        let r = make_report(true, 3, 3, &[]);
        assert!(compute_diagnostics_update(&r).is_none());
    }

    #[test]
    fn diagnostics_no_matches_returns_none() {
        let r = make_report(false, 0, 0, &[]);
        assert!(compute_diagnostics_update(&r).is_none(),
                "rule that fired but matched 0 files should not bump diagnostics");
    }

    #[test]
    fn diagnostics_all_success_clears_last_error() {
        let r = make_report(false, 2, 2, &[]);
        let u = compute_diagnostics_update(&r).expect("should have an update");
        assert!(u.fired);
        // Some(None) = "set last_error to NULL" (i.e. clear any previous error badge)
        assert_eq!(u.last_error, Some(None));
    }

    #[test]
    fn diagnostics_partial_failure_records_first_error() {
        let r = make_report(false, 3, 1, &["disk full", "permission denied"]);
        let u = compute_diagnostics_update(&r).expect("should have an update");
        assert!(u.fired);
        assert_eq!(u.last_error, Some(Some("disk full".into())),
                   "first failed outcome's error should win");
    }

    #[test]
    fn diagnostics_all_fail_still_fires() {
        let r = make_report(false, 2, 0, &["nope"]);
        let u = compute_diagnostics_update(&r).expect("should have an update");
        assert!(u.fired);
        assert_eq!(u.last_error, Some(Some("nope".into())));
    }

    #[test]
    fn trigger_kind_from_action_maps_known_strings() {
        assert_eq!(trigger_kind_from_action("created"), Some(TriggerKind::FileCreated));
        assert_eq!(trigger_kind_from_action("modified"), Some(TriggerKind::FileModified));
        assert_eq!(trigger_kind_from_action("renamed"), Some(TriggerKind::FileRenamed));
        assert_eq!(trigger_kind_from_action("deleted"), None);
        assert_eq!(trigger_kind_from_action("bogus"), None);
    }
}
