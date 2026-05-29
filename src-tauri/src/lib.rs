use std::sync::{Arc, Mutex};
use tauri::Manager;

mod commands;
mod db;
pub mod models;
pub mod sharing;

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
        default_hook(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_quiet_panic_hook();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("contextual.db");
            let conn = db::init(&db_path).expect("Failed to initialize database");
            app.manage(AppState {
                db: Arc::new(Mutex::new(conn)),
                sharing: tokio::sync::Mutex::new(sharing::SharingState::Idle),
                window_init: Mutex::new(std::collections::HashMap::new()),
            });
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
            commands::files::copy_with_progress,
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
            commands::fs_ops::rename_path,
            commands::fs_ops::delete_path,
            commands::fs_ops::copy_path,
            commands::fs_ops::move_path,
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
            commands::memory::add_ai_memory,
            commands::memory::delete_ai_memory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
