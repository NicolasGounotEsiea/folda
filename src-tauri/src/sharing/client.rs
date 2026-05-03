use std::collections::HashMap;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

use super::protocol::{GuestMsg, HostMsg};

pub struct GuestCmd {
    pub msg: GuestMsg,
    pub reply: oneshot::Sender<Result<serde_json::Value, String>>,
}

pub struct GuestHandle {
    pub workspace_name: String,
    pub workspace_icon: String,
    pub root_paths: Vec<String>,
    pub cmd_tx: mpsc::Sender<GuestCmd>,
    pub disconnect_tx: oneshot::Sender<()>,
}

pub async fn connect(
    host_addr: String,
    password: String,
    display_name: String,
    app: tauri::AppHandle,
) -> Result<GuestHandle, String> {
    use tauri::Emitter;

    let url = format!("ws://{}", host_addr);
    let (ws_stream, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| format!("Cannot connect to host: {}", e))?;

    let (mut sink, mut source) = ws_stream.split();

    // Authenticate
    let auth = GuestMsg::Auth { password, display_name };
    sink.send(Message::Text(serde_json::to_string(&auth).unwrap()))
        .await
        .map_err(|e| e.to_string())?;

    // Wait for auth response (with 10 s timeout)
    let auth_result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        source.next(),
    )
    .await
    .map_err(|_| "Timed out waiting for auth response".to_string())?;

    let (workspace_name, workspace_icon, root_paths) = match auth_result {
        Some(Ok(Message::Text(txt))) => {
            match serde_json::from_str::<HostMsg>(&txt).map_err(|e| e.to_string())? {
                HostMsg::AuthOk { name, icon, root_paths } => (name, icon, root_paths),
                HostMsg::AuthErr { reason } => return Err(reason),
                _ => return Err("Unexpected message from host".to_string()),
            }
        }
        _ => return Err("Connection closed before auth response".to_string()),
    };

    let (cmd_tx, mut cmd_rx) = mpsc::channel::<GuestCmd>(32);
    let (disconnect_tx, mut disconnect_rx) = oneshot::channel::<()>();

    let app_clone = app.clone();
    tokio::spawn(async move {
        let mut pending: HashMap<u64, oneshot::Sender<Result<serde_json::Value, String>>> =
            HashMap::new();

        loop {
            tokio::select! {
                _ = &mut disconnect_rx => break,

                cmd = cmd_rx.recv() => {
                    match cmd {
                        Some(GuestCmd { msg, reply }) => {
                            let id = msg_id(&msg);
                            match serde_json::to_string(&msg) {
                                Ok(txt) => {
                                    if sink.send(Message::Text(txt)).await.is_err() {
                                        let _ = reply.send(Err("Connection lost".to_string()));
                                        break;
                                    }
                                    if id != 0 {
                                        pending.insert(id, reply);
                                    }
                                }
                                Err(e) => { let _ = reply.send(Err(e.to_string())); }
                            }
                        }
                        None => break,
                    }
                }

                msg = source.next() => {
                    match msg {
                        Some(Ok(Message::Text(txt))) => {
                            if let Ok(host_msg) = serde_json::from_str::<HostMsg>(&txt) {
                                match host_msg {
                                    HostMsg::Response { id, ok, payload } => {
                                        if let Some(tx) = pending.remove(&id) {
                                            let _ = tx.send(if ok { Ok(payload) } else {
                                                Err(payload.as_str().unwrap_or("Error").to_string())
                                            });
                                        }
                                    }
                                    HostMsg::FsEvent { kind, path } => {
                                        let _ = app_clone.emit(
                                            "sharing://fs-event",
                                            serde_json::json!({ "kind": kind, "path": path }),
                                        );
                                    }
                                    HostMsg::ClientJoined { name } => {
                                        let _ = app_clone.emit(
                                            "sharing://client-joined",
                                            serde_json::json!({ "name": name }),
                                        );
                                    }
                                    HostMsg::ClientLeft { name } => {
                                        let _ = app_clone.emit(
                                            "sharing://client-left",
                                            serde_json::json!({ "name": name }),
                                        );
                                    }
                                    _ => {}
                                }
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => break,
                        _ => {}
                    }
                }
            }
        }

        // Drain pending requests with error
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err("Disconnected from host".to_string()));
        }
        let _ = app_clone.emit("sharing://disconnected", serde_json::Value::Null);
    });

    Ok(GuestHandle { workspace_name, workspace_icon, root_paths, cmd_tx, disconnect_tx })
}

fn msg_id(msg: &GuestMsg) -> u64 {
    match msg {
        GuestMsg::ListDir { id, .. }
        | GuestMsg::ReadFile { id, .. }
        | GuestMsg::WriteFile { id, .. }
        | GuestMsg::DeletePath { id, .. }
        | GuestMsg::RenamePath { id, .. }
        | GuestMsg::CreateFile { id, .. }
        | GuestMsg::CreateDir { id, .. } => *id,
        GuestMsg::Auth { .. } => 0,
    }
}
