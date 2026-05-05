use serde::Serialize;
use tauri::AppHandle;
use tokio::sync::oneshot;

use crate::sharing::{
    client::GuestCmd,
    protocol::GuestMsg,
    SharingState,
};
use crate::models::ListEntry;
use crate::AppState;

#[derive(Serialize)]
pub struct SessionInfo {
    pub code: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct WorkspaceInfo {
    pub name: String,
    pub icon: String,
    pub root_paths: Vec<String>,
}

#[derive(Serialize)]
pub struct SharingStatus {
    pub mode: String,
    pub code: Option<String>,
    pub password: Option<String>,
    pub clients: Option<Vec<String>>,
    pub workspace_name: Option<String>,
    pub root_paths: Option<Vec<String>>,
}

#[tauri::command]
pub async fn start_sharing(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
    workspace_name: String,
    workspace_icon: String,
    watched_paths: Vec<String>,
    context_id: Option<i64>,
) -> Result<SessionInfo, String> {
    {
        let guard = state.sharing.lock().await;
        if !guard.is_idle() {
            return Err("Already in a sharing session".to_string());
        }
    }

    let public_ip = tokio::task::spawn_blocking(crate::sharing::network::discover_public_ip)
        .await
        .map_err(|e| e.to_string())?;

    let password = generate_password();
    let db = state.db.clone();

    let handle = crate::sharing::server::start_server(
        password.clone(),
        workspace_name,
        workspace_icon,
        watched_paths,
        db,
        app,
        context_id.unwrap_or(0),
    )
    .await?;

    let code = format!("{}:{}", public_ip, handle.port);

    let mut guard = state.sharing.lock().await;
    *guard = SharingState::Hosting {
        session_code: code.clone(),
        password: password.clone(),
        handle,
    };

    Ok(SessionInfo { code, password })
}

#[tauri::command]
pub async fn stop_sharing(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.sharing.lock().await;
    if let SharingState::Hosting { handle, .. } =
        std::mem::replace(&mut *guard, SharingState::Idle)
    {
        let _ = handle.shutdown_tx.send(());
    }
    Ok(())
}

#[tauri::command]
pub async fn join_shared_workspace(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
    code: String,
    password: String,
    display_name: String,
) -> Result<WorkspaceInfo, String> {
    {
        let guard = state.sharing.lock().await;
        if !guard.is_idle() {
            return Err("Already in a sharing session".to_string());
        }
    }

    let handle =
        crate::sharing::client::connect(code.clone(), password, display_name, app).await?;

    let info = WorkspaceInfo {
        name: handle.workspace_name.clone(),
        icon: handle.workspace_icon.clone(),
        root_paths: handle.root_paths.clone(),
    };

    let mut guard = state.sharing.lock().await;
    *guard = SharingState::Joined {
        host_addr: code,
        handle,
        next_id: 1,
    };

    Ok(info)
}

#[tauri::command]
pub async fn leave_shared_workspace(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.sharing.lock().await;
    if let SharingState::Joined { handle, .. } =
        std::mem::replace(&mut *guard, SharingState::Idle)
    {
        let _ = handle.disconnect_tx.send(());
    }
    Ok(())
}

#[tauri::command]
pub async fn get_sharing_status(
    state: tauri::State<'_, AppState>,
) -> Result<SharingStatus, String> {
    let guard = state.sharing.lock().await;
    Ok(match &*guard {
        SharingState::Idle => SharingStatus {
            mode: "idle".into(),
            code: None, password: None, clients: None,
            workspace_name: None, root_paths: None,
        },
        SharingState::Hosting { session_code, password, handle } => {
            let clients = handle.clients.lock().unwrap().clone();
            SharingStatus {
                mode: "hosting".into(),
                code: Some(session_code.clone()),
                password: Some(password.clone()),
                clients: Some(clients),
                workspace_name: None, root_paths: None,
            }
        }
        SharingState::Joined { handle, .. } => SharingStatus {
            mode: "joined".into(),
            code: None, password: None, clients: None,
            workspace_name: Some(handle.workspace_name.clone()),
            root_paths: Some(handle.root_paths.clone()),
        },
    })
}

// ─── Remote file operations (guest mode only) ────────────────────────────────

#[tauri::command]
pub async fn list_remote_dir(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<Vec<ListEntry>, String> {
    let (cmd_tx, id) = extract_cmd_tx(&state, "list_remote_dir").await?;
    let val = send_cmd(cmd_tx, GuestMsg::ListDir { id, path }).await?;
    serde_json::from_value(val).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_remote_file(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let (cmd_tx, id) = extract_cmd_tx(&state, "read_remote_file").await?;
    let val = send_cmd(cmd_tx, GuestMsg::ReadFile { id, path }).await?;
    val.as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Unexpected response type".to_string())
}

#[tauri::command]
pub async fn write_remote_file(
    state: tauri::State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), String> {
    let (cmd_tx, id) = extract_cmd_tx(&state, "write_remote_file").await?;
    send_cmd(cmd_tx, GuestMsg::WriteFile { id, path, content }).await?;
    Ok(())
}

#[tauri::command]
pub async fn delete_remote_path(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let (cmd_tx, id) = extract_cmd_tx(&state, "delete_remote_path").await?;
    send_cmd(cmd_tx, GuestMsg::DeletePath { id, path }).await?;
    Ok(())
}

#[tauri::command]
pub async fn rename_remote_path(
    state: tauri::State<'_, AppState>,
    from_path: String,
    to_path: String,
) -> Result<(), String> {
    let (cmd_tx, id) = extract_cmd_tx(&state, "rename_remote_path").await?;
    send_cmd(cmd_tx, GuestMsg::RenamePath { id, from: from_path, to: to_path }).await?;
    Ok(())
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type CmdTx = tokio::sync::mpsc::Sender<GuestCmd>;

async fn extract_cmd_tx(
    state: &tauri::State<'_, AppState>,
    _op: &str,
) -> Result<(CmdTx, u64), String> {
    let mut guard = state.sharing.lock().await;
    match &mut *guard {
        SharingState::Joined { handle, next_id, .. } => {
            let id = *next_id;
            *next_id += 1;
            Ok((handle.cmd_tx.clone(), id))
        }
        _ => Err("Not connected to a shared workspace".to_string()),
    }
}

async fn send_cmd(
    cmd_tx: CmdTx,
    msg: GuestMsg,
) -> Result<serde_json::Value, String> {
    let (reply_tx, reply_rx) = oneshot::channel();
    cmd_tx
        .send(GuestCmd { msg, reply: reply_tx })
        .await
        .map_err(|e| e.to_string())?;
    reply_rx.await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_remote_file(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let (cmd_tx, id) = extract_cmd_tx(&state, "create_remote_file").await?;
    send_cmd(cmd_tx, GuestMsg::CreateFile { id, path }).await?;
    Ok(())
}

#[tauri::command]
pub async fn create_remote_dir(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let (cmd_tx, id) = extract_cmd_tx(&state, "create_remote_dir").await?;
    send_cmd(cmd_tx, GuestMsg::CreateDir { id, path }).await?;
    Ok(())
}

fn generate_password() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0xdeadbeef);
    // xorshift64
    let mut s = seed ^ 0x9e3779b97f4a7c15u64;
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    (0..8)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            CHARS[(s % CHARS.len() as u64) as usize] as char
        })
        .collect()
}
