/// Opens a new independent app window pre-initialized to a folder or file.
///
/// Init flow:
///   1. Caller invokes `open_new_window` with mode + path params.
///   2. This command stores the params in AppState::window_init keyed by the new window label.
///   3. The new window's React app calls `get_window_init_data(label)` on startup
///      and skips the normal workspace-restore flow.
///
/// TEAR-OUT HOOK (future):
///   When implementing drag-out-of-tab-bar tear-out, the frontend will detect
///   that the mouse has left the window bounds during a tab drag and invoke
///   `open_new_window` with the dragged tab's data, then close the source tab.
///   The command signature is already compatible with that use-case.

#[tauri::command]
pub async fn open_new_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    mode: String,   // "folder" | "file"
    path: String,
    name: Option<String>,
    ext: Option<String>,
) -> Result<(), String> {
    let label = format!(
        "popup_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );

    // Compute title before name is moved into the init-data map
    let window_title = match mode.as_str() {
        "file" => name.as_deref().unwrap_or("Fichier").to_string(),
        _ => std::path::Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&path)
            .to_string(),
    };

    // Store init data so the new window can retrieve it on first render
    {
        let mut map = state.window_init.lock().map_err(|e| e.to_string())?;
        map.insert(label.clone(), serde_json::json!({
            "mode": mode,
            "path": path,
            "name": name,
            "ext": ext,
        }));
    }

    // Popup windows use native OS decorations (no decorations(false)) so the OS
    // provides reliable move / resize / close controls without needing a custom
    // drag region.  The React app hides the custom Titlebar when it detects it is
    // running inside a popup window.
    tauri::WebviewWindowBuilder::new(
        &app,
        label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title(window_title)
    .inner_size(1000.0, 700.0)
    .min_inner_size(500.0, 400.0)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Called by the new window on startup to retrieve its init data.
/// Non-destructive: the entry stays in the map so React Strict Mode's double
/// effect invocation doesn't lose the data on the second call.
#[tauri::command]
pub fn get_window_init_data(
    label: String,
    state: tauri::State<'_, crate::AppState>,
) -> Option<serde_json::Value> {
    state.window_init.lock().ok()?.get(&label).cloned()
}
