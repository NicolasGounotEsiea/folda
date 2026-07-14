use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, oneshot};
use tokio::time;
use tokio_tungstenite::tungstenite::Message;

use super::crypto::{derive_psk, noise_params};
use super::frame::{encrypt_chunks, ChunkReader};
use super::protocol::{GuestMsg, HostMsg};
use crate::models::ListEntry;

/// Per-IP brute-force protection. After `MAX_FAILURES` failed handshake
/// attempts from the same IP within `WINDOW`, the IP is locked out for
/// `LOCKOUT_DURATION`. Successful handshakes clear the counter.
///
/// `MAX_FAILURES = 3` because the share password is auto-generated (20 chars
/// from a 32-char alphabet, ~100 bits of entropy) — there's no legitimate
/// reason for a user to mistype it more than a couple of times. Anyone
/// reaching 3 misses in a row is brute-forcing, full stop.
const MAX_FAILURES: u32 = 3;
const LOCKOUT_DURATION: Duration = Duration::from_secs(10 * 60);

struct FailureRecord {
    count: u32,
    locked_until: Option<Instant>,
}

type FailureMap = Arc<Mutex<HashMap<IpAddr, FailureRecord>>>;

/// Check whether `ip` is currently locked out. Side effect: prunes a record
/// whose lockout has expired so we don't carry it forever.
fn is_locked_out(map: &FailureMap, ip: Option<IpAddr>) -> bool {
    let Some(ip) = ip else { return false };
    let mut guard = map.lock().unwrap();
    if let Some(rec) = guard.get(&ip) {
        if let Some(until) = rec.locked_until {
            if Instant::now() < until {
                return true;
            }
        }
    }
    // Either no record, or the lockout window has passed — clean up.
    if let Some(rec) = guard.get(&ip) {
        if rec.locked_until.map(|t| Instant::now() >= t).unwrap_or(false) {
            guard.remove(&ip);
        }
    }
    false
}

/// Record a failed handshake. Promotes the record to `locked_until` once the
/// counter crosses `MAX_FAILURES`.
fn record_failure(map: &FailureMap, ip: Option<IpAddr>) {
    let Some(ip) = ip else { return };
    let mut guard = map.lock().unwrap();
    let rec = guard.entry(ip).or_insert(FailureRecord { count: 0, locked_until: None });
    rec.count += 1;
    if rec.count >= MAX_FAILURES {
        rec.locked_until = Some(Instant::now() + LOCKOUT_DURATION);
    }
}

/// Clear the failure record after a successful handshake — the IP has proven
/// it knows the password, no need to keep counting.
fn clear_failures(map: &FailureMap, ip: Option<IpAddr>) {
    let Some(ip) = ip else { return };
    map.lock().unwrap().remove(&ip);
}

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
    let failures: FailureMap = Arc::new(Mutex::new(HashMap::new()));

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
                            let peer_ip = Some(addr.ip());
                            // Refuse connections from currently-locked-out
                            // IPs before allocating any Noise / WS state.
                            if is_locked_out(&failures, peer_ip) {
                                drop(stream);
                                continue;
                            }
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
                                failures: failures.clone(),
                                peer_ip,
                            };
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
    failures: FailureMap,
    peer_ip: Option<IpAddr>,
}

