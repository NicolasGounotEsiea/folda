use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, oneshot};
use tokio_tungstenite::tungstenite::Message;

use super::protocol::{GuestMsg, HostMsg};
use crate::models::ListEntry;

pub struct HostHandle {
    pub port: u16,
    pub shutdown_tx: oneshot::Sender<()>,
    pub event_tx: broadcast::Sender<HostMsg>,
    pub clients: Arc<Mutex<Vec<String>>>,
}

pub async fn start_server(
    password: String,
    workspace_name: String,
    workspace_icon: String,
    root_paths: Vec<String>,
    db: Arc<Mutex<rusqlite::Connection>>,
    app: tauri::AppHandle,
    context_id: i64,
) -> Result<HostHandle, String> {
    let listener = TcpListener::bind("0.0.0.0:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().unwrap().port();

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let (event_tx, _) = broadcast::channel::<HostMsg>(64);
    let event_tx_srv = event_tx.clone();
    let clients = Arc::new(Mutex::new(Vec::<String>::new()));
    let clients_srv = clients.clone();

    let pw = Arc::new(password);
    let wn = Arc::new(workspace_name);
    let wi = Arc::new(workspace_icon);
    let rp = Arc::new(root_paths);
    let ctx_id = context_id;

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => break,
                res = listener.accept() => {
                    match res {
                        Ok((stream, addr)) => {
                            let addr_str = addr.to_string();
                            let ctx = ClientCtx {
                                password: pw.clone(),
                                workspace_name: wn.clone(),
                                workspace_icon: wi.clone(),
                                root_paths: rp.clone(),
                                db: db.clone(),
                                event_tx: event_tx_srv.clone(),
                                clients: clients_srv.clone(),
                                app: app.clone(),
                                context_id: ctx_id,
                            };
                            let _ = addr_str;
                            tokio::spawn(async move {
                                let _ = handle_client(stream, ctx).await;
                            });
                        }
                        Err(_) => break,
                    }
                }
            }
        }
    });

    Ok(HostHandle { port, shutdown_tx, event_tx, clients })
}

/// Broadcast a filesystem event to all connected guests.
pub fn broadcast_fs_event(event_tx: &broadcast::Sender<HostMsg>, kind: &str, path: &str) {
    let _ = event_tx.send(HostMsg::FsEvent {
        kind: kind.to_string(),
        path: path.to_string(),
    });
}

struct ClientCtx {
    password: Arc<String>,
    workspace_name: Arc<String>,
    workspace_icon: Arc<String>,
    root_paths: Arc<Vec<String>>,
    db: Arc<Mutex<rusqlite::Connection>>,
    event_tx: broadcast::Sender<HostMsg>,
    clients: Arc<Mutex<Vec<String>>>,
    app: tauri::AppHandle,
    context_id: i64,
}

