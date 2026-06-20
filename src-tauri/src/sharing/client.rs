use std::collections::HashMap;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

use super::crypto::{derive_psk, noise_params};
use super::frame::{encrypt_chunks, ChunkReader};
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

    // ── Noise NNpsk0 handshake (initiator side) ──────────────────────────────
    //
    // 1. Send e (our ephemeral pubkey, AEAD-tagged with the PSK derived
    //    from the password).
    // 2. Recv  e, ee (responder's ephemeral + DH product).
    // 3. Transition to transport — all subsequent app messages encrypted.
    //
    // Wrong password → step 2 fails to decrypt → we surface a clear error
    // for the UI ("Wrong password or host is unreachable"). We can't tell
    // the two apart from the client side (an attacker MITM-ing also fails
    // step 2), so we present them identically.
    let psk = derive_psk(&password);
    let mut handshake = snow::Builder::new(noise_params())
        .psk(0, &psk)
        .build_initiator()
        .map_err(|e| format!("Noise init failed: {}", e))?;

    // Step 1: write the initiator's first message.
    let mut send_buf = vec![0u8; 65535];
    let n = handshake
        .write_message(&[], &mut send_buf)
        .map_err(|e| format!("Noise write failed: {}", e))?;
    sink.send(Message::Binary(send_buf[..n].to_vec()))
        .await
        .map_err(|e| format!("Could not send handshake: {}", e))?;

    // Step 2: read the responder's reply (with a 10 s timeout — a host that
    // never replies is either offline or rejecting our handshake silently).
    let reply = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        source.next(),
    )
    .await
    .map_err(|_| "Timed out waiting for host handshake".to_string())?;

    let msg2 = match reply {
        Some(Ok(Message::Binary(b))) => b,
        Some(Ok(Message::Close(_))) | None => {
            return Err("Wrong password or host is unreachable".to_string());
        }
        _ => return Err("Unexpected handshake frame from host".to_string()),
    };
    let mut buf = vec![0u8; 65535];
    handshake
        .read_message(&msg2, &mut buf)
        .map_err(|_| "Wrong password or host is unreachable".to_string())?;

    // Step 3: transition.
    let mut transport = handshake
        .into_transport_mode()
        .map_err(|e| format!("Noise transport init failed: {}", e))?;

    let mut reader = ChunkReader::new();

    // ── Send first encrypted message: GuestMsg::Auth { display_name } ──────
    let auth = GuestMsg::Auth { display_name };
    send_encrypted(&mut sink, &mut transport, &auth)
        .await
        .map_err(|_| "Could not send auth message".to_string())?;

    // ── Wait for AuthOk (encrypted) ─────────────────────────────────────────
    let auth_result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        recv_one(&mut source, &mut transport, &mut reader),
    )
    .await
    .map_err(|_| "Timed out waiting for auth response".to_string())?;

    let (workspace_name, workspace_icon, root_paths) = match auth_result {
        Ok(Some(bytes)) => match serde_json::from_slice::<HostMsg>(&bytes)
            .map_err(|e| e.to_string())?
        {
            HostMsg::AuthOk { name, icon, root_paths } => (name, icon, root_paths),
            _ => return Err("Unexpected message from host".to_string()),
        },
        Ok(None) => return Err("Connection closed before auth response".to_string()),
        Err(()) => return Err("Decryption failed".to_string()),
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
                            if send_encrypted(&mut sink, &mut transport, &msg).await.is_err() {
                                let _ = reply.send(Err("Connection lost".to_string()));
                                break;
                            }
                            if id != 0 {
                                pending.insert(id, reply);
                            }
                        }
                        None => break,
                    }
                }

                msg = source.next() => {
                    match msg {
                        Some(Ok(Message::Binary(bytes))) => {
                            match reader.push(&mut transport, &bytes) {
                                Ok(None) => continue,
                                Ok(Some(plaintext)) => {
                                    if let Ok(host_msg) = serde_json::from_slice::<HostMsg>(&plaintext) {
                                        match host_msg {
                                            HostMsg::Response { id, ok, payload } => {
                                                if let Some(tx) = pending.remove(&id) {
                                                    let result = if ok {
                                                        Ok(payload)
                                                    } else {
                                                        Err(
                                                            payload
                                                                .as_str()
                                                                .map(ToString::to_string)
                                                                .unwrap_or_else(|| payload.to_string())
                                                        )
                                                    };
                                                    let _ = tx.send(result);
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
                                Err(_) => break, // decrypt failure
                            }
                        }

                        Some(Ok(Message::Ping(data))) => {
                            if sink.send(Message::Pong(data)).await.is_err() { break; }
                        }

                        Some(Ok(Message::Close(_))) => break,
                        Some(Err(_)) => break,
                        None => break,

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

/// Wait for the next fully-reassembled encrypted message on `source`. Mirror
/// of the same helper in server.rs — kept here as a private fn so both files
/// can stay self-contained.
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
            Some(Ok(_)) => return Err(()),
            Some(Err(_)) | None => return Ok(None),
        }
    }
}

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
    let plaintext = serde_json::to_vec(msg).map_err(|_| ())?;
    let frames = encrypt_chunks(transport, &plaintext).map_err(|_| ())?;
    for frame in frames {
        sink.send(frame).await.map_err(|_| ())?;
    }
    Ok(())
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