async fn handle_client(
    stream: tokio::net::TcpStream,
    ctx: ClientCtx,
) -> anyhow::Result<()> {
    let ClientCtx {
        password, workspace_name, workspace_icon, root_paths, db, event_tx,
        clients, app, context_id, failures, peer_ip,
    } = ctx;
    use tauri::Emitter;

    let ws = tokio_tungstenite::accept_async(stream).await?;
    let (mut sink, mut source) = ws.split();

    // ── Noise NNpsk0 handshake (responder side) ──────────────────────────────
    //
    // 1. Receive e (initiator's ephemeral pubkey, AEAD-tagged via PSK)
    // 2. Send    e, ee (our ephemeral pubkey + DH product)
    // 3. Transition to transport mode — all subsequent frames are encrypted.
    //
    // Any error here (malformed frame, wrong PSK, decrypt failure) is treated
    // as a handshake failure: bump the per-IP counter and drop the connection
    // silently. An attacker probing passwords sees only "connection closed"
    // with no signal about WHY — they can't distinguish "wrong PSK" from
    // "network glitch" from "host overloaded".
    let psk = derive_psk(&password);
    let mut handshake = match snow::Builder::new(noise_params())
        .psk(0, &psk)
        .build_responder()
    {
        Ok(h) => h,
        Err(_) => {
            // Don't penalize a builder failure to the peer — this is our bug,
            // not theirs. But the connection still drops.
            return Ok(());
        }
    };

    // Step 1: read the initiator's first message.
    let msg1 = match source.next().await {
        Some(Ok(Message::Binary(b))) => b,
        _ => {
            // Initiator didn't send a Binary frame as expected. Could be a
            // probe by something speaking plain WS or HTTP. Don't count as a
            // password attempt — they didn't even try.
            return Ok(());
        }
    };
    let mut buf = vec![0u8; 65535];
    if handshake.read_message(&msg1, &mut buf).is_err() {
        record_failure(&failures, peer_ip);
        return Ok(());
    }

    // Step 2: write our response.
    let mut send_buf = vec![0u8; 65535];
    let n = match handshake.write_message(&[], &mut send_buf) {
        Ok(n) => n,
        Err(_) => return Ok(()),
    };
    if sink.send(Message::Binary(send_buf[..n].to_vec())).await.is_err() {
        return Ok(());
    }

    // Step 3: transition to transport mode.
    let mut transport = match handshake.into_transport_mode() {
        Ok(t) => t,
        Err(_) => return Ok(()),
    };

    // Handshake succeeded — clear any prior failures from this IP.
    clear_failures(&failures, peer_ip);

    let mut reader = ChunkReader::new();

    // ── First encrypted message must be GuestMsg::Auth { display_name } ────
    let display_name = match recv_one(&mut source, &mut transport, &mut reader).await {
        Ok(Some(bytes)) => match serde_json::from_slice::<GuestMsg>(&bytes) {
            Ok(GuestMsg::Auth { display_name }) => display_name,
            // Anything else as first message is a protocol violation — drop.
            _ => return Ok(()),
        },
        _ => return Ok(()),
    };

    // Send AuthOk (encrypted).
    let ok_msg = HostMsg::AuthOk {
        name: workspace_name.as_ref().clone(),
        icon: workspace_icon.as_ref().clone(),
        root_paths: root_paths.as_ref().clone(),
    };
    if send_encrypted(&mut sink, &mut transport, &ok_msg).await.is_err() {
        return Ok(());
    }

    clients.lock().unwrap().push(display_name.clone());
    let _ = app.emit("sharing://client-joined", serde_json::json!({ "name": display_name }));
    let _ = event_tx.send(HostMsg::ClientJoined { name: display_name.clone() });

    let mut ev_rx = event_tx.subscribe();
    let start = time::Instant::now() + Duration::from_secs(30);
    let mut heartbeat = time::interval_at(start, Duration::from_secs(30));
    let mut missed_pings: u32 = 0;

    loop {
        tokio::select! {
            msg = source.next() => {
                match msg {
                    Some(Ok(Message::Binary(bytes))) => {
                        // Feed the chunk into the reader. None = partial,
                        // Some(buf) = complete app message ready to parse.
                        match reader.push(&mut transport, &bytes) {
                            Ok(None) => continue,
                            Ok(Some(plaintext)) => {
                                let guest_msg: GuestMsg = match serde_json::from_slice(&plaintext) {
                                    Ok(m) => m,
                                    Err(_) => continue,
                                };
                                let rp = root_paths.clone();
                                let db2 = db.clone();
                                let response = handle_cmd(guest_msg, rp, db2, context_id).await;
                                if send_encrypted(&mut sink, &mut transport, &response).await.is_err() {
                                    break;
                                }
                            }
                            Err(_) => break, // decrypt failure — drop connection
                        }
                    }
                    Some(Ok(Message::Pong(_))) => { missed_pings = 0; }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
            Ok(ev) = ev_rx.recv() => {
                if send_encrypted(&mut sink, &mut transport, &ev).await.is_err() {
                    break;
                }
            }
            _ = heartbeat.tick() => {
                if missed_pings >= 2 { break; }
                missed_pings += 1;
                if sink.send(Message::Ping(vec![])).await.is_err() { break; }
            }
        }
    }

    clients.lock().unwrap().retain(|n| n != &display_name);
    let _ = event_tx.send(HostMsg::ClientLeft { name: display_name.clone() });
    let _ = app.emit("sharing://client-left", serde_json::json!({ "name": display_name }));

    Ok(())
}

/// Wait for the next fully-reassembled encrypted message on `source`, feeding
/// chunks into `reader` as they arrive. Returns `Ok(Some(bytes))` on a
/// complete message, `Ok(None)` if the stream ended cleanly, `Err` on
/// decrypt / framing failure.
async fn recv_one<S>(
    source: &mut S,
    transport: &mut snow::TransportState,
    reader: &mut ChunkReader,
) -> Result<Option<Vec<u8>>, ()>
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    use futures_util::StreamExt;
    loop {
        match source.next().await {
            Some(Ok(Message::Binary(b))) => match reader.push(transport, &b) {
                Ok(None) => continue,
                Ok(Some(out)) => return Ok(Some(out)),
                Err(_) => return Err(()),
            },
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            Some(Ok(_)) => return Err(()), // unexpected text/close
            Some(Err(_)) | None => return Ok(None),
        }
    }
}

/// Serialize, encrypt-and-chunk, and send `msg` on `sink`. All chunks of a
/// single message must be sent together so the receiver's ChunkReader sees
/// them in order — caller owns the `sink` mutex / exclusive access for the
/// duration of this call.
async fn send_encrypted<S, M>(
    sink: &mut S,
    transport: &mut snow::TransportState,
    msg: &M,
) -> Result<(), ()>
where
    S: futures_util::Sink<Message> + Unpin,
    M: serde::Serialize,
{
    use futures_util::SinkExt;
    let plaintext = match serde_json::to_vec(msg) {
        Ok(v) => v,
        Err(_) => return Err(()),
    };
    let frames = match encrypt_chunks(transport, &plaintext) {
        Ok(f) => f,
        Err(_) => return Err(()),
    };
    for frame in frames {
        if sink.send(frame).await.is_err() {
            return Err(());
        }
    }
    Ok(())
}

fn path_allowed(path: &str, roots: &[String]) -> bool {
    // Vaults are NEVER shared, in V1. Every guest-facing handler (list, read,
    // write, delete, rename, create) funnels through this one predicate, so a
    // single check here closes all of them at once.
    //
    // Why not share them: the guest would receive either opaque blobs it cannot
    // decrypt (useless) or decrypted plaintext over the wire (a second copy of
    // the user's most sensitive data, on a peer's disk, outside the vault's
    // protection). Neither is something to ship by accident. See CLAUDE.md §43.
    if crate::vault::format::path_is_in_vault(std::path::Path::new(path)) {
        return false;
    }
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
                    size: 0, created_at: 0, modified_at, extension: String::new(),
                    id: None, tags: vec![], is_vault: false,
                })
            } else {
                let extension = std::path::Path::new(&entry_path)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_string();
                Some(ListEntry {
                    is_dir: false, name, path: entry_path,
                    size: meta.len() as i64, created_at: 0, modified_at, extension,
                    id: None, tags: vec![], is_vault: false,
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