async fn handle_client(
    stream: tokio::net::TcpStream,
    ctx: ClientCtx,
) -> anyhow::Result<()> {
    let ClientCtx { password, workspace_name, workspace_icon, root_paths, db, event_tx, clients, app, context_id } = ctx;
    use tauri::Emitter;

    let ws = tokio_tungstenite::accept_async(stream).await?;
    let (mut sink, mut source) = ws.split();

    // First message must be Auth
    let display_name = match source.next().await {
        Some(Ok(Message::Text(txt))) => {
            match serde_json::from_str::<GuestMsg>(&txt)? {
                GuestMsg::Auth { password: pw, display_name } => {
                    if pw == *password {
                        let ok = HostMsg::AuthOk {
                            name: workspace_name.as_ref().clone(),
                            icon: workspace_icon.as_ref().clone(),
                            root_paths: root_paths.as_ref().clone(),
                        };
                        sink.send(Message::Text(serde_json::to_string(&ok)?)).await?;
                        display_name
                    } else {
                        let err = HostMsg::AuthErr { reason: "Wrong password".to_string() };
                        sink.send(Message::Text(serde_json::to_string(&err)?)).await?;
                        return Ok(());
                    }
                }
                _ => return Ok(()),
            }
        }
        _ => return Ok(()),
    };

    clients.lock().unwrap().push(display_name.clone());
    let _ = app.emit("sharing://client-joined", serde_json::json!({ "name": display_name }));
    let _ = event_tx.send(HostMsg::ClientJoined { name: display_name.clone() });

    let mut ev_rx = event_tx.subscribe();

    loop {
        tokio::select! {
            msg = source.next() => {
                match msg {
                    Some(Ok(Message::Text(txt))) => {
                        match serde_json::from_str::<GuestMsg>(&txt) {
                            Ok(guest_msg) => {
                                let rp = root_paths.clone();
                                let db2 = db.clone();
                                let response = handle_cmd(guest_msg, rp, db2, context_id).await;
                                let out = serde_json::to_string(&response)?;
                                if sink.send(Message::Text(out)).await.is_err() { break; }
                            }
                            Err(_) => continue,
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
            Ok(ev) = ev_rx.recv() => {
                let out = serde_json::to_string(&ev)?;
                if sink.send(Message::Text(out)).await.is_err() { break; }
            }
        }
    }

    clients.lock().unwrap().retain(|n| n != &display_name);
    let _ = event_tx.send(HostMsg::ClientLeft { name: display_name.clone() });
    let _ = app.emit("sharing://client-left", serde_json::json!({ "name": display_name }));

    Ok(())
}

fn path_allowed(path: &str, roots: &[String]) -> bool {
    let norm = path.replace('\\', "/");
    roots.iter().any(|r| norm.starts_with(&r.replace('\\', "/")))
}

/// Permission flags resolved for a given path via longest-prefix match.
#[derive(Clone, Copy)]
struct Perms {
    can_list:   bool,
    can_read:   bool,
    can_create: bool,
    can_update: bool,
    can_delete: bool,
}

impl Perms {
    fn allow_all() -> Self {
        Self { can_list: true, can_read: true, can_create: true, can_update: true, can_delete: true }
    }
}

/// Resolve the effective permission set for a path within a given context.
/// Uses longest-prefix match: workspace default (empty path) < folder < file.
fn resolve_perms(db: &rusqlite::Connection, context_id: i64, path: &str) -> Perms {
    let norm = path.replace('\\', "/");

    // Fetch all rules for this context ordered shortest path first (default first).
    let mut stmt = match db.prepare(
        "SELECT path, can_list, can_read, can_create, can_update, can_delete
         FROM share_permissions WHERE context_id = ?1
         ORDER BY length(path) ASC",
    ) {
        Ok(s) => s,
        Err(_) => return Perms::allow_all(),
    };

    let mapped = stmt.query_map([context_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)? != 0,
            row.get::<_, i64>(2)? != 0,
            row.get::<_, i64>(3)? != 0,
            row.get::<_, i64>(4)? != 0,
            row.get::<_, i64>(5)? != 0,
        ))
    });

    let rules: Vec<(String, bool, bool, bool, bool, bool)> = match mapped {
        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
        Err(_) => return Perms::allow_all(),
    };

    if rules.is_empty() {
        return Perms::allow_all();
    }

    // Start from workspace default, then apply more-specific matches.
    let mut result = Perms::allow_all();
    for (rule_path, cl, cr, cc, cu, cd) in &rules {
        let norm_rule = rule_path.replace('\\', "/");
        let matches = if norm_rule.is_empty() {
            true // workspace default
        } else {
            norm == norm_rule || norm.starts_with(&format!("{}/", norm_rule))
        };
        if matches {
            result = Perms { can_list: *cl, can_read: *cr, can_create: *cc, can_update: *cu, can_delete: *cd };
        }
    }
    result
}

async fn handle_cmd(
    msg: GuestMsg,
    root_paths: Arc<Vec<String>>,
    db: Arc<Mutex<rusqlite::Connection>>,
    context_id: i64,
) -> HostMsg {
    macro_rules! denied {
        ($id:expr) => {
            return HostMsg::Response {
                id: $id,
                ok: false,
                payload: serde_json::json!("Access denied"),
            }
        };
    }
    macro_rules! ok_null {
        ($id:expr) => {
            HostMsg::Response { id: $id, ok: true, payload: serde_json::Value::Null }
        };
    }

    match msg {
        GuestMsg::ListDir { id, path } => {
            if !path_allowed(&path, &root_paths) { denied!(id); }
            {
                let db_g = db.lock().unwrap();
                let p = resolve_perms(&db_g, context_id, &path);
                if !p.can_list { denied!(id); }
            }
            match tokio::task::spawn_blocking(move || list_dir_sync(&path)).await {
                Ok(Ok(entries)) => HostMsg::Response {
                    id, ok: true,
                    payload: serde_json::to_value(entries).unwrap_or_default(),
                },
                Ok(Err(e)) => HostMsg::Response { id, ok: false, payload: serde_json::json!(e) },
                Err(e) => HostMsg::Response { id, ok: false, payload: serde_json::json!(e.to_string()) },
            }
        }
        GuestMsg::ReadFile { id, path } => {
            if !path_allowed(&path, &root_paths) { denied!(id); }
            {
                let db_g = db.lock().unwrap();
                let p = resolve_perms(&db_g, context_id, &path);
                if !p.can_read { denied!(id); }
            }
            match tokio::task::spawn_blocking(move || -> Result<String, String> {
                let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
                if meta.len() > 10 * 1024 * 1024 {
                    return Err("File too large (>10 MB)".to_string());
                }
                std::fs::read_to_string(&path).map_err(|e| e.to_string())
            }).await {
                Ok(Ok(content)) => HostMsg::Response { id, ok: true, payload: serde_json::json!(content) },
                Ok(Err(e)) => HostMsg::Response { id, ok: false, payload: serde_json::json!(e) },
                Err(e) => HostMsg::Response { id, ok: false, payload: serde_json::json!(e.to_string()) },
            }
        }
        GuestMsg::WriteFile { id, path, content } => {
            if !path_allowed(&path, &root_paths) { denied!(id); }
            {
                let db_g = db.lock().unwrap();
                let p = resolve_perms(&db_g, context_id, &path);
                if !p.can_update { denied!(id); }
            }
            match tokio::task::spawn_blocking(move || {
                std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
            }).await {
                Ok(Ok(())) => ok_null!(id),
                Ok(Err(e)) => HostMsg::Response { id, ok: false, payload: serde_json::json!(e) },
                Err(e) => HostMsg::Response { id, ok: false, payload: serde_json::json!(e.to_string()) },
            }
        }
        GuestMsg::DeletePath { id, path } => {
            if !path_allowed(&path, &root_paths) { denied!(id); }
            {
                let db_g = db.lock().unwrap();
                let p = resolve_perms(&db_g, context_id, &path);
                if !p.can_delete { denied!(id); }
            }
            match tokio::task::spawn_blocking(move || -> Result<(), String> {
                let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
                if meta.is_dir() {
                    std::fs::remove_dir_all(&path).map_err(|e| e.to_string())
                } else {
                    std::fs::remove_file(&path).map_err(|e| e.to_string())
                }
            }).await {
                Ok(Ok(())) => ok_null!(id),
                Ok(Err(e)) => HostMsg::Response { id, ok: false, payload: serde_json::json!(e) },
                Err(e) => HostMsg::Response { id, ok: false, payload: serde_json::json!(e.to_string()) },
            }
        }
        GuestMsg::RenamePath { id, from, to } => {
            if !path_allowed(&from, &root_paths) { denied!(id); }
            {
                let db_g = db.lock().unwrap();
                let p = resolve_perms(&db_g, context_id, &from);
                if !p.can_update { denied!(id); }
            }
            match tokio::task::spawn_blocking(move || {
                std::fs::rename(&from, &to).map_err(|e| e.to_string())
            }).await {
                Ok(Ok(())) => ok_null!(id),
                Ok(Err(e)) => HostMsg::Response { id, ok: false, payload: serde_json::json!(e) },
                Err(e) => HostMsg::Response { id, ok: false, payload: serde_json::json!(e.to_string()) },
            }
        }
        GuestMsg::CreateFile { id, path } => {
            if !path_allowed(&path, &root_paths) { denied!(id); }
            {
                let db_g = db.lock().unwrap();
                let p = resolve_perms(&db_g, context_id, &path);
                if !p.can_create { denied!(id); }
            }
            match tokio::task::spawn_blocking(move || {
                std::fs::File::create(&path).map(|_| ()).map_err(|e| e.to_string())
            }).await {
                Ok(Ok(())) => ok_null!(id),
                Ok(Err(e)) => HostMsg::Response { id, ok: false, payload: serde_json::json!(e) },
                Err(e) => HostMsg::Response { id, ok: false, payload: serde_json::json!(e.to_string()) },
            }
        }
        GuestMsg::CreateDir { id, path } => {
            if !path_allowed(&path, &root_paths) { denied!(id); }
            {
                let db_g = db.lock().unwrap();
                let p = resolve_perms(&db_g, context_id, &path);
                if !p.can_create { denied!(id); }
            }
            match tokio::task::spawn_blocking(move || {
                std::fs::create_dir_all(&path).map_err(|e| e.to_string())
            }).await {
                Ok(Ok(())) => ok_null!(id),
                Ok(Err(e)) => HostMsg::Response { id, ok: false, payload: serde_json::json!(e) },
                Err(e) => HostMsg::Response { id, ok: false, payload: serde_json::json!(e.to_string()) },
            }
        }
        GuestMsg::Auth { .. } => HostMsg::Response {
            id: 0, ok: false, payload: serde_json::json!("Already authenticated"),
        },
    }
}

fn list_dir_sync(path: &str) -> Result<Vec<ListEntry>, String> {
    let read = std::fs::read_dir(path).map_err(|e| e.to_string())?;

    let mut entries: Vec<ListEntry> = read
        .filter_map(|e| e.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let file_type = entry.file_type().ok()?;
            let meta = entry.metadata().ok()?;
            let entry_path = entry.path().to_string_lossy().to_string();
            let modified_at = meta
                .modified()
                .ok()
                .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64)
                .unwrap_or(0);

            if file_type.is_dir() {
                Some(ListEntry {
                    is_dir: true, name, path: entry_path,
                    size: 0, modified_at, extension: String::new(),
                    id: None, tags: vec![],
                })
            } else {
                let extension = std::path::Path::new(&entry_path)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_string();
                Some(ListEntry {
                    is_dir: false, name, path: entry_path,
                    size: meta.len() as i64, modified_at, extension,
                    id: None, tags: vec![],
                })
            }
        })
        .collect();

    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}
