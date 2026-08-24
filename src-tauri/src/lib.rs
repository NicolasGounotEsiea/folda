use std::sync::{Arc, Mutex};
use tauri::Manager;

mod commands;
mod db;
pub mod models;
pub mod sharing;
/// Encrypted vaults — password-protected folders. Phase 1: the crypto + on-disk
/// format only. Compiled in, fully unit-tested, but NOT yet wired to any Tauri
/// command, so it cannot affect existing behaviour. See CLAUDE.md §43.
pub mod vault;

pub struct AppState {
    pub db: Arc<Mutex<rusqlite::Connection>>,
    pub sharing: tokio::sync::Mutex<sharing::SharingState>,
    /// Pending init data for new popup windows, keyed by window label.
    /// Written by `open_new_window`, consumed (removed) by `get_window_init_data`.
    pub window_init: Mutex<std::collections::HashMap<String, serde_json::Value>>,
}

/// Install a custom panic hook that silently swallows panics originating from
/// pdf-extract / lopdf / adobe-cmap-parser. These libraries panic on malformed
/// PDFs (CMap parse errors, missing object references) — we already catch the
/// unwind in extract_pdf(), but the default hook still prints the panic banner
/// to stderr, which floods the console during bulk indexing.
fn install_quiet_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let loc = info.location().map(|l| l.file()).unwrap_or("");
        if loc.contains("pdf-extract")
            || loc.contains("lopdf")
            || loc.contains("adobe-cmap-parser")
            || loc.contains("type1-encoding-parser")
        {
            return; // silently swallow
        }
        // Buffer the panic for crash telemetry (no-op unless the user opted in).
        // Best-effort + synchronous — the process may be unwinding to death, so
        // we only append to a local file; the next launch flushes it.
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".to_string());
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_default();
        commands::telemetry::buffer_panic(&message, &location);

        default_hook(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_quiet_panic_hook();
    tauri::Builder::default()
        // tauri-plugin-single-instance MUST be registered before any other plugin
        // so that the duplicate-launch detection happens before the rest of the
        // builder runs. The callback fires in the EXISTING instance whenever a
        // second nxs.exe is launched; the new process exits cleanly.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            use tauri::{Emitter, Manager};
            // Pop the main window to the foreground.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            // If the second-launch argv contains a path, forward it to the frontend.
            // The parser now also returns intent (Reveal | Open) so the frontend can
            // distinguish "navigate to parent" from "open the file in nxs's viewer".
            if let Some((raw, intent)) = commands::winintegration::parse_launch_path_from_args(&args) {
                let payload = commands::winintegration::classify_launch_path(raw, intent);
                let _ = app.emit("shell-launch", payload);
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        // Auto-updater. Endpoint + public key are declared in
        // `tauri.conf.json`. Frontend drives the check / download / install
        // via @tauri-apps/plugin-updater. `process` plugin gives the JS side
        // a `relaunch()` after the installer completes.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("contextual.db");
            let conn = db::init(&db_path).expect("Failed to initialize database");

            // Move any pre-existing cleartext Anthropic key out of the DB and
            // into the OS credential store. Safe to run on every launch: it's a
            // no-op once migrated, and it never drops the cleartext copy unless
            // the credential store accepted the key first. See commands/apikey.rs.
            commands::apikey::migrate_cleartext_key(&conn);
            app.manage(AppState {
                db: Arc::new(Mutex::new(conn)),
                sharing: tokio::sync::Mutex::new(sharing::SharingState::Idle),
                window_init: Mutex::new(std::collections::HashMap::new()),
            });

            // Self-heal shell-extension registration in case the user updated nxs
            // and the registry still points at the old exe. No-op if the user
            // never opted in. Best-effort; runs in a background thread to avoid
            // delaying startup if the registry is slow.
            std::thread::spawn(|| {
                commands::winintegration::self_heal_registration();
            });

            // ── Vaults ──────────────────────────────────────────────────────
            // Delete decrypted temp files left behind by a previous run. If nxs
            // was killed (crash, Task Manager, power cut) while a vault was
            // unlocked, the lock path never ran and plaintext is still sitting
            // on disk. Without this sweep it would stay there forever — a
            // silent, permanent leak that defeats the feature. Runs FIRST,
            // before anything can hand out new temp files.
            vault::state::purge_orphaned_temp_files();

            // Idle auto-lock. The closure re-reads the timeout from settings on
            // every tick, so changing it in Settings takes effect immediately
            // without a restart.
            {
                let handle = app.handle().clone();
                let state_handle = app.handle().clone();
                vault::state::spawn_idle_locker(handle, move || {
                    use tauri::Manager;
                    commands::vault::idle_lock_secs(&state_handle.state::<AppState>())
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::files::scan_directory,
            commands::files::list_directory,
            commands::files::get_files,
            commands::files::get_file_tags,
            commands::files::get_file_preview,
            commands::files::read_file_full,
            commands::files::write_file,
            commands::files::record_activity,
            commands::files::watch_directory,
            commands::files::get_home_dir,
            commands::files::index_file_by_path,
            commands::files::get_file_snippets,
            commands::files::preview_file,
            commands::files::index_directory_content,
            commands::files::get_indexing_stats,
            commands::files::diff_files,
            commands::files::get_text_lines,
            commands::folders::create_directory,
            commands::folders::get_folder_tags,
            commands::folders::add_tag_to_folder,
            commands::folders::remove_tag_from_folder,
            commands::folders::promote_folder_tag_to_global,
            commands::tags::get_tags,
            commands::tags::create_tag,
            commands::tags::update_tag,
            commands::tags::delete_tag,
            commands::tags::get_tag_stats,
            commands::tags::add_tag_to_file,
            commands::tags::remove_tag_from_file,
            commands::tags::promote_file_tag_to_global,
            commands::tags::get_tag_rules,
            commands::tags::create_tag_rule,
            commands::tags::delete_tag_rule,
            commands::tags::apply_tag_rules,
            commands::tags::get_saved_views,
            commands::tags::create_saved_view,
            commands::tags::delete_saved_view,
            commands::search::search_files,
            commands::search::search_folders,
            commands::search::search_live,
            commands::search::search_semantic,
            commands::search::find_similar_files,
            commands::fs_ops::rename_path,
            commands::fs_ops::delete_path,
            commands::fs_ops::copy_path,
            commands::fs_ops::move_path,
            commands::fs_ops::cancel_transfer,
            commands::fs_ops::create_file,
            commands::fs_ops::duplicate_file,
            commands::fs_ops::open_with_default,
            commands::fs_ops::reveal_in_explorer,
            commands::context::get_last_path,
            commands::context::get_watched_paths,
            commands::context::get_contexts,
            commands::context::create_context,
            commands::context::set_active_context,
            commands::context::update_context,
            commands::context::delete_context,
            commands::context::get_timeline,
            commands::context::get_file_activity,
            commands::snapshots::create_snapshot,
            commands::snapshots::get_snapshots,
            commands::snapshots::restore_snapshot,
            commands::snapshots::delete_snapshot,
            commands::snapshots::get_snapshot_content,
            commands::permissions::get_share_permissions,
            commands::permissions::set_share_permission,
            commands::permissions::delete_share_permission,
            commands::pinned::get_pinned_items,
            commands::pinned::pin_item,
            commands::pinned::unpin_item,
            commands::pinned::promote_pin_to_global,
            commands::stats::get_folder_stats,
            commands::stats::get_folder_sizes,
            commands::settings::get_all_settings,
            commands::settings::set_setting,
            // Anthropic API key — stored in the OS credential store, never the DB
            commands::apikey::set_api_key,
            commands::apikey::get_api_key,
            commands::apikey::clear_api_key,
            commands::settings::purge_old_activity,
            commands::archive::list_archive,
            commands::archive::extract_archive,
            commands::archive::create_zip,
            commands::trash::move_to_trash,
            commands::trash::list_trash,
            commands::trash::restore_from_trash,
            commands::trash::delete_permanently,
            commands::trash::empty_trash,
            commands::windowing::open_new_window,
            commands::windowing::get_window_init_data,
            commands::winintegration::register_shell_extension,
            commands::winintegration::unregister_shell_extension,
            commands::winintegration::is_shell_extension_registered,
            commands::winintegration::get_launch_path,
            commands::log::write_log,
            commands::log::get_log_path,
            commands::log::clear_log,
            // Sharing
            commands::sharing::start_sharing,
            commands::sharing::stop_sharing,
            commands::sharing::join_shared_workspace,
            commands::sharing::leave_shared_workspace,
            commands::sharing::get_sharing_status,
            commands::sharing::list_remote_dir,
            commands::sharing::read_remote_file,
            commands::sharing::write_remote_file,
            commands::sharing::delete_remote_path,
            commands::sharing::rename_remote_path,
            commands::sharing::create_remote_file,
            commands::sharing::create_remote_dir,
            // AI memory
            commands::memory::get_ai_memories,
            commands::memory::count_ai_memories,
            commands::memory::add_ai_memory,
            commands::memory::delete_ai_memory,
            // AI composite tools
            commands::ai_ops::tag_files_matching,
            commands::ai_ops::find_duplicates,
            commands::ai_ops::find_unused,
            // Workspace notes
            commands::notes::get_workspace_note,
            commands::notes::save_workspace_note,
            // Automation rules
            commands::automation::get_automation_rules,
            commands::automation::get_automation_rule,
            commands::automation::create_automation_rule,
            commands::automation::update_automation_rule,
            commands::automation::delete_automation_rule,
            commands::automation::toggle_automation_rule,
            commands::automation::run_automation_rule_manual,
            // Git integration (read-only — opt-in via Settings)
            commands::git::git_get_repo_root,
            commands::git::git_clear_detection_cache,
            commands::git::git_get_repo_status,
            commands::git::git_get_branches,
            commands::git::git_get_recent_commits,
            commands::git::git_get_file_diff,
            commands::git::git_get_commit_diff,
            commands::git::git_get_file_history,
            commands::git::git_checkout_branch,
            // OCR (Tesseract) — status probe + one-click language pack download
            commands::ocr::detect_tesseract,
            commands::ocr::download_ocr_langs,
            // Crash telemetry (self-owned, opt-in)
            commands::telemetry::set_crash_reporting_enabled,
            commands::telemetry::submit_crash_report,
            commands::telemetry::flush_pending_crash_reports,
            // Encrypted vaults — see CLAUDE.md §43
            commands::vault::vault_is_vault,
            commands::vault::vault_is_unlocked,
            commands::vault::vault_path_is_protected,
            commands::vault::vault_unlocked_list,
            commands::vault::vault_create,
            commands::vault::vault_unlock,
            commands::vault::vault_unlock_with_recovery,
            commands::vault::vault_lock,
            commands::vault::vault_lock_all,
            commands::vault::vault_change_password,
            commands::vault::vault_reset_password,
            commands::vault::vault_list,
            commands::vault::vault_extract_file,
            commands::vault::vault_drag_prepare,
            commands::vault::vault_read_file,
            commands::vault::vault_write_file,
            commands::vault::vault_temp_target,
            commands::vault::vault_write_back,
            commands::vault::vault_add_file,
            commands::vault::vault_delete_file,
            commands::vault::vault_delete_folder,
            commands::vault::vault_rename,
            commands::vault::vault_encrypt_existing,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
